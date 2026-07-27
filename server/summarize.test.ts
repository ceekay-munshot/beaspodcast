import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { summarizeEpisode } from './summarize'
import { sharedSummaryKey, type SummaryStore } from './summaryStore'
import type { SummarizeResult } from './summarize'

// The point of the shared store: process an episode ONCE, reuse it for everyone.
// These tests pin that contract — a stored episode is served with no LLM call, a
// fresh one is processed and persisted, and the weekly roundup (no id) is never
// shared. The LLM is mocked, so a `fetch` call === a real (paid) summarization.

// A valid OpenAI forced-function-call response carrying a minimal summary.
function okLLM() {
  const args = JSON.stringify({
    synthesis: ['point'],
    qa: [{ q: 'Q', a: 'A' }],
    insight: { whatChanged: 'shift', whyItMatters: 'consequence', beneficiaries: [{ name: 'ACME', why: 'tailwind' }], atRisk: [], diligenceQuestions: ['check the margin trend'] },
    quantData: [{ metric: 'Revenue', value: '$10M', context: 'vs $6M a year ago' }],
    highlights: [{ title: 'H', timestamp: '—', detail: 'why', key: true }],
    tone: { overall: 'neutral', rationale: 'r', aspects: [{ subject: 'S', sentiment: 'neutral', note: 'n' }] },
  })
  return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] }) }
}

// Build a forced-function-call response from an arbitrary summary args object.
function llmWith(args: Record<string, unknown>) {
  return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }] }) }
}

// An in-memory SummaryStore spy standing in for KV / the filesystem.
function memStore() {
  const map = new Map<string, SummarizeResult>()
  const store: SummaryStore & { map: Map<string, SummarizeResult> } = {
    map,
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    put: vi.fn(async (k: string, v: SummarizeResult) => void map.set(k, v)),
  }
  return store
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('summarizeEpisode — shared store reuse', () => {
  it('serves a stored episode without any LLM call (L1-cold path)', async () => {
    const store = memStore()
    const stored: SummarizeResult = { summary: { synthesis: ['cached'], highlights: [], qa: [] }, transcript: [] }
    // A fresh id never seen by the in-process L1 cache → only the shared store can serve it.
    store.map.set(sharedSummaryKey('live-allin-stored'), stored)

    const result = await summarizeEpisode(
      { id: 'live-allin-stored', title: 'Stored Episode', show: 'All-In', notes: 'some notes' },
      { openaiKey: 'sk-test', store },
    )

    expect(result).toEqual(stored)
    expect(fetchMock).not.toHaveBeenCalled() // no transcription, no LLM — pure reuse
  })

  it('ignores the stored entry and overwrites it when force is set (Refresh)', async () => {
    const store = memStore()
    const stale: SummarizeResult = { summary: { synthesis: ['stale'], highlights: [], qa: [] }, transcript: [] }
    store.map.set(sharedSummaryKey('live-allin-force'), stale)
    fetchMock.mockResolvedValueOnce(okLLM())

    const result = await summarizeEpisode(
      { id: 'live-allin-force', title: 'Forced', show: 'All-In', notes: 'some notes', force: true },
      { openaiKey: 'sk-test', store },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1) // skipped the cache, recomputed
    expect(result).not.toEqual(stale)
    expect(store.put).toHaveBeenCalled() // overwrote the shared entry for everyone
    expect(store.map.get(sharedSummaryKey('live-allin-force'))).toEqual(result)
  })

  it('processes a fresh episode once and persists it for the next user', async () => {
    const store = memStore()
    fetchMock.mockResolvedValueOnce(okLLM())

    const result = await summarizeEpisode(
      { id: 'live-allin-fresh', title: 'Fresh Episode', show: 'All-In', notes: 'some notes' },
      { openaiKey: 'sk-test', store },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1) // exactly one (paid) LLM call
    expect(store.put).toHaveBeenCalledTimes(1)
    expect(store.map.get(sharedSummaryKey('live-allin-fresh'))).toEqual(result) // reusable hereafter
  })

  it('does not touch the store when no id is supplied (an id-less request)', async () => {
    // The weekly roundup now passes a content-derived `weekly:<hash>` id (so it IS
    // shared); this pins the generic contract that an id-less call stays unshared.
    const store = memStore()
    fetchMock.mockResolvedValueOnce(okLLM())

    await summarizeEpisode(
      { title: 'Ad-hoc — unique', show: 'Munshot', notes: 'one-off notes' },
      { openaiKey: 'sk-test', store },
    )

    expect(store.get).not.toHaveBeenCalled()
    expect(store.put).not.toHaveBeenCalled()
  })
})

describe('summarizeEpisode — ideas extraction', () => {
  it('passes through valid pitched ideas and drops malformed ones', async () => {
    const args = JSON.stringify({
      synthesis: ['point'],
      qa: [],
      ideas: [
        { idea: 'Long NVDA', proponent: 'Sacks', thesis: ['power constrained', 'real demand'], kind: 'stock' },
        { idea: '', proponent: 'Nobody', thesis: ['orphaned'] }, // dropped: no headline
        { idea: 'Buy gold', proponent: '  ', thesis: 'not-an-array', kind: 'bogus' }, // proponent→"—", thesis→[], kind dropped
      ],
      highlights: [],
      tone: { overall: 'neutral', rationale: 'r', aspects: [] },
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] }),
    })

    const { summary } = await summarizeEpisode(
      { id: 'live-allin-ideas', title: 'Pitch Episode', show: 'All-In', notes: 'notes' },
      { openaiKey: 'sk-test', store: memStore() },
    )

    expect(summary.ideas).toEqual([
      { idea: 'Long NVDA', proponent: 'Sacks', thesis: ['power constrained', 'real demand'], kind: 'stock' },
      { idea: 'Buy gold', proponent: '—', thesis: [] },
    ])
  })

  it('omits the ideas field entirely when nothing is pitched', async () => {
    fetchMock.mockResolvedValueOnce(llmWith({ synthesis: ['point'], qa: [], highlights: [], tone: { overall: 'neutral', rationale: 'r', aspects: [] } }))
    const { summary } = await summarizeEpisode(
      { id: 'live-allin-noideas', title: 'No Pitch', show: 'All-In', notes: 'notes' },
      { openaiKey: 'sk-test', store: memStore() },
    )
    expect(summary.ideas).toBeUndefined()
  })
})

