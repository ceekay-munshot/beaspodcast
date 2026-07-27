import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileSummaryStore } from './summaryStore.node'
import { sharedSummaryKey } from './summaryStore'
import type { SummarizeResult } from './summarize'

// The dev (filesystem) backend of the shared summary store. The prod KV backend
// is exercised against the real binding; here we prove the get/put contract the
// rest of the system relies on: round-trip, miss → null, per-key isolation.

const sample: SummarizeResult = {
  summary: {
    synthesis: ['A specific, episode-grounded point.'],
    highlights: [{ id: 'gen-0', title: 'H', timestamp: '—', detail: 'why', key: true }],
    qa: [{ q: 'Q', a: 'A' }],
    tone: { overall: 'neutral', rationale: 'because', aspects: [{ subject: 'X', sentiment: 'neutral', note: 'n' }] },
  },
  transcript: [{ id: 't0', speaker: 'Speaker 1', role: 'host', timestamp: '0:00', text: 'hello' }],
  transcriptSource: 'feed',
}

describe('fileSummaryStore', () => {
  const made: string[] = []
  async function tmpDir(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-store-'))
    made.push(d)
    return d
  }
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  it('round-trips a stored result by key', async () => {
    const store = fileSummaryStore(await tmpDir())
    const key = sharedSummaryKey('live-allin-abc')
    expect(await store.get(key)).toBeNull() // nothing stored yet
    await store.put(key, sample)
    expect(await store.get(key)).toEqual(sample) // identical after a reload
  })

  it('returns null for a missing key', async () => {
    const store = fileSummaryStore(await tmpDir())
    expect(await store.get(sharedSummaryKey('live-allin-nope'))).toBeNull()
  })

  it('isolates entries (one file per key)', async () => {
    const store = fileSummaryStore(await tmpDir())
    await store.put(sharedSummaryKey('live-allin-a'), sample)
    expect(await store.get(sharedSummaryKey('live-allin-b'))).toBeNull()
    expect(await store.get(sharedSummaryKey('live-allin-a'))).toEqual(sample)
  })
})
