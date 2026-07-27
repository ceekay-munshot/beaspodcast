import { describe, it, expect } from 'vitest'
import { episodeTone, weeklyTone } from './tone'
import type {
  Episode,
  Summary,
  Takeaway,
  QAItem,
  Highlight,
  TranscriptSegment,
  WeeklySummary,
} from './types'

// ── Minimal fixtures ─────────────────────────────────────────────────────────
// Only the fields the tone roll-up actually reads need to be realistic; the rest
// is filler so the shapes type-check.

function episodeWith(summary: Partial<Summary> | null, transcript?: TranscriptSegment[]): Episode {
  return {
    id: 'e1',
    podcastId: 'p1',
    title: 'T',
    publishedAt: '2026-01-01',
    durationSec: 1800,
    status: 'ready',
    signal: 'normal',
    blurb: '',
    entities: { people: [], companies: [], themes: [] },
    summary: summary === null ? undefined : { synthesis: [], highlights: [], qa: [], ...summary },
    transcript,
  } as Episode
}

const tk = (title: string, detail = ''): Takeaway => ({ title, detail })
const qa = (a: string, q = ''): QAItem => ({ q, a })
const hl = (title: string, detail = ''): Highlight => ({ id: 'h', title, detail, timestamp: '0:00' })
const seg = (text: string): TranscriptSegment => ({ id: 's', speaker: '', role: 'host', timestamp: '0:00', text })

describe('episodeTone — net read', () => {
  it('is neutral when there is no summary', () => {
    expect(episodeTone(episodeWith(null))).toMatchObject({ label: 'neutral', signal: 0 })
  })

  it('reads a positive-heavy episode as positive', () => {
    const t = episodeTone(episodeWith({ synthesis: ['A durable moat and real growth'] }))
    expect(t.label).toBe('positive')
    expect(t).toMatchObject({ posHits: 3, negHits: 0, posRatio: 1 })
    expect(t.score).toBeGreaterThanOrEqual(2)
  })

  it('reads a negative-heavy episode as cautious', () => {
    const t = episodeTone(episodeWith({ synthesis: ['A real bottleneck, rising risk, and a shortage'] }))
    expect(t.label).toBe('cautious')
    expect(t).toMatchObject({ posHits: 0, negHits: 3, posRatio: 0 })
    expect(t.score).toBeLessThanOrEqual(-2)
  })

  it('reads genuine signal on both sides as mixed', () => {
    const t = episodeTone(episodeWith({ synthesis: ['growth and risk'] }))
    expect(t).toMatchObject({ label: 'mixed', posHits: 1, negHits: 1, score: 0, posRatio: 0.5 })
  })

  it('stays mixed even with a slight tilt (no false "positive")', () => {
    const t = episodeTone(episodeWith({ synthesis: ['growth, traction, and one risk'] }))
    expect(t).toMatchObject({ label: 'mixed', posHits: 2, negHits: 1 })
  })

  it('treats a single stray hit as neutral, not a tone', () => {
    const t = episodeTone(episodeWith({ synthesis: ['solid growth'] }))
    expect(t).toMatchObject({ label: 'neutral', signal: 0 })
  })

  it('computes posRatio from the underlying counts', () => {
    const t = episodeTone(
      episodeWith({ synthesis: ['durable moat and steady growth'], highlights: [hl('key risk')] }),
    )
    expect(t).toMatchObject({ label: 'positive', posHits: 3, negHits: 1, posRatio: 0.75 })
  })

  it('aggregates across every summary field (synthesis, highlights, q&a)', () => {
    const t = episodeTone(
      episodeWith({
        synthesis: ['growth'],
        highlights: [hl('moat'), hl('', 'a clear bottleneck')],
        qa: [qa('a real risk')],
      }),
    )
    expect(t).toMatchObject({ posHits: 2, negHits: 2, label: 'mixed' })
  })

  it('reads both the title and detail of a highlight', () => {
    const t = episodeTone(episodeWith({ highlights: [hl('moat', 'risk')] }))
    expect(t).toMatchObject({ posHits: 1, negHits: 1 })
  })

  it('draws from the analysis, never the raw transcript', () => {
    // Positive summary + scary transcript → must read positive (transcript ignored).
    const t = episodeTone(
      episodeWith({ synthesis: ['durable moat and real growth'] }, [seg('bottleneck risk shortage collapse')]),
    )
    expect(t.label).toBe('positive')
    expect(t.negHits).toBe(0)
  })
})

describe('weeklyTone — week-level read', () => {
  function weekWith(over: Partial<WeeklySummary>): WeeklySummary {
    return {
      id: 'w1',
      rangeLabel: '',
      episodeCount: 0,
      readMinutes: 0,
      overview: [],
      topThemes: [],
      interesting: { title: '', quote: '', speaker: '', role: '', episodeId: '' },
      takeaways: [],
      contradictions: [],
      mentions: { people: [], companies: [] },
      questions: [],
      sourceEpisodeIds: [],
      ...over,
    } as WeeklySummary
  }

  it('reads a positive week as positive', () => {
    const t = weeklyTone(weekWith({ overview: ['Record high with a durable moat and real traction'] }))
    expect(t.label).toBe('positive')
    expect(t.score).toBeGreaterThanOrEqual(2)
  })

  it('aggregates across overview, takeaways, contradictions and questions', () => {
    const t = weeklyTone(
      weekWith({
        overview: ['durable moat and real growth'], // 3 pos
        takeaways: [tk('a clear shortage')], // 1 neg
        contradictions: ['a real risk remains'], // 1 neg
        questions: ['what about the bottleneck?'], // 1 neg
      }),
    )
    expect(t).toMatchObject({ posHits: 3, negHits: 3, label: 'mixed', posRatio: 0.5 })
  })
})
