import type { Episode, Podcast, PodcastSearchResult, Summary, TranscriptSegment, WeeklySchedule, WeeklySummary } from './types'
import { EPISODES, PODCASTS, WEEKLY } from './mock-data'
import { stableHash } from './hash'
import { apiFetch } from './apiFetch'
import { episodeBriefEmailHtml, weeklyBriefEmailHtml, welcomeEmailHtml, bytesToBase64, type EmailResult, type EmailAttachment } from './email'
import { weeklyPdfBytes } from './pdfRender'
import { weeklyReportFilename, weeklyReportTitle, withReportDownloadName } from './reportName'
import { normalizeRecipients } from './recipientsStore'

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM.
//
// Every function here returns the same shape a real backend would. Today they
// resolve from in-memory mock data after a tiny simulated latency. To go live,
// replace each body with a `fetch()` — e.g.
//
//     export const listEpisodes = () =>
//       fetch('/api/episodes').then((r) => r.json() as Promise<Episode[]>)
//
// No component imports mock data directly, so nothing else has to change.
// ─────────────────────────────────────────────────────────────────────────────

const LATENCY = 240 // ms — just enough to exercise loading states.

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

// Clone so the UI can mutate its own copy without corrupting the "server".
function clone<T>(value: T): T {
  return structuredClone(value)
}

export function listPodcasts(): Promise<Podcast[]> {
  return delay(clone(PODCASTS))
}

export function listEpisodes(): Promise<Episode[]> {
  // Live: real episodes from the shows' feeds via /api/episodes (Vite middleware
  // in dev, Cloudflare Pages Function in prod). Falls back to the seeded episodes
  // if the endpoint is unreachable or returns nothing.
  return apiFetch('/api/episodes')
    .then((r) => (r.ok ? (r.json() as Promise<Episode[]>) : Promise.reject(new Error('feed endpoint unavailable'))))
    .then((eps) => (Array.isArray(eps) && eps.length > 0 ? eps : clone(EPISODES)))
    .catch(() => clone(EPISODES))
}

export function getEpisode(id: string): Promise<Episode | undefined> {
  return delay(clone(EPISODES.find((e) => e.id === id)))
}

export function getWeekly(): Promise<WeeklySummary> {
  return delay(clone(WEEKLY))
}

// ── Durable channel roster — /api/channels (KV in prod, .cache file in dev) ──
// Which shows you track — including ones added from Discover — lives server-side
// so it survives deploys and follows you across devices. Munshot-identified
// visitors (apiFetch attaches the user header) each get their OWN roster;
// anonymous/standalone visits share the legacy global one. Every call is
// best-effort: on failure the UI quietly falls back to the localStorage mirror.

export function listChannels(): Promise<Podcast[]> {
  return apiFetch('/api/channels')
    .then((r) => (r.ok ? (r.json() as Promise<Podcast[]>) : []))
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [])
}

/** Persist one channel's state (add, re-track, or untrack via tracked:false). */
export function upsertChannel(podcast: Podcast): Promise<boolean> {
  return apiFetch('/api/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ podcast }),
  })
    .then((r) => r.ok)
    .catch(() => false)
}

/** One-time push of channels this browser knows but the server doesn't (saved
 *  before the backend store existed). Server entries always win; this only adds. */
export function migrateChannels(podcasts: Podcast[]): Promise<boolean> {
  if (!podcasts.length) return Promise.resolve(true)
  return apiFetch('/api/channels', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ podcasts }),
  })
    .then((r) => r.ok)
    .catch(() => false)
}

// ── Per-user processed history — /api/processed (KV in prod, .cache in dev) ──
// Which episodes the signed-in user has run summaries on, durable across
// devices. Entries are lean: the server re-attaches summaries from the GLOBAL
// shared cache on read (transcripts stay lazy), so the expensive artifacts are
// never duplicated per user. Anonymous visitors have no server history — their
// processed list stays in localStorage exactly as before.

/** The user's processed episodes, summary attached. [] when anonymous or on any failure. */
export function listProcessed(): Promise<Episode[]> {
  return apiFetch('/api/processed')
    .then((r) => (r.ok ? (r.json() as Promise<Episode[]>) : []))
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [])
}

/** Upsert one lean processed entry (no summary/transcript — see leanEpisode). Best-effort. */
export function saveProcessedRemote(episode: Omit<Episode, 'summary' | 'transcript'>): Promise<boolean> {
  return apiFetch('/api/processed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode }),
  })
    .then((r) => r.ok)
    .catch(() => false)
}

export class NoApiKeyError extends Error {}

