import type { Episode, Podcast, Summary, WeeklySummary } from '../src/lib/types'
import { PODCASTS } from '../src/lib/mock-data'
import { assembleWeekly, buildCitations, buildWeeklySources, hashKey, mergeWeeklyAi } from '../src/lib/weeklyAssemble'
import { weeklyBriefEmailHtml, bytesToBase64, type EmailAttachment } from '../src/lib/email'
import { weeklyReportFilename, weeklyReportTitle } from '../src/lib/reportName'
import { summarizeEpisode, synthesizeWeekly, type SummarizeConfig } from './summarize'
import type { SummaryStore } from './summaryStore'
import type { SubscriberStore } from './subscriberStore'

// ─────────────────────────────────────────────────────────────────────────────
// The Monday weekly-digest job — runtime-agnostic (Vite dev middleware AND the
// Cloudflare Pages Function are thin wrappers). It builds ONE shared edition from
// the curated shows' episodes that are (a) summarised and (b) published in the
// last 7 days, renders it as a designed HTML email, and sends it to every
// subscriber. No browser needed: the digest is assembled entirely server-side
// from the deterministic engine (weeklyAssemble.ts) + the shared summary cache,
// so it never depends on anyone having opened the app this week.
//
// PRE-SEND BACKFILL: before assembling, the job makes sure every subscribed channel
// that published this week is represented. If nobody processed a channel's latest
// episode (so the brief would go out empty or thin), it summarises one episode per
// uncovered channel inline (pickBackfillTargets + makeEpisodeProcessor), writing the
// result to the shared cache so the app reuses it. This is the guarantee that the
// Monday email always carries real, freshly-processed content.
//
// Triggered over HTTP by a scheduled GitHub Actions workflow (Cloudflare Pages
// can't run cron itself), guarded by a shared CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Constant-time-ish bearer check against the configured secret. No secret
 *  configured → always unauthorized (fail closed), so a misconfig can't open it. */
export function checkCronAuth(authHeader: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return false
  const m = /^Bearer\s+(.+)$/i.exec((authHeader ?? '').trim())
  return !!m && m[1] === secret
}

/** Episodes that belong in THIS week's edition: ready (summarised) and published
 *  within the last 7 days of `now`. */
export function readyThisWeek(episodes: Episode[], now: number): Episode[] {
  const cutoff = now - WEEK_MS
  return episodes.filter((e) => e.status === 'ready' && e.summary && +new Date(e.publishedAt) >= cutoff)
}

/** Pre-send backfill targets: ONE episode per channel that has no ready episode in
 *  this week's window yet but DOES have a recent, summarisable one waiting. Picks
 *  the most recent pending episode per show, so every channel that published this
 *  week contributes at least one episode to the brief — this is what stops the
 *  Monday digest going out empty when nobody opened the app all week. Channels with
 *  nothing published this week (nothing to summarise) are correctly left out. */
export function pickBackfillTargets(episodes: Episode[], now: number): Episode[] {
  const cutoff = now - WEEK_MS
  const inWindow = (e: Episode): boolean => +new Date(e.publishedAt) >= cutoff
  // Channels already represented in this week's edition need no backfill.
  const covered = new Set(episodes.filter((e) => e.status === 'ready' && e.summary && inWindow(e)).map((e) => e.podcastId))
  const best = new Map<string, Episode>()
  for (const e of episodes) {
    if (covered.has(e.podcastId)) continue
    if (e.status === 'ready' && e.summary) continue // already processed, just out of window — don't redo it
    if (!inWindow(e)) continue
    // Needs real source material to summarise from (free feed transcript, audio, or
    // show-notes); skip contentless items rather than spend a call on an empty prompt.
    if (!e.transcriptUrl && !e.audioUrl && !(e.notes && e.notes.trim())) continue
    const cur = best.get(e.podcastId)
    if (!cur || +new Date(e.publishedAt) > +new Date(cur.publishedAt)) best.set(e.podcastId, e)
  }
  return [...best.values()]
}

/** ALL pending (not-yet-summarised) episodes published in this week's window that
 *  have source material — the full set the auto-processor chips through so the whole
 *  week is ready by send time, vs `pickBackfillTargets`' one-per-channel floor.
 *  Newest first, so the freshest episodes are summarised first. */
export function pickPendingThisWeek(episodes: Episode[], now: number): Episode[] {
  const cutoff = now - WEEK_MS
  return episodes
    .filter(
      (e) =>
        e.status !== 'ready' &&
        !e.summary &&
        +new Date(e.publishedAt) >= cutoff &&
        (!!e.transcriptUrl || !!e.audioUrl || !!(e.notes && e.notes.trim())),
    )
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
}

