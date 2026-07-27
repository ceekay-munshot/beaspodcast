import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildShowDigests, generateWeekly, peekWeekly, pendingWeekly } from './weeklyApi'
import type { Episode, Highlight, Idea, Podcast, Summary } from './types'

// buildShowDigests is the deterministic heart of the by-show weekly: it groups the
// week's episodes by show and lifts each show's pitched ideas, key takeaways, and
// open questions straight from the per-episode summaries — no AI, no re-abstraction.

function pod(id: string, title: string): Podcast {
  return {
    id,
    title,
    author: 'author',
    category: 'Business',
    description: '',
    cadence: 'Weekly',
    episodeCount: 1,
    source: 'podcast',
    color: '#000000',
    monogram: 'X',
    tracked: true,
  }
}

function hl(id: string, title: string, key: boolean): Highlight {
  return { id, title, timestamp: '—', detail: `${title} — why it matters`, key }
}

function sum(over: Partial<Summary>): Summary {
  return { synthesis: [], highlights: [], qa: [], ...over }
}

function ep(id: string, podcastId: string, summary: Summary, publishedAt = '2026-06-10'): Episode {
  return {
    id,
    podcastId,
    title: id,
    publishedAt,
    durationSec: 100,
    status: 'ready',
    signal: 'normal',
    blurb: '',
    entities: { people: [], companies: [], themes: [] },
    summary,
  }
}

const idea = (over: Partial<Idea> = {}): Idea => ({ idea: 'Long NVDA', proponent: 'Sacks', thesis: ['real demand'], ...over })

const podcasts = new Map([
  ['allin', pod('allin', 'All-In')],
  ['oddlots', pod('oddlots', 'Odd Lots')],
])
const podcastById = (id: string) => podcasts.get(id)

describe('buildShowDigests', () => {
  it('groups by show and lifts ideas, key takeaways, and questions from each episode', () => {
    const allin = ep(
      'ep-allin',
      'allin',
      sum({
        highlights: [hl('h1', 'Key one', true), hl('h2', 'Key two', true), hl('h3', 'Not key', false)],
        qa: [{ q: 'Is it a bubble?', a: 'No' }, { q: 'What reopens?', a: 'IPOs' }],
        ideas: [idea(), idea({ idea: 'Fade levered names', kind: 'trade' })],
      }),
    )
    const oddlots = ep(
      'ep-oddlots',
      'oddlots',
      sum({ highlights: [hl('h4', 'Power is the bottleneck', true)], qa: [{ q: 'Why not build grid?', a: 'Permitting' }] }),
    )

    const digests = buildShowDigests([oddlots, allin], podcastById)

    // Shows that pitched ideas lead.
    expect(digests.map((d) => d.show)).toEqual(['All-In', 'Odd Lots'])

    const a = digests[0]
    expect(a.podcastId).toBe('allin')
    expect(a.episodeCount).toBe(1)
    expect(a.episodeIds).toEqual(['ep-allin'])
    // Ideas carry an episode backlink; only the two pitched ideas, in order.
    expect(a.ideas).toEqual([
      { ...idea(), episodeId: 'ep-allin' },
      { ...idea({ idea: 'Fade levered names', kind: 'trade' }), episodeId: 'ep-allin' },
    ])
    // Takeaways come from the AI-flagged key highlights (not the non-key one).
    expect(a.takeaways).toEqual([
      { title: 'Key one', detail: 'Key one — why it matters' },
      { title: 'Key two', detail: 'Key two — why it matters' },
    ])
    expect(a.questions).toEqual(['Is it a bubble?', 'What reopens?'])

    const o = digests[1]
    expect(o.ideas).toEqual([])
    expect(o.takeaways).toEqual([{ title: 'Power is the bottleneck', detail: 'Power is the bottleneck — why it matters' }])
  })

  it('merges a show with multiple episodes, dedupes questions, and caps the lists', () => {
    const episodes = [
      ep('e1', 'allin', sum({
        highlights: Array.from({ length: 5 }, (_, i) => hl(`a${i}`, `A takeaway ${i}`, true)),
        qa: [{ q: 'Shared question?', a: '1' }, { q: 'Unique A?', a: '2' }],
        ideas: [idea()],
      }), '2026-06-12'),
      ep('e2', 'allin', sum({
        highlights: Array.from({ length: 5 }, (_, i) => hl(`b${i}`, `B takeaway ${i}`, true)),
        qa: [{ q: 'shared question?', a: 'dupe (case-insensitive)' }, { q: 'Unique B?', a: '3' }],
      }), '2026-06-09'),
    ]

    const [digest] = buildShowDigests(episodes, podcastById)
    expect(digest.episodeCount).toBe(2)
    // Takeaways capped at 6 across the show's 10 key highlights.
    expect(digest.takeaways).toHaveLength(6)
    // Questions deduped case-insensitively and capped at 5.
    expect(digest.questions).toEqual(['Shared question?', 'Unique A?', 'Unique B?'])
  })
})