// Generate a real AI summary via /api/summary. Returns the one-page summary AND
// the full transcript it was built from (when a transcript source exists), so the
// Transcript tab can render the real thing. Throws NoApiKeyError when the server
// has no LLM key set, so the UI can show a "connect a key" hint.
export async function generateSummary(input: {
  id?: string // stable episode id → the shared cache key (so all users reuse the result)
  title: string
  show: string
  notes?: string
  transcriptUrl?: string
  audioUrl?: string
  force?: boolean // bypass the server cache and regenerate (Refresh button)
}): Promise<{ summary: Summary; transcript?: TranscriptSegment[] }> {
  const r = await apiFetch('/api/summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (r.status === 503) throw new NoApiKeyError('no_api_key')
  if (!r.ok) throw new Error(`summary failed: ${r.status}`)
  return (await r.json()) as { summary: Summary; transcript?: TranscriptSegment[] }
}

// Weekly-digest email subscription — wired to the Munshot raw-email endpoint
// (src/lib/email.ts). Subscribing sends a real, designed HTML confirmation to
// the address; `subscribed` reflects whether that email actually went out, so a
// failed send can't masquerade as success in the UI. (A durable subscriber list
// + the Monday cron remain server-side work; this delivers the user-facing half.)
export async function subscribeWeekly(email: string, opts: { name?: string } = {}): Promise<{ subscribed: boolean; email: string; message: string }> {
  const res = await postEmail({ to: email, subject: "You're subscribed — Munshot Weekly Brief", html: welcomeEmailHtml({ name: opts.name }) })
  // Only register on the durable list once the confirmation actually sent, so the
  // Monday digest's recipients match who got a working welcome. Best-effort.
  if (res.ok) void persistSubscription('POST', email)
  return { subscribed: res.ok, email, message: res.message }
}

// Send through the same-origin proxy (/api/email/send), which holds the service
// token server-side and relays to the raw-email endpoint. This is what fixes the
// partitioned-iframe failure: a same-origin call needs no cross-origin cookie.
async function postEmail(msg: { to: string; subject: string; html: string; attachments?: EmailAttachment[] }): Promise<EmailResult> {
  try {
    const r = await apiFetch('/api/email/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    const data = (await r.json().catch(() => null)) as EmailResult | null
    if (data && typeof data.ok === 'boolean') return data
    return { ok: r.ok, message: r.ok ? 'Email sent.' : `Send failed (${r.status}).` }
  } catch {
    return { ok: false, message: "Couldn't reach the email service." }
  }
}

// Upload already-rendered PDF bytes to the hosted-report store and return a public,
// dated-filename URL — or null on any failure, so the edition still sends without the
// download link. Bytes are generated by the caller so the SAME render feeds both the
// hosted link and the email attachment.
async function hostPdfBytes(bytes: ArrayBuffer, downloadName: string): Promise<string | null> {
  try {
    const r = await apiFetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: bytes })
    if (!r.ok) return null
    const { url } = (await r.json()) as { url?: string }
    return url ? withReportDownloadName(url, downloadName) : null
  } catch {
    return null
  }
}

export function unsubscribeWeekly(email: string): Promise<{ subscribed: boolean; email: string }> {
  void persistSubscription('DELETE', email) // remove from the durable list (best-effort)
  return delay({ subscribed: false, email })
}

// Put an extra recipient on (or off) the durable Monday-digest list, so anyone the
// user adds in the dashboard — their boss, a colleague — gets the automated weekly
// too, not just an on-demand "Email this edition". Idempotent and fire-and-forget;
// it reuses the same subscriber list / endpoint as the personal subscription.
export function registerWeeklyRecipient(email: string): Promise<void> {
  return persistSubscription('POST', email)
}
export function unregisterWeeklyRecipient(email: string): Promise<void> {
  return persistSubscription('DELETE', email)
}

// The global weekly-digest send schedule (day · time · timezone). GET returns the
// effective schedule (defaulted server-side); PUT saves a new one. The cron endpoint
// reads this to decide when the Monday brief actually goes out.
export async function getWeeklySchedule(): Promise<WeeklySchedule | null> {
  try {
    const r = await apiFetch('/api/schedule/weekly')
    if (!r.ok) return null
    return ((await r.json()) as { schedule?: WeeklySchedule }).schedule ?? null
  } catch {
    return null
  }
}

export async function setWeeklySchedule(s: WeeklySchedule): Promise<{ ok: boolean; schedule?: WeeklySchedule; message?: string }> {
  try {
    const r = await apiFetch('/api/schedule/weekly', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) })
    const data = (await r.json().catch(() => null)) as { schedule?: WeeklySchedule; error?: string } | null
    if (!r.ok) return { ok: false, message: data?.error || `Couldn't save (HTTP ${r.status}).` }
    return { ok: true, schedule: data?.schedule }
  } catch {
    return { ok: false, message: "Couldn't reach the server." }
  }
}

