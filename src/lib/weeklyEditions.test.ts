import { describe, it, expect } from 'vitest'
import { listEditions, editionEpisodeIds } from './weeklyEditions'
import { isoWeekKey, isoWeekRange, weekRangeLabel } from './format'
import type { Episode, Highlight, Idea, Podcast, Summary } from './types'

// Editions are the history layer: ready episodes bucketed by ISO week, newest first.
// All deterministic — these tests pin the bucketing, ordering, and card previews.

function pod(id: string, title: string): Podcast {
  return {
    id, title, author: 'a', category: 'Business', description: '', cadence: 'Weekly',
    episodeCount: 1, source: 'podcast', color: '#000', monogram: 'X', tracked: true,
  }
}
function hl(id: string, title: string): Highlight {
  return { id, title, timestamp: '—', detail: `${title} detail`, key: true }
}
function sum(over: Partial<Summary>): Summary {
  return { synthesis: [], highlights: [], qa: [], ...over }
}
function ep(id: string, podcastId: string, publishedAt: string, summary: Summary | undefined, status: Episode['status'] = 'ready'): Episode {
  return {
    id, podcastId, title: id, publishedAt, durationSec: 100, status, signal: 'normal',
    blurb: '', entities: { people: [], companies: [], themes: [] }, summary,
  }
}
const idea = (over: Partial<Idea> = {}): Idea => ({ idea: 'Long NVDA', proponent: 'Sacks', thesis: ['real demand'], ...over })

const podcasts = new Map([
  ['allin', pod('allin', 'All-In')],
  ['oddlots', pod('oddlots', 'Odd Lots')],
  ['acquired', pod('acquired', 'Acquired')],
])
const podcastById = (id: string) => podcasts.get(id)

describe('isoWeek helpers', () => {
  it('keys dates into Monday–Sunday ISO weeks', () => {
    expect(isoWeekKey('2026-06-01')).toBe('2026-W23') // Monday
    expect(isoWeekKey('2026-06-07')).toBe('2026-W23') // Sunday, same week
    expect(isoWeekKey('2026-06-08')).toBe('2026-W24') // next Monday
    expect(isoWeekKey('2026-05-30')).toBe('2026-W22')
    expect(isoWeekKey('2026-05-24')).toBe('2026-W21') // Sunday of the prior week
  })

  it('labels the canonical week range', () => {
    const a = isoWeekRange('2026-06-03')
    expect(weekRangeLabel(a.start, a.end)).toBe('Jun 1 – 7, 2026')
    const b = isoWeekRange('2026-06-30') // week spans into July
    expect(weekRangeLabel(b.start, b.end)).toBe('Jun 29 – Jul 5, 2026')
  })
})

describe('listEditions', () => {
  const episodes = [
    ep('e-allin', 'allin', '2026-06-01', sum({ highlights: [hl('h1', 'AI capex debate')], ideas: [idea(), idea({ idea: 'Fade levered AI' })] })),
    ep('e-oddlots', 'oddlots', '2026-06-04', sum({ highlights: [hl('h2', 'Power is the bottleneck')] })),
    ep('e-acquired', 'acquired', '2026-05-30', sum({ highlights: [hl('h3', 'TSMC concentration risk')] })),
    ep('e-pending', 'allin', '2026-06-02', undefined, 'summarizing'), // excluded: not ready
  ]

  it('buckets ready episodes into per-week editions, newest week first', () => {
    const editions = listEditions(episodes, podcastById)
    expect(editions.map((e) => e.weekKey)).toEqual(['2026-W23', '2026-W22'])

    const [w23, w22] = editions
    expect(w23.rangeLabel).toBe('Jun 1 – 7, 2026')
    expect(w23.episodeCount).toBe(2)
    expect(w23.episodeIds).toEqual(expect.arrayContaining(['e-allin', 'e-oddlots']))
    expect(w23.ideaCount).toBe(2) // summed across the week
    expect(w23.shows).toEqual(expect.arrayContaining(['All-In', 'Odd Lots']))

    expect(w22.episodeCount).toBe(1)
    expect(w22.ideaCount).toBe(0)
  })

  it('derives a concrete headline (first pitched idea, else a key highlight)', () => {
    const [w23, w22] = listEditions(episodes, podcastById)
    expect(w23.headline).toBe('Long NVDA — Sacks') // first idea wins
    expect(w22.headline).toBe('TSMC concentration risk') // no ideas → key highlight
  })

  it('excludes non-ready episodes entirely', () => {
    const editions = listEditions(episodes, podcastById)
    const allIds = editions.flatMap((e) => e.episodeIds)
    expect(allIds).not.toContain('e-pending')
  })

  it('editionEpisodeIds returns just that week’s ready episodes', () => {
    expect(editionEpisodeIds(episodes, '2026-W23').sort()).toEqual(['e-allin', 'e-oddlots'])
    expect(editionEpisodeIds(episodes, '2026-W22')).toEqual(['e-acquired'])
  })
})
