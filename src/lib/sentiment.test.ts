import { describe, it, expect } from 'vitest'
import {
  findSentimentSpans,
  analyzeSentiment,
  sentimentClass,
  sentimentTitle,
  type SentimentSpan,
} from './sentiment'

// ── Helpers ──────────────────────────────────────────────────────────────────
// Flatten spans to plain objects keyed by the matched substring, so assertions
// read like the behavior they lock rather than like offset arithmetic.

function spans(text: string) {
  return findSentimentSpans(text).map((s) => ({
    text: text.slice(s.start, s.end),
    polarity: s.polarity,
    intensity: s.intensity,
    negated: s.negated,
  }))
}

/** Polarity of the span whose text equals `term` (case-insensitive), or undefined. */
function polarityOf(text: string, term: string): SentimentSpan['polarity'] | undefined {
  const hit = findSentimentSpans(text).find(
    (s) => text.slice(s.start, s.end).toLowerCase() === term.toLowerCase(),
  )
  return hit?.polarity
}

describe('findSentimentSpans — base lexicon', () => {
  it('tints clear positive and negative terms', () => {
    expect(polarityOf('The business clearly has a moat', 'moat')).toBe('pos')
    expect(polarityOf('The grid is the real bottleneck', 'bottleneck')).toBe('neg')
  })

  it('fires on the deepened positive vocabulary', () => {
    expect(polarityOf('Revenue growth reaccelerated', 'growth')).toBe('pos')
    expect(polarityOf('A genuine breakthrough in inference', 'breakthrough')).toBe('pos')
    expect(polarityOf('Analysts turned bullish', 'bullish')).toBe('pos')
    expect(polarityOf('Early traction with enterprise buyers', 'traction')).toBe('pos')
  })

  it('fires on the deepened distress / governance vocabulary', () => {
    expect(polarityOf('The company announced layoffs', 'layoffs')).toBe('neg')
    expect(polarityOf('A shareholder lawsuit was filed', 'lawsuit')).toBe('neg')
    expect(polarityOf('Heading toward bankruptcy', 'bankruptcy')).toBe('neg')
  })

  it('leaves neutral text completely untouched (no rainbow)', () => {
    expect(spans('The meeting is scheduled for Tuesday afternoon')).toEqual([])
  })
})

describe('findSentimentSpans — pruned context-flippers stay silent', () => {
  // The whole point of the prune: these read either way depending on context,
  // so they must NOT light up. This is the regression guard for the prune work.
  it.each([
    ['trading at a premium today', 'premium'],
    ['I trust the founding team', 'trust'],
    ['a big win for the quarter', 'win'],
    ['a strong quarter overall', 'strong'],
    ['the hardware is cheap', 'cheap'],
    ['the leading vendor in the space', 'leading'],
    ['it is the default choice', 'default'],
  ])('%s → no span', (text) => {
    expect(spans(text)).toEqual([])
  })

  it('prunes bare "win" but keeps the unambiguous "winning"', () => {
    expect(spans('a big win')).toEqual([])
    expect(polarityOf('a winning streak', 'winning')).toBe('pos')
  })
})

describe('findSentimentSpans — negation', () => {
  it('flips a negated term within the clause window', () => {
    expect(polarityOf('it is not a risk', 'risk')).toBe('pos')
    expect(polarityOf('no problem at all', 'problem')).toBe('pos')
    expect(polarityOf('the hardware is not expensive', 'expensive')).toBe('pos')
    expect(polarityOf('that is hardly a risk', 'risk')).toBe('pos')
  })

  it('flips a positive term too ("not a moat" → negative)', () => {
    expect(polarityOf('that is not a moat', 'moat')).toBe('neg')
  })

  it('marks negated spans so the tooltip can say so', () => {
    const [hit] = findSentimentSpans('it is not a risk')
    expect(hit.negated).toBe(true)
    expect(hit.polarity).toBe('pos')
  })

  it('handles contraction negators', () => {
    expect(polarityOf("that isn't a risk", 'risk')).toBe('pos')
  })

  it('double negation cancels back to the base polarity', () => {
    // not + without → two flips → still negative
    expect(polarityOf('not without risk', 'risk')).toBe('neg')
  })

  it('does NOT flip across a clause boundary (punctuation stops the scan)', () => {
    expect(polarityOf('No. Expensive hardware everywhere', 'Expensive')).toBe('neg')
  })

  it('does NOT flip when the negator is beyond the clause window', () => {
    // negator is 6+ words back — out of the 5-word window, so no flip
    expect(polarityOf('not one two three four five risk', 'risk')).toBe('neg')
    // contrast: same words, negator close enough → flips
    expect(polarityOf('not really much of a risk', 'risk')).toBe('pos')
  })
})