// Add/remove this address on the server-side subscriber list (/api/subscriptions/
// weekly) that the scheduled Monday digest reads. Fire-and-forget: the local
// localStorage mirror is the source of truth for the UI, and a missed write
// self-heals on the next subscribe.
function persistSubscription(method: 'POST' | 'DELETE', email: string): Promise<void> {
  return apiFetch('/api/subscriptions/weekly', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
    .then(() => undefined)
    .catch(() => undefined)
}

// Send the real weekly edition on demand (the Weekly page's "Email this edition")
// to one OR MORE recipients. Renders + hosts the PDF ONCE, then posts the same
// designed brief to each address (the relay proxy validates a single recipient
// per request and rate-limits per address, so a list must fan out one-per-send).
// `ok` is false unless every recipient succeeds, and `message` reports the tally.
export async function emailWeeklyEdition(
  recipients: string | string[],
  weekly: WeeklySummary,
  episodeById: (id: string) => Episode | undefined,
  podcastById: (id: string) => Podcast | undefined,
): Promise<EmailResult> {
  const to = normalizeRecipients(undefined, Array.isArray(recipients) ? recipients : [recipients])
  if (!to.length) return { ok: false, message: 'No valid recipient to send to.' }

  // The PDF is the deliverable: render it ONCE, then reuse those bytes for BOTH the
  // hosted download link AND the email attachment. A failed render degrades to a brief
  // with neither, never a hard fail. (The proxy drops the attachment unless the
  // EMAIL_ATTACHMENTS switch is on, so sending it here is always safe.)
  const fileName = weeklyReportFilename(weekly.rangeLabel)
  let pdfUrl: string | undefined
  let attachments: EmailAttachment[] | undefined
  try {
    const bytes = await weeklyPdfBytes(weekly, episodeById, podcastById)
    pdfUrl = (await hostPdfBytes(bytes, fileName)) ?? undefined
    attachments = [{ filename: fileName, content: bytesToBase64(bytes), contentType: 'application/pdf' }]
  } catch {
    /* no PDF this send — the brief still goes out, just without link/attachment */
  }
  const subject = weeklyReportTitle(weekly.rangeLabel)
  const html = weeklyBriefEmailHtml(weekly, episodeById, podcastById, { pdfUrl })

  const results = await Promise.all(to.map((addr) => postEmail({ to: addr, subject, html, attachments })))
  const sent = results.filter((r) => r.ok).length
  const failed = to.length - sent

  if (sent === 0) return { ok: false, message: results[0]?.message || "Couldn't send the email." }
  if (failed > 0) return { ok: false, message: `Sent to ${sent} of ${to.length} — ${failed} couldn't be reached.` }
  return { ok: true, message: to.length === 1 ? `Sent to ${to[0]}` : `Sent to ${to.length} recipients` }
}

// Send one episode's summary on demand (the Episode page's "Email this edition")
// to one OR MORE recipients. Mirrors emailWeeklyEdition exactly — the designed,
// inbox-safe HTML brief goes through the SAME same-origin proxy (postEmail →
// /api/email/send), which carries the signed-in user's identity header and holds
// the service token server-side. Renders the HTML once, then fans out one send
// per address (the relay validates a single recipient per request). `ok` is false
// unless every recipient succeeds, and `message` reports the tally.
export async function emailEpisodeSummary(
  recipients: string | string[],
  episode: Episode,
  podcast?: Podcast,
): Promise<EmailResult> {
  if (!episode.summary) return { ok: false, message: 'This episode has no summary to send yet.' }
  const to = normalizeRecipients(undefined, Array.isArray(recipients) ? recipients : [recipients])
  if (!to.length) return { ok: false, message: 'No valid recipient to send to.' }

  const subject = `${episode.title} — Munshot Summary`
  const html = episodeBriefEmailHtml(episode, podcast)

  const results = await Promise.all(to.map((addr) => postEmail({ to: addr, subject, html })))
  const sent = results.filter((r) => r.ok).length
  const failed = to.length - sent

  if (sent === 0) return { ok: false, message: results[0]?.message || "Couldn't send the email." }
  if (failed > 0) return { ok: false, message: `Sent to ${sent} of ${to.length} — ${failed} couldn't be reached.` }
  return { ok: true, message: to.length === 1 ? `Sent to ${to[0]}` : `Sent to ${to.length} recipients` }
}

// Search a real podcast directory, or resolve a pasted RSS / Apple-show /
// YouTube-channel URL. Returns [] for an empty query or any failure. Pass an
// AbortSignal to cancel a superseded keystroke — AbortError is re-thrown so the
// caller can ignore it rather than clobber state.
//
// Plain text — and Apple show URLs, which carry their collection id — query
// Apple's Search API straight from the browser: it supports CORS, and Apple's
// WAF blocks datacenter IPs (our server) but not residential ones (this
// browser). /api/search-podcasts stays the fallback — and the only path for
// other URLs, whose resolution (SSRF guard, feed parsing) lives server-side.
export function searchPodcasts(query: string, signal?: AbortSignal, limit?: number): Promise<PodcastSearchResult[]> {
  const q = query.trim()
  if (!q) return Promise.resolve([])
  const viaServer = () =>
    apiFetch(`/api/search-podcasts?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`, { signal })
      .then((r) => (r.ok ? (r.json() as Promise<PodcastSearchResult[]>) : []))
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') throw err
        return []
      })
  if (/^https?:\/\//i.test(q)) {
    const appleId = appleShowId(q)
    if (!appleId) return viaServer()
    return itunesDirect(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appleId)}&entity=podcast`, signal) //
      .then((direct) => (direct.length ? direct : viaServer()))
  }
  return searchItunesDirect(q, signal, limit).then((direct) => (direct.length ? direct : viaServer()))
}

// …podcasts.apple.com/us/podcast/<slug>/id12345 → "12345" (null for non-Apple).
function appleShowId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase()
    if (host !== 'apple.com' && !host.endsWith('.apple.com')) return null
    return u.pathname.match(/\/id(\d+)/)?.[1] ?? null
  } catch {
    return null
  }
}

// One Apple Search row → the wire shape /api/search-podcasts returns. Kept
// field-for-field identical to the server's mapping (server/search.ts), ids
// included, so the same show dedupes no matter which path found it.
interface ItunesRow {
  collectionId?: number
  collectionName?: string
  artistName?: string
  feedUrl?: string
  artworkUrl600?: string
  primaryGenreName?: string
}

function searchItunesDirect(term: string, signal?: AbortSignal, limit = 12): Promise<PodcastSearchResult[]> {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 12), 50)
  return itunesDirect(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${cap}&term=${encodeURIComponent(term)}`, signal)
}

