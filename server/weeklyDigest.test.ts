import { describe, it, expect, vi } from 'vitest'
import type { Episode, Summary } from '../src/lib/types'
import { checkCronAuth, pickBackfillTargets, pickPendingThisWeek, processPendingBatch, readyThisWeek, runWeeklyDigest } from './weeklyDigest'
import type { Subscriber, SubscriberStore } from './subscriberStore'

// The Monday digest job. The send transport and the data sources are injected, so
// these tests exercise the real assemble-and-send orchestration without the wire.

const NOW = Date.parse('2026-06-15T12:00:00Z') // a Monday
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function sum(over: Partial<Summary> = {}): Summary {
  return {
    synthesis: ['A concrete synthesis of the week.'],
    highlights: [{ id: 'h1', title: 'Key point', timestamp: '—', detail: 'why it matters', key: true }],
    qa: [{ q: 'Is it a bubble?', a: 'No' }],
    ...over,
  }
}

function ep(id: string, podcastId: string, publishedAt: string, status: Episode['status'] = 'ready'): Episode {
  return {
    id,
    podcastId,
    title: `Episode ${id}`,
    publishedAt,
    durationSec: 1000,
    status,
    signal: 'normal',
    blurb: 'blurb',
    entities: { people: ['Sam Altman'], companies: ['OpenAI'], themes: [] },
    summary: status === 'ready' ? sum() : undefined,
  }
}

// A detected (not-yet-summarised) episode WITH source material — a valid backfill
// candidate (pickBackfillTargets skips items with no notes/transcript/audio).
const pending = (id: string, podcastId: string, publishedAt: string): Episode => ({
  ...ep(id, podcastId, publishedAt, 'detected'),
  notes: 'Real show notes with enough material to summarise from.',
})

const memSubscriberStore = (list: Subscriber[] | null): SubscriberStore => ({
  get: async () => list,
  put: async () => {},
})

const subs = (...emails: string[]): Subscriber[] => emails.map((email) => ({ email, addedAt: 'x' }))

describe('checkCronAuth', () => {
  it('fails closed without a secret, and matches a correct bearer token', () => {
    expect(checkCronAuth('Bearer abc', undefined)).toBe(false) // no secret configured
    expect(checkCronAuth('Bearer abc', 'abc')).toBe(true)
    expect(checkCronAuth('bearer abc', 'abc')).toBe(true) // scheme is case-insensitive
    expect(checkCronAuth('Bearer wrong', 'abc')).toBe(false)
    expect(checkCronAuth(null, 'abc')).toBe(false)
    expect(checkCronAuth('abc', 'abc')).toBe(false) // missing scheme
  })
})

describe('readyThisWeek', () => {
  it('keeps only summarised episodes published within the last 7 days', () => {
    const eps = [
      ep('fresh', 'allin', daysAgo(2)),
      ep('old', 'allin', daysAgo(30)),
      ep('pending', 'oddlots', daysAgo(1), 'transcribing'),
    ]
    expect(readyThisWeek(eps, NOW).map((e) => e.id)).toEqual(['fresh'])
  })
})

describe('pickBackfillTargets', () => {
  it('picks one recent, summarisable pending episode per UNCOVERED channel', () => {
    const eps = [
      ep('allin-ready', 'allin', daysAgo(1)), // allin already covered this week → skip the channel
      pending('allin-older', 'allin', daysAgo(2)), // (same channel, ignored)
      pending('odd-new', 'oddlots', daysAgo(1)), // oddlots uncovered → pick the NEWEST pending
      pending('odd-old', 'oddlots', daysAgo(4)),
      pending('stale', 'bg2', daysAgo(20)), // out of the 7-day window → skip
      ep('bare', 'acquired', daysAgo(1), 'detected'), // no notes/transcript/audio → nothing to summarise → skip
    ]
    expect(pickBackfillTargets(eps, NOW).map((e) => e.id)).toEqual(['odd-new'])
  })
})

