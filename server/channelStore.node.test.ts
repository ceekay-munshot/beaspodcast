import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Podcast } from '../src/lib/types'
import { applyMerge, applyUpsert, handleChannels, sanitizeChannel } from './channelStore'
import { fileChannelStore } from './channelStore.node'

// The durable channel roster: the dev (filesystem) backend plus the pure roster
// operations and the shared /api/channels handler both runtimes delegate to.
// The prod KV backend is exercised against the real binding; the contract that
// matters here is the one data-loss bugs hide behind: a failed READ must never
// let a write clobber the roster, and untracking must only delete user adds.

const SEEDS: ReadonlySet<string> = new Set(['allin', 'bg2'])

function channel(over: Partial<Podcast> = {}): Podcast {
  return {
    id: 'lex',
    title: 'Lex Fridman Podcast',
    author: 'Lex Fridman',
    category: 'Technology',
    description: 'Conversations.',
    cadence: 'Weekly',
    episodeCount: 400,
    source: 'podcast',
    color: '#1d4ed8',
    monogram: 'LF',
    feedUrl: 'https://lexfridman.com/feed/podcast/',
    tracked: true,
    ...over,
  }
}

describe('fileChannelStore', () => {
  const made: string[] = []
  async function tmpFile(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-channels-'))
    made.push(d)
    return path.join(d, 'channels.json')
  }
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  it('reads a missing file as an empty roster (not an error)', async () => {
    expect(await fileChannelStore(await tmpFile()).get()).toEqual([])
  })

  it('round-trips the roster', async () => {
    const store = fileChannelStore(await tmpFile())
    await store.put([channel()])
    expect(await store.get()).toEqual([channel()])
  })

  it('returns null (unknown state) for an unreadable roster, so callers refuse to clobber it', async () => {
    const file = await tmpFile()
    await fs.writeFile(file, '{not json', 'utf8')
    expect(await fileChannelStore(file).get()).toBeNull()

    // The shared handler must turn that into 503, not a destructive write.
    const { status } = await handleChannels(fileChannelStore(file), 'POST', JSON.stringify({ podcast: channel() }), SEEDS)
    expect(status).toBe(503)
    expect(await fs.readFile(file, 'utf8')).toBe('{not json') // untouched
  })
})

describe('roster operations', () => {
  it('sanitizes wire input: requires id+title, caps strings, defaults the rest', () => {
    expect(sanitizeChannel(null)).toBeNull()
    expect(sanitizeChannel({ id: 'x' })).toBeNull() // no title
    const loose = sanitizeChannel({ id: 'x', title: 'X', description: 'd'.repeat(10_000), tracked: 'yes' })
    expect(loose?.description.length).toBe(600)
    expect(loose?.tracked).toBe(true) // anything but false means tracked
    expect(loose?.source).toBe('podcast')
  })

  it('upserts newest-first and replaces by id', () => {
    const one = applyUpsert([], channel(), SEEDS)!
    const two = applyUpsert(one, channel({ id: 'odd', title: 'Odd' }), SEEDS)!
    expect(two.map((p) => p.id)).toEqual(['odd', 'lex'])
    const renamed = applyUpsert(two, channel({ title: 'Lex v2' }), SEEDS)!
    expect(renamed.map((p) => p.id)).toEqual(['lex', 'odd'])
    expect(renamed[0].title).toBe('Lex v2')
  })

  it('untracking deletes a user add but keeps a seed override', () => {
    const list = [channel(), channel({ id: 'allin', title: 'All-In' })]
    const noLex = applyUpsert(list, channel({ tracked: false }), SEEDS)!
    expect(noLex.map((p) => p.id)).toEqual(['allin']) // add forgotten
    const allinOff = applyUpsert(noLex, channel({ id: 'allin', title: 'All-In', tracked: false }), SEEDS)!
    expect(allinOff[0]).toMatchObject({ id: 'allin', tracked: false }) // override kept
  })

  it('merge only adds ids the roster does not have — the server copy wins', () => {
    const existing = [channel({ title: 'Server title' })]
    const { next, added } = applyMerge(existing, [channel({ title: 'Stale local title' }), channel({ id: 'new', title: 'New' })])
    expect(added).toBe(1)
    expect(next.find((p) => p.id === 'lex')?.title).toBe('Server title')
    expect(next.map((p) => p.id)).toEqual(['lex', 'new'])
  })
})

describe('handleChannels (the shared /api/channels endpoint)', () => {
  it('GET degrades to [] without a store; mutations refuse with 503', async () => {
    expect(await handleChannels(null, 'GET', '', SEEDS)).toEqual({ status: 200, body: [] })
    expect((await handleChannels(null, 'POST', '{}', SEEDS)).status).toBe(503)
  })

  it('rejects malformed JSON and invalid podcasts without writing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-channels-'))
    const store = fileChannelStore(path.join(dir, 'channels.json'))
    expect((await handleChannels(store, 'POST', 'not json', SEEDS)).status).toBe(400)
    expect((await handleChannels(store, 'POST', JSON.stringify({ podcast: { id: 'x' } }), SEEDS)).status).toBe(400)
    expect(await store.get()).toEqual([])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('POST then GET round-trips through a real store; PUT merges without clobbering', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-channels-'))
    const store = fileChannelStore(path.join(dir, 'channels.json'))
    await handleChannels(store, 'POST', JSON.stringify({ podcast: channel() }), SEEDS)
    const put = await handleChannels(store, 'PUT', JSON.stringify({ podcasts: [channel(), channel({ id: 'new', title: 'New' })] }), SEEDS)
    expect(put.body).toMatchObject({ ok: true, added: 1 })
    const got = await handleChannels(store, 'GET', '', SEEDS)
    expect((got.body as Podcast[]).map((p) => p.id).sort()).toEqual(['lex', 'new'])
    await fs.rm(dir, { recursive: true, force: true })
  })
})