function itunesDirect(url: string, signal?: AbortSignal): Promise<PodcastSearchResult[]> {
  return fetch(url, { signal })
    .then((r) => (r.ok ? (r.json() as Promise<{ results?: ItunesRow[] }>) : { results: [] }))
    .then(({ results }) => {
      const out: PodcastSearchResult[] = []
      const seen = new Set<string>()
      for (const row of Array.isArray(results) ? results : []) {
        const feedUrl = (row.feedUrl || '').trim()
        const title = (row.collectionName || '').trim()
        if (!title || !/^https?:\/\//i.test(feedUrl)) continue // no feed → can't ingest
        const id = `itunes-${row.collectionId ?? stableHash(feedUrl)}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          title,
          author: (row.artistName || '').trim(),
          category: (row.primaryGenreName || 'Podcast').trim(),
          description: '',
          artworkUrl: row.artworkUrl600 || undefined,
          feedUrl,
          source: 'podcast',
        })
      }
      return out
    })
    .catch((err) => {
      if ((err as { name?: string })?.name === 'AbortError') throw err
      return [] // blocked/offline → the server route gets its turn
    })
}

// Resolve "<show> <episode title>" to a YouTube video id for the in-app player
// (used when a YouTube-surfaced show is fed by plain RSS, e.g. All-In, so its
// episodes carry no direct video link). Null on any failure — the caller falls
// back to the external link.
export function resolveVideo(query: string, signal?: AbortSignal): Promise<string | null> {
  return apiFetch(`/api/resolve-video?q=${encodeURIComponent(query)}`, { signal })
    .then((r) => (r.ok ? (r.json() as Promise<{ videoId?: string | null }>) : null))
    .then((d) => (d && typeof d.videoId === 'string' && d.videoId ? d.videoId : null))
    .catch((err) => {
      if ((err as { name?: string })?.name === 'AbortError') throw err
      return null
    })
}

// Recent episodes for a single user-added feed. The server validates the URL
// (SSRF guard) and parses RSS or YouTube/Atom. Returns [] on any failure.
export function fetchFeedEpisodes(feedUrl: string, podcastId: string): Promise<Episode[]> {
  return apiFetch(`/api/episodes?feed=${encodeURIComponent(feedUrl)}&id=${encodeURIComponent(podcastId)}`)
    .then((r) => (r.ok ? (r.json() as Promise<Episode[]>) : []))
    .catch(() => [])
}