describe('summarizeEpisode — investable insight + quant extraction', () => {
  it('passes through a valid insight and drops malformed parties / questions', async () => {
    fetchMock.mockResolvedValueOnce(
      llmWith({
        synthesis: ['point'],
        qa: [],
        insight: {
          whatChanged: '  Amazon DSP took share  ',
          whyItMatters: 'Budgets shift to closed-loop measurement',
          beneficiaries: [
            { name: 'Amazon (AMZN)', why: 'closed-loop data advantage' },
            { name: 'NoWhy' }, // dropped: missing why
            { name: '', why: 'orphan' }, // dropped: missing name
          ],
          atRisk: [{ name: 'The Trade Desk (TTD)', why: 'losing OTT budget' }],
          diligenceQuestions: ['Confirm the spend-shift magnitude', '   ', 42],
        },
        highlights: [],
        tone: { overall: 'neutral', rationale: 'r', aspects: [] },
      }),
    )

    const { summary } = await summarizeEpisode(
      { id: 'live-allin-insight', title: 'Insight Episode', show: 'All-In', notes: 'notes' },
      { openaiKey: 'sk-test', store: memStore() },
    )

    expect(summary.insight).toEqual({
      whatChanged: 'Amazon DSP took share',
      whyItMatters: 'Budgets shift to closed-loop measurement',
      beneficiaries: [{ name: 'Amazon (AMZN)', why: 'closed-loop data advantage' }],
      atRisk: [{ name: 'The Trade Desk (TTD)', why: 'losing OTT budget' }],
      diligenceQuestions: ['Confirm the spend-shift magnitude'],
    })
  })

  it('drops the insight when it has neither whatChanged nor whyItMatters', async () => {
    fetchMock.mockResolvedValueOnce(
      llmWith({
        synthesis: ['point'],
        qa: [],
        insight: { whatChanged: '', whyItMatters: '', beneficiaries: [{ name: 'X', why: 'y' }], atRisk: [], diligenceQuestions: [] },
        highlights: [],
        tone: { overall: 'neutral', rationale: 'r', aspects: [] },
      }),
    )
    const { summary } = await summarizeEpisode(
      { id: 'live-allin-emptyinsight', title: 'Empty', show: 'All-In', notes: 'notes' },
      { openaiKey: 'sk-test', store: memStore() },
    )
    expect(summary.insight).toBeUndefined()
  })

  it('coerces a string `synthesis` (no strict mode) into a paragraph array', async () => {
    fetchMock.mockResolvedValueOnce(
      llmWith({
        // The model returned ONE string instead of the schema's array — must not crash the UI.
        synthesis: 'First paragraph about the thesis.\n\nSecond paragraph with the **specifics**.',
        qa: [{ q: 'Q', a: 'A' }, { q: '', a: 'dropped' }],
        highlights: [],
        tone: { overall: 'neutral', rationale: 'r', aspects: [] },
      }),
    )
    const { summary } = await summarizeEpisode(
      { id: 'live-allin-strsyn', title: 'Str', show: 'All-In', notes: 'notes' },
      { openaiKey: 'sk-test', store: memStore() },
    )
    expect(Array.isArray(summary.synthesis)).toBe(true)
    expect(summary.synthesis).toEqual(['First paragraph about the thesis.', 'Second paragraph with the **specifics**.'])
    expect(summary.qa).toEqual([{ q: 'Q', a: 'A' }]) // the malformed pair is dropped
  })

  it('keeps valid quant rows and drops rows missing a metric or value', async () => {
    fetchMock.mockResolvedValueOnce(
      llmWith({
        synthesis: ['point'],
        qa: [],
        quantData: [
          { metric: 'Amazon DSP spend', value: '$50M', context: 'first 5 months of 2026' },
          { metric: '', value: '$1', context: 'x' }, // dropped: no metric
          { metric: 'Bare', value: '', context: '' }, // dropped: no value
          { metric: 'Truckload pricing', value: 'up 20-30%' }, // context → ''
        ],
        highlights: [],
        tone: { overall: 'neutral', rationale: 'r', aspects: [] },
      }),
    )
    const { summary } = await summarizeEpisode(
      { id: 'live-allin-quant', title: 'Quant', show: 'All-In', notes: 'notes' },
      { openaiKey: 'sk-test', store: memStore() },
    )
    expect(summary.quantData).toEqual([
      { metric: 'Amazon DSP spend', value: '$50M', context: 'first 5 months of 2026' },
      { metric: 'Truckload pricing', value: 'up 20-30%', context: '' },
    ])
  })
})