describe('generateWeekly — shared across users', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts a weekly-mode request with numbered sources + a stable `weekly:` id (so the synthesis is shared, not per-user)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ weekly: { overview: ['overview'], keyThemes: [], quantTable: [], comparison: [], questions: [] } }) })

    // force:true so neither the in-memory nor localStorage L1 can shadow the request.
    await generateWeekly([ep('sh-allin', 'allin', sum({ highlights: [hl('h', 'T', true)] }), '2026-06-01')], podcastById, {
      scope: '2026-W23',
      force: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/summary')
    const body = JSON.parse(init.body as string) as { mode?: string; id?: string; force?: boolean; sources?: unknown[] }
    expect(body.mode).toBe('weekly')
    expect(Array.isArray(body.sources)).toBe(true)
    expect(body.sources).toHaveLength(1) // the numbered per-episode insight payload
    expect(typeof body.id).toBe('string')
    expect(body.id?.startsWith('weekly:')).toBe(true) // → server stores it in the GLOBAL shared cache
    expect(body.force).toBe(true) // Refresh bypasses + overwrites the shared entry
  })

  it('derives the same id for the same episode set (the basis for cross-user reuse)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ weekly: { overview: ['o'], keyThemes: [], quantTable: [], comparison: [], questions: [] } }) })
    const eps = [ep('sh-odd', 'oddlots', sum({ highlights: [hl('h', 'T', true)] }), '2026-06-02')]

    await generateWeekly(eps, podcastById, { scope: '2026-W23', force: true })
    await generateWeekly(eps, podcastById, { scope: '2026-W23', force: true })

    const id1 = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).id
    const id2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).id
    expect(id1).toBe(id2)
  })
})

describe('generateWeekly — saved edition (no reprocess until Refresh)', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ weekly: { overview: ['o'], keyThemes: [], quantTable: [], episodeReadouts: [], questions: [] } }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reuses the saved edition when a new episode appears; only force regenerates', async () => {
    const scope = `save-${Math.random().toString(36).slice(2)}`
    const e1 = ep('s1', 'allin', sum({ highlights: [hl('h1', 'T1', true)] }), '2026-06-01')
    const e2 = ep('s2', 'oddlots', sum({ highlights: [hl('h2', 'T2', true)] }), '2026-06-08')

    const first = await generateWeekly([e1], podcastById, { scope })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first?.sourceEpisodeIds).toEqual(['s1'])

    // A new episode (e2) is now ready — a normal load must NOT reprocess; it returns
    // the SAVED edition (still just s1).
    const reused = await generateWeekly([e1, e2], podcastById, { scope })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reused?.sourceEpisodeIds).toEqual(['s1'])

    // Refresh (force) folds in the new episode.
    const refreshed = await generateWeekly([e1, e2], podcastById, { scope, force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect([...(refreshed?.sourceEpisodeIds ?? [])].sort()).toEqual(['s1', 's2'])
  })

  it('peekWeekly returns the saved edition for a scope without generating', async () => {
    const scope = `peek-${Math.random().toString(36).slice(2)}`
    expect(peekWeekly(scope)).toBeNull()
    await generateWeekly([ep('p1', 'allin', sum({ highlights: [hl('h', 'T', true)] }), '2026-06-01')], podcastById, { scope })
    expect(peekWeekly(scope)?.sourceEpisodeIds).toEqual(['p1'])
    expect(fetchMock).toHaveBeenCalledTimes(1) // peek itself triggered no call
  })
})

describe('generateWeekly — running synthesis survives navigation (in-flight re-attach)', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('de-dupes concurrent calls into ONE run, exposed via pendingWeekly until it resolves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    fetchMock.mockImplementation(async () => {
      await gate // hold the synthesis open so a 2nd caller arrives mid-flight
      return { ok: true, json: async () => ({ weekly: { overview: ['o'], keyThemes: [], quantTable: [], episodeReadouts: [], questions: [] } }) }
    })
    const eps = [ep('if1', 'allin', sum({ highlights: [hl('h', 'T', true)] }), '2026-06-01')]
    const scope = `inflight-${Math.random().toString(36).slice(2)}`

    const p1 = generateWeekly(eps, podcastById, { scope, force: true })
    const p2 = generateWeekly(eps, podcastById, { scope, force: true }) // e.g. the page remounting on return
    expect(pendingWeekly(scope)).not.toBeNull() // a run is in flight and discoverable

    release()
    const [w1, w2] = await Promise.all([p1, p2])
    expect(fetchMock).toHaveBeenCalledTimes(1) // ONE synthesis — the 2nd call re-attached
    expect(w1).toBe(w2) // same result object
    expect(pendingWeekly(scope)).toBeNull() // cleared once it finishes
  })
})