/** Default backfill processor, derived from the digest's LLM config: summarise one
 *  episode through the real engine and return its summary, writing the full result
 *  to the shared store so the app and later runs reuse it. Returns undefined when no
 *  LLM key is configured (backfill then no-ops).
 *
 *  Transcription keys are intentionally NOT required here: the digest uses the free
 *  publisher transcript when the feed carries one, else the show-notes — keeping the
 *  Monday run fast and bounded instead of transcribing a dozen full episodes inline. */
export function makeEpisodeProcessor(cfg: SummarizeConfig | undefined): ((ep: Episode) => Promise<Summary | null>) | undefined {
  if (!cfg || (!cfg.openaiKey && !cfg.anthropicKey)) return undefined
  return async (ep) => {
    const show = PODCASTS.find((p) => p.id === ep.podcastId)?.title ?? ep.podcastId
    const res = await summarizeEpisode(
      { id: ep.id, title: ep.title, show, notes: ep.notes, transcriptUrl: ep.transcriptUrl, audioUrl: ep.audioUrl },
      cfg,
    )
    return res.summary
  }
}

export interface DigestDeps {
  /** Source of the curated shows' episodes (summaries overlaid) — getLiveEpisodes. */
  getEpisodes: (store?: SummaryStore) => Promise<Episode[]>
  summaryStore?: SummaryStore
  subscriberStore: SubscriberStore | null
  /** Sends one email; returns whether it went out. Injected so tests don't hit the wire. */
  sendEmail: (msg: { email: string; subject: string; html: string; attachments?: EmailAttachment[] }) => Promise<{ ok: boolean; message: string }>
  /** LLM config for the cross-episode synthesis. When present (a key is set), the
   *  emailed edition gets the SAME Guidepoint AI layer as the on-screen one; absent,
   *  it falls back to the deterministic base. */
  summarizeConfig?: SummarizeConfig
  /** Render the weekly edition to PDF bytes (jsPDF). Optional — paired with
   *  storePdf; when either is absent or throws, the brief sends without a link. */
  generatePdf?: (weekly: WeeklySummary, episodeById: (id: string) => Episode | undefined, podcastById: (id: string) => Podcast | undefined) => Promise<ArrayBuffer>
  /** Store the rendered PDF and return its hosted URL (the brief's download link).
   *  `downloadName` is the filename the link should save as (e.g. the dated brand name). */
  storePdf?: (bytes: ArrayBuffer, downloadName?: string) => Promise<string>
  /** Attach the rendered PDF to each email (in ADDITION to the hosted link). Gated so
   *  it only turns on once the send endpoint supports attachments (EMAIL_ATTACHMENTS).
   *  Requires `generatePdf`; a render failure silently falls back to the link only. */
  attachPdf?: boolean
  /** Summarise one not-yet-processed episode and return its summary (writing it to
   *  the shared store). Powers the pre-send backfill. Injected so tests don't hit the
   *  wire; in production it is derived from `summarizeConfig` when omitted. */
  processEpisode?: (ep: Episode) => Promise<Summary | null>
  /** Overridable clock for tests. */
  now?: number
}

export interface DigestReport {
  ok: boolean
  sent: number
  failed: number
  recipients: number
  rangeLabel?: string
  episodeCount?: number
  /** Episodes processed inline by the pre-send backfill (0 when none was needed). */
  backfilled?: number
  /** Set when nothing was sent: 'no_ready_episodes' | 'no_subscribers'. */
  skipped?: string
}

/** Auto-processor: summarise up to `limit` of THIS WEEK's pending episodes (writing
 *  each to the shared store), bounded by `budgetMs` of wall-clock so a single cron
 *  tick never runs long. The cron calls this every tick, so the week's backlog clears
 *  steadily before the Monday send — sustainable (no burst), and bounded (no timeout).
 *  No-op without an LLM key. Returns how many it processed + how many still pending. */
export async function processPendingBatch(
  deps: Pick<DigestDeps, 'getEpisodes' | 'summaryStore' | 'summarizeConfig' | 'processEpisode' | 'now'>,
  opts: { limit?: number; budgetMs?: number } = {},
): Promise<{ processed: number; remaining: number }> {
  const now = deps.now ?? Date.now()
  const limit = opts.limit ?? 5
  const budgetMs = opts.budgetMs ?? 75_000
  const processEpisode = deps.processEpisode ?? makeEpisodeProcessor(deps.summarizeConfig)
  const pending = pickPendingThisWeek(await deps.getEpisodes(deps.summaryStore), now)
  if (!processEpisode || !pending.length) return { processed: 0, remaining: pending.length }
  const start = Date.now()
  let processed = 0
  for (const ep of pending.slice(0, limit)) {
    if (Date.now() - start > budgetMs) break
    try {
      if (await processEpisode(ep)) processed++
    } catch {
      /* one episode's failure is isolated — keep going */
    }
  }
  return { processed, remaining: Math.max(0, pending.length - processed) }
}