describe('findSentimentSpans — phrases beat their component words', () => {
  it('matches the multi-word phrase as one span, not the inner word', () => {
    const s = spans('margin compression hit the quarter')
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ text: 'margin compression', polarity: 'neg' })
  })

  it('recognises positive phrases whose words are not individually in the lexicon', () => {
    expect(polarityOf('they have real pricing power', 'pricing power')).toBe('pos')
    expect(polarityOf('strong free cash flow', 'free cash flow')).toBe('pos')
  })
})

describe('findSentimentSpans — intensifiers', () => {
  it('promotes intensity to 2 when an intensifier precedes the term', () => {
    expect(spans('massively profitable')[0]).toMatchObject({ polarity: 'pos', intensity: 2 })
    expect(spans('very risky')[0]).toMatchObject({ polarity: 'neg', intensity: 2 })
  })

  it('leaves intensity at 1 without an intensifier', () => {
    expect(spans('profitable')[0].intensity).toBe(1)
  })
})

describe('findSentimentSpans — boundaries & robustness', () => {
  it('respects word boundaries (no matches inside longer words)', () => {
    expect(spans('a brisk walk in the park')).toEqual([]) // not "risk"
    expect(spans('ingrowth of the lawn')).toEqual([]) // not "growth"
  })

  it('ignores empty and sub-3-char input', () => {
    expect(findSentimentSpans('')).toEqual([])
    expect(findSentimentSpans('ok')).toEqual([])
  })

  it('caps the number of spans (no pathological wall of color)', () => {
    const wall = Array.from({ length: 30 }, () => 'risk').join(' ')
    expect(findSentimentSpans(wall)).toHaveLength(14) // MAX_SPANS
  })

  it('is deterministic across repeated calls (no leaked regex state)', () => {
    const text = 'durable moat but real risk'
    expect(findSentimentSpans(text)).toEqual(findSentimentSpans(text))
  })
})

describe('analyzeSentiment — block-level net lean', () => {
  it('reads a clearly positive block as positive & confident', () => {
    const r = analyzeSentiment('The firm has a wide moat, a durable edge, and growing profit')
    expect(r.label).toBe('pos')
    expect(r.score).toBeGreaterThanOrEqual(2)
    expect(r.confident).toBe(true)
  })

  it('reads a clearly negative block as negative', () => {
    const r = analyzeSentiment('A real bottleneck, rising risk, and a binding constraint everywhere')
    expect(r.label).toBe('neg')
    expect(r.score).toBeLessThanOrEqual(-2)
    expect(r.confident).toBe(true)
  })

  it('nets balanced signal to neutral', () => {
    const r = analyzeSentiment('growth and risk in equal measure')
    expect(r.score).toBe(0)
    expect(r.label).toBe('neutral')
    expect(r.posHits).toBe(1)
    expect(r.negHits).toBe(1)
  })

  it('is not confident on a single hit, even in a long sentence', () => {
    const r = analyzeSentiment('This long and rather detailed report mentions one massively risky idea')
    expect(r.label).toBe('neg') // there IS a lean
    expect(r.posHits + r.negHits).toBe(1)
    expect(r.confident).toBe(false) // …but one hit isn't enough
  })

  it('is not confident on a short fragment, even with two hits', () => {
    const r = analyzeSentiment('real moat, clear edge')
    expect(r.posHits).toBe(2)
    expect(r.confident).toBe(false) // too few words
  })

  it('treats neutral text as neutral and not confident', () => {
    const r = analyzeSentiment('The quarterly call is on the calendar for next week')
    expect(r).toMatchObject({ score: 0, label: 'neutral', confident: false })
  })
})

describe('sentimentClass / sentimentTitle', () => {
  const mk = (over: Partial<SentimentSpan>): SentimentSpan => ({
    start: 0,
    end: 1,
    polarity: 'pos',
    intensity: 1,
    negated: false,
    ...over,
  })

  it('maps polarity + intensity to the styling hook', () => {
    expect(sentimentClass(mk({ polarity: 'pos', intensity: 1 }))).toBe('sentiment-pos')
    expect(sentimentClass(mk({ polarity: 'neg', intensity: 1 }))).toBe('sentiment-neg')
    expect(sentimentClass(mk({ polarity: 'pos', intensity: 2 }))).toBe('sentiment-pos sentiment-strong')
  })

  it('annotates the tooltip, noting a negation flip', () => {
    expect(sentimentTitle(mk({ polarity: 'pos' }))).toBe('Positive')
    expect(sentimentTitle(mk({ polarity: 'neg' }))).toBe('Negative')
    expect(sentimentTitle(mk({ polarity: 'pos', negated: true }))).toBe('Positive · negated')
  })
})
