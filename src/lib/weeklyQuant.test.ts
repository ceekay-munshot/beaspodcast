import { describe, it, expect } from 'vitest'
import { groupQuantByEpisode } from './weeklyQuant'
import type { QuantPoint, WeeklyCitation } from './types'

const cites: WeeklyCitation[] = [
  { index: 1, episodeId: 'ep-holcim', label: 'Acquired — Holcim' },
  { index: 2, episodeId: 'ep-gme', label: 'All-In — GameStop' },
]
const q = (metric: string, value: string, context: string): QuantPoint => ({ metric, value, context })

describe('groupQuantByEpisode', () => {
  it('groups rows under the episode each [n] cites, in citation order', () => {
    const groups = groupQuantByEpisode(
      [
        q('GameStop Q1 revenue', '$835M', 'first quarter [2]'),
        q('Concrete consumed globally', '30B tons', 'per CEO [1]'),
        q('GameStop cash', '$9.7B', 'current balance [2]'),
      ],
      cites,
    )
    expect(groups.map((g) => g.label)).toEqual(['Acquired — Holcim', 'All-In — GameStop'])
    expect(groups[0].episodeId).toBe('ep-holcim')
    expect(groups[1].rows.map((r) => r.metric)).toEqual(['GameStop Q1 revenue', 'GameStop cash'])
  })

  it('strips the citation marker from the cells (the heading attributes them)', () => {
    const [g] = groupQuantByEpisode([q('Eco sales', 'one third', 'after five years [1]')], cites)
    expect(g.rows[0].context).toBe('after five years')
    expect(g.label).toBe('Acquired — Holcim')
  })

  it('puts uncited rows in a trailing "Across sources" group', () => {
    const groups = groupQuantByEpisode([q('Cited', '1', 'x [2]'), q('Uncited', '2', 'no marker')], cites)
    expect(groups[0].label).toBe('All-In — GameStop')
    expect(groups[groups.length - 1].label).toBe('Across sources')
    expect(groups[groups.length - 1].episodeId).toBeUndefined()
  })

  it('falls back to one header-less group when nothing is cited (flat table)', () => {
    const groups = groupQuantByEpisode([q('A', '1', 'no cite'), q('B', '2', 'also none')], cites)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('')
    expect(groups[0].rows).toHaveLength(2)
  })

  it('also resolves a marker that lands in the value or metric, not just context', () => {
    const [g] = groupQuantByEpisode([q('Holcim target', 'CHF 200M [1]', 'by 2028')], cites)
    expect(g.label).toBe('Acquired — Holcim')
    expect(g.rows[0].value).toBe('CHF 200M')
  })
})
