import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Episode } from '../src/lib/types'
import type { SummarizeResult } from './summarize'
import { sharedSummaryKey, type SummaryStore } from './summaryStore'
import { applyProcessedUpsert, entryToEpisode, handleProcessed, sanitizeProcessed, type ProcessedEntry } from './processedStore'
import { fileProcessedStore } from './processedStore.node'

// The per-user processed history: the dev (filesystem) backend plus the pure
// operations and the shared /api/processed handler both runtimes delegate to.
// The contracts that matter: a failed READ must never let a write clobber the
// history; mutations require identity; entries stay lean (no summary/transcript
// stored — they re-hydrate from the shared cache); processedAt is server-set.

function wireEpisode(over: Partial<Episode> = {}): Record<string, unknown> {
  return {
    id: 'live-lex-abc123',
    podcastId: 'lex',
    title: 'On intelligence',
    publishedAt: '2026-06-01T00:00:00.000Z',
    durationSec: 5400,
    blurb: 'A conversation about minds.',
    sourceUrl: 'https://lexfridman.com/ep1',
    notes: 'Show notes.',
    audioUrl: 'https://cdn.example.com/ep1.mp3',
    signal: 'high',
    ...over,
  }
}

const SUMMARY = { synthesis: ['A point.'], highlights: [], qa: [] }

/** In-memory fake of the shared summary cache. */
function fakeSummaries(readyIds: string[]): SummaryStore {
  const map = new Map(readyIds.map((id) => [sharedSummaryKey(id), { summary: SUMMARY, transcript: [] } as SummarizeResult]))
  return {
    async get(key) {
      return map.get(key) ?? null
    },
    async put() {},
  }
}

describe('fileProcessedStore', () => {
  const made: string[] = []
  async function tmpFile(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-processed-'))
    made.push(d)
    return path.join(d, 'u-test.json')
  }
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  it('reads a missing file as an empty history (not an error)', async () => {
    expect(await fileProcessedStore(await tmpFile()).get()).toEqual([])
  })

  it('round-trips the history', async () => {
    const store = fileProcessedStore(await tmpFile())
    const entry = sanitizeProcessed(wireEpisode())!
    await store.put([entry])
    expect(await store.get()).toEqual([entry])
  })

  it('returns null (unknown state) for an unreadable history, so mutations refuse to clobber it', async () => {
    const file = await tmpFile()
    await fs.writeFile(file, '{not json', 'utf8')
    expect(await fileProcessedStore(file).get()).toBeNull()

    const { status } = await handleProcessed(fileProcessedStore(file), null, 'POST', JSON.stringify({ episode: wireEpisode() }))
    expect(status).toBe(503)
    expect(await fs.readFile(file, 'utf8')).toBe('{not json') // untouched
  })
})

describe('processed operations', () => {
  it('sanitizes wire input: requires id+podcastId+title, caps strings, server-sets processedAt', () => {
    expect(sanitizeProcessed(null)).toBeNull()
    expect(sanitizeProcessed(wireEpisode({ title: '' }))).toBeNull()
    expect(sanitizeProcessed({ id: 'x', title: 'X' })).toBeNull() // no podcastId

    const before = Date.now()
    const loose = sanitizeProcessed({
      ...wireEpisode(),
      notes: 'n'.repeat(10_000),
      durationSec: -5,
      processedAt: '1999-01-01T00:00:00.000Z', // client-supplied → ignored
    })!
    expect(loose.notes?.length).toBe(2500)
    expect(loose.durationSec).toBe(0)
    expect(+new Date(loose.processedAt)).toBeGreaterThanOrEqual(before)
  })

  it('strips unknown fields — a posted summary/transcript never reaches the stored entry', () => {
    const entry = sanitizeProcessed({ ...wireEpisode(), summary: SUMMARY, transcript: [{ id: 's1' }], status: 'ready' })!
    expect(entry).not.toHaveProperty('summary')
    expect(entry).not.toHaveProperty('transcript')
    expect(entry).not.toHaveProperty('status')
  })

  it('upserts newest-first, dedupes by id, and caps the list', () => {
    const one = applyProcessedUpsert([], wireEpisode())!
    const two = applyProcessedUpsert(one, wireEpisode({ id: 'live-lex-def456', title: 'Second' }))!
    expect(two.map((e) => e.id)).toEqual(['live-lex-def456', 'live-lex-abc123'])
    const replaced = applyProcessedUpsert(two, wireEpisode({ title: 'Retitled' }))!
    expect(replaced.map((e) => e.id)).toEqual(['live-lex-abc123', 'live-lex-def456'])
    expect(replaced[0].title).toBe('Retitled')

    let many: ProcessedEntry[] = []
    for (let i = 0; i < 205; i++) many = applyProcessedUpsert(many, wireEpisode({ id: `live-lex-${i}` }))!
    expect(many.length).toBe(200)
  })

  it('re-hydrates an entry to ready (with summary) on a cache hit, detected on a miss', () => {
    const entry = sanitizeProcessed(wireEpisode())!
    const ready = entryToEpisode(entry, SUMMARY)
    expect(ready.status).toBe('ready')
    expect(ready.summary).toEqual(SUMMARY)
    expect(ready.transcript).toBeUndefined() // transcript stays lazy
    const detected = entryToEpisode(entry, null)
    expect(detected.status).toBe('detected')
    expect(detected.summary).toBeUndefined()
    expect(detected.notes).toBe('Show notes.') // reprocessing inputs intact
    expect(detected.audioUrl).toBe('https://cdn.example.com/ep1.mp3')
  })
})

describe('handleProcessed (the shared /api/processed endpoint)', () => {
  async function freshStore() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-processed-'))
    return { store: fileProcessedStore(path.join(dir, 'u-test.json')), cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
  }

  it('GET degrades to [] without a store (anonymous); POST without a store is 401', async () => {
    expect(await handleProcessed(null, null, 'GET', '')).toEqual({ status: 200, body: [] })
    expect((await handleProcessed(null, null, 'POST', '{}')).status).toBe(401)
  })

  it('rejects malformed JSON and invalid episodes without writing', async () => {
    const { store, cleanup } = await freshStore()
    expect((await handleProcessed(store, null, 'POST', 'not json')).status).toBe(400)
    expect((await handleProcessed(store, null, 'POST', JSON.stringify({ episode: { id: 'x' } }))).status).toBe(400)
    expect(await store.get()).toEqual([])
    await cleanup()
  })

  it('POST then GET round-trips, re-hydrating ready vs detected from the shared cache', async () => {
    const { store, cleanup } = await freshStore()
    await handleProcessed(store, null, 'POST', JSON.stringify({ episode: wireEpisode() }))
    await handleProcessed(store, null, 'POST', JSON.stringify({ episode: wireEpisode({ id: 'live-lex-def456', title: 'Second' }) }))

    const summaries = fakeSummaries(['live-lex-abc123']) // only the first is in the shared cache
    const { status, body } = await handleProcessed(store, summaries, 'GET', '')
    expect(status).toBe(200)
    const episodes = body as Episode[]
    expect(episodes.map((e) => [e.id, e.status])).toEqual([
      ['live-lex-def456', 'detected'],
      ['live-lex-abc123', 'ready'],
    ])
    expect(episodes[1].summary).toEqual(SUMMARY)
    expect(episodes.every((e) => e.transcript === undefined)).toBe(true)
    await cleanup()
  })

  it('rejects other methods', async () => {
    expect((await handleProcessed(null, null, 'DELETE', '')).status).toBe(405)
  })
})