describe('runWeeklyDigest', () => {
  it('backfills uncovered channels before sending so the brief is never empty', async () => {
    const sendEmail = vi.fn(async (_msg: { email: string; subject: string; html: string }) => ({ ok: true, message: 'sent' }))
    const processEpisode = vi.fn(async (e: Episode) => sum({ synthesis: [`processed ${e.id}`] }))
    const res = await runWeeklyDigest({
      getEpisodes: async () => [pending('fresh', 'allin', daysAgo(1))], // nothing ready yet this week
      subscriberStore: memSubscriberStore(subs('a@muns.io')),
      sendEmail,
      processEpisode,
      now: NOW,
    })
    expect(processEpisode).toHaveBeenCalledTimes(1)
    expect(processEpisode.mock.calls[0][0].id).toBe('fresh')
    expect(res.body).toMatchObject({ ok: true, sent: 1, backfilled: 1, episodeCount: 1 })
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('is best-effort per channel: one failed processing never blocks the send', async () => {
    const sendEmail = vi.fn(async (_msg: { email: string; subject: string; html: string }) => ({ ok: true, message: 'sent' }))
    const processEpisode = vi.fn(async (e: Episode) => {
      if (e.podcastId === 'oddlots') throw new Error('provider down')
      return sum({ synthesis: [`processed ${e.id}`] })
    })
    const res = await runWeeklyDigest({
      getEpisodes: async () => [pending('a', 'allin', daysAgo(1)), pending('o', 'oddlots', daysAgo(1))],
      subscriberStore: memSubscriberStore(subs('a@muns.io')),
      sendEmail,
      processEpisode,
      now: NOW,
    })
    expect(processEpisode).toHaveBeenCalledTimes(2)
    expect(res.body).toMatchObject({ ok: true, sent: 1, backfilled: 1, episodeCount: 1 })
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not backfill channels already covered this week', async () => {
    const sendEmail = vi.fn(async (_msg: { email: string; subject: string; html: string }) => ({ ok: true, message: 'sent' }))
    const processEpisode = vi.fn(async (e: Episode) => sum({ synthesis: [`processed ${e.id}`] }))
    const res = await runWeeklyDigest({
      getEpisodes: async () => [ep('ready', 'allin', daysAgo(1))], // already summarised → no work needed
      subscriberStore: memSubscriberStore(subs('a@muns.io')),
      sendEmail,
      processEpisode,
      now: NOW,
    })
    expect(processEpisode).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ ok: true, sent: 1, backfilled: 0, episodeCount: 1 })
  })

  it('skips (sends nothing) when no episodes are ready this week', async () => {
    const sendEmail = vi.fn()
    const res = await runWeeklyDigest({
      getEpisodes: async () => [ep('old', 'allin', daysAgo(40))],
      subscriberStore: memSubscriberStore(subs('a@muns.io')),
      sendEmail,
      now: NOW,
    })
    expect(res.body).toMatchObject({ sent: 0, skipped: 'no_ready_episodes' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('skips when there are episodes but no subscribers', async () => {
    const sendEmail = vi.fn()
    const res = await runWeeklyDigest({
      getEpisodes: async () => [ep('fresh', 'allin', daysAgo(1))],
      subscriberStore: memSubscriberStore([]),
      sendEmail,
      now: NOW,
    })
    expect(res.body).toMatchObject({ sent: 0, skipped: 'no_subscribers' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('mails the shared edition to every subscriber', async () => {
    const sendEmail = vi.fn(async (_msg: { email: string; subject: string; html: string }) => ({ ok: true, message: 'sent' }))
    const res = await runWeeklyDigest({
      getEpisodes: async () => [ep('e1', 'allin', daysAgo(1)), ep('e2', 'oddlots', daysAgo(3))],
      subscriberStore: memSubscriberStore(subs('a@muns.io', 'b@muns.io')),
      sendEmail,
      now: NOW,
    })
    expect(res.body).toMatchObject({ ok: true, sent: 2, failed: 0, recipients: 2, episodeCount: 2 })
    expect((res.body as { rangeLabel?: string }).rangeLabel).toBeTruthy()
    expect(sendEmail).toHaveBeenCalledTimes(2)
    // Every subscriber gets the SAME edition (same subject + html).
    const calls = sendEmail.mock.calls
    expect(calls[0][0].email).toBe('a@muns.io')
    expect(calls[1][0].email).toBe('b@muns.io')
    expect(calls[0][0].subject).toBe(calls[1][0].subject)
    expect(calls[0][0].html).toBe(calls[1][0].html)
    expect(calls[0][0].subject).toContain('Munshot AI Podcasts')
    expect(calls[0][0].html).toContain('Weekly Summary')
  })

  it('counts failed sends without throwing, and reports ok:false', async () => {
    const sendEmail = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, message: 'sent' })
      .mockResolvedValueOnce({ ok: false, message: 'rejected' })
    const res = await runWeeklyDigest({
      getEpisodes: async () => [ep('e1', 'allin', daysAgo(1))],
      subscriberStore: memSubscriberStore(subs('a@muns.io', 'b@muns.io')),
      sendEmail,
      now: NOW,
    })
    expect(res.body).toMatchObject({ ok: false, sent: 1, failed: 1, recipients: 2 })
  })
})

describe('pickPendingThisWeek — the auto-processor target set', () => {
  it('returns ALL in-window pending episodes (NOT one-per-channel like backfill)', () => {
    const eps = [
      pending('a1', 'allin', daysAgo(1)),
      pending('a2', 'allin', daysAgo(2)), // same channel — backfill caps to one; auto-processor keeps both
      pending('o1', 'oddlots', daysAgo(3)),
      pending('old', 'allin', daysAgo(20)), // out of window → excluded
    ]
    const ids = pickPendingThisWeek(eps, NOW).map((e) => e.id)
    expect(ids.sort()).toEqual(['a1', 'a2', 'o1'])
    // contrast: the one-per-channel backfill takes only ONE 'allin' episode
    expect(pickBackfillTargets(eps, NOW).filter((e) => e.podcastId === 'allin')).toHaveLength(1)
  })
  it('excludes already-ready and source-less episodes', () => {
    const eps = [ep('r1', 'allin', daysAgo(1)), ep('x', 'oddlots', daysAgo(1), 'detected')] // ready, and detected-without-source
    expect(pickPendingThisWeek(eps, NOW)).toHaveLength(0)
  })
})

describe('processPendingBatch — bounded auto-processing', () => {
  it('processes up to `limit`, leaves the rest, reports counts', async () => {
    const eps = [pending('a1', 'allin', daysAgo(1)), pending('a2', 'allin', daysAgo(2)), pending('o1', 'oddlots', daysAgo(3))]
    const processEpisode = vi.fn(async () => sum())
    const res = await processPendingBatch({ getEpisodes: async () => eps, processEpisode, now: NOW }, { limit: 2 })
    expect(res).toEqual({ processed: 2, remaining: 1 })
    expect(processEpisode).toHaveBeenCalledTimes(2)
  })
  it('no-ops when nothing is pending', async () => {
    const processEpisode = vi.fn(async () => sum())
    const res = await processPendingBatch({ getEpisodes: async () => [ep('r', 'allin', daysAgo(1))], processEpisode, now: NOW })
    expect(res.processed).toBe(0)
    expect(processEpisode).not.toHaveBeenCalled()
  })
  it('no-ops without a processor (no LLM key)', async () => {
    const res = await processPendingBatch({ getEpisodes: async () => [pending('a', 'allin', daysAgo(1))], now: NOW })
    expect(res.processed).toBe(0)
  })
  it('respects the wall-clock budget before the first episode', async () => {
    const processEpisode = vi.fn(async () => sum())
    const res = await processPendingBatch({ getEpisodes: async () => [pending('a', 'allin', daysAgo(1))], processEpisode, now: NOW }, { budgetMs: -1 })
    expect(res.processed).toBe(0)
    expect(processEpisode).not.toHaveBeenCalled()
  })
})