/** Build this week's shared edition and mail it to every subscriber. Returns a
 *  report (also useful as the HTTP response body). Never throws on a single
 *  failed send — those are counted, not fatal. */
export async function runWeeklyDigest(deps: DigestDeps): Promise<{ status: number; body: DigestReport }> {
  const now = deps.now ?? Date.now()
  const podcastById = (id: string): Podcast | undefined => PODCASTS.find((p) => p.id === id)

  // Recipients first: the pre-send backfill below can be expensive (one LLM call per
  // uncovered channel), so don't build an edition nobody is going to receive.
  const subscribers = deps.subscriberStore ? (await deps.subscriberStore.get()) ?? [] : []
  if (!subscribers.length) {
    return { status: 200, body: { ok: true, sent: 0, failed: 0, recipients: 0, skipped: 'no_subscribers' } }
  }

  const all = await deps.getEpisodes(deps.summaryStore)
  let ready = readyThisWeek(all, now)

  // Guarantee the brief isn't empty just because nobody opened the app this week:
  // for every subscribed channel with no ready episode in this week's window, process
  // its most recent pending episode now. Best-effort and per-channel isolated — one
  // channel's failure never blocks the others, nor the send.
  let backfilled = 0
  const processEpisode = deps.processEpisode ?? makeEpisodeProcessor(deps.summarizeConfig)
  if (processEpisode) {
    const targets = pickBackfillTargets(all, now)
    if (targets.length) {
      const results = await Promise.allSettled(
        targets.map(async (t) => {
          const summary = await processEpisode(t)
          if (!summary) return false
          t.status = 'ready'
          t.summary = summary
          return true
        }),
      )
      backfilled = results.filter((r) => r.status === 'fulfilled' && r.value).length
      if (backfilled) ready = readyThisWeek(all, now)
    }
  }

  if (!ready.length) {
    return { status: 200, body: { ok: true, sent: 0, failed: 0, recipients: subscribers.length, backfilled, skipped: 'no_ready_episodes' } }
  }

  // Deterministic base, then the SAME cross-episode AI synthesis the on-screen
  // weekly uses (so the emailed edition isn't a poorer relation). The shared id
  // means a browser visit this week and this cron reuse each other's one LLM call.
  let weekly = assembleWeekly(ready, podcastById)
  const cfg = deps.summarizeConfig
  if (cfg && (cfg.openaiKey || cfg.anthropicKey)) {
    const citations = buildCitations(ready, podcastById)
    const sources = buildWeeklySources(ready, citations, podcastById)
    const ai = await synthesizeWeekly({ id: `weekly:${hashKey(ready)}`, range: weekly.rangeLabel, sources }, { ...cfg, store: deps.summaryStore }).catch(() => null)
    if (ai) weekly = mergeWeeklyAi(weekly, ai)
  }
  const episodeById = (id: string): Episode | undefined => ready.find((e) => e.id === id)

  // Render the PDF ONCE per edition, then reuse those bytes for BOTH the hosted
  // download link and (when enabled) the email attachment. Best-effort throughout: a
  // render/store failure just drops the link/attachment, never the send.
  const fileName = weeklyReportFilename(weekly.rangeLabel)
  let pdfUrl: string | undefined
  let pdfBytes: ArrayBuffer | undefined
  if (deps.generatePdf) {
    try {
      pdfBytes = await deps.generatePdf(weekly, episodeById, podcastById)
      if (deps.storePdf) pdfUrl = await deps.storePdf(pdfBytes, fileName)
    } catch {
      pdfBytes = undefined
      pdfUrl = undefined
    }
  }

  const html = weeklyBriefEmailHtml(weekly, episodeById, podcastById, { pdfUrl })
  const subject = weeklyReportTitle(weekly.rangeLabel)
  // Attach the same bytes when enabled; encoded once and shared across all recipients.
  const attachments: EmailAttachment[] | undefined =
    deps.attachPdf && pdfBytes ? [{ filename: fileName, content: bytesToBase64(pdfBytes), contentType: 'application/pdf' }] : undefined

  let sent = 0
  let failed = 0
  for (const sub of subscribers) {
    const res = await deps.sendEmail({ email: sub.email, subject, html, ...(attachments ? { attachments } : {}) })
    if (res.ok) sent++
    else failed++
  }

  return {
    status: 200,
    body: { ok: failed === 0, sent, failed, recipients: subscribers.length, backfilled, rangeLabel: weekly.rangeLabel, episodeCount: ready.length },
  }
}
