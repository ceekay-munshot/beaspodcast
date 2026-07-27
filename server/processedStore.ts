import type { Episode, Summary } from '../src/lib/types'
import { sharedSummaryKey, type KVNamespace, type SummaryStore } from './summaryStore'

// ─────────────────────────────────────────────────────────────────────────────
// Durable PER-USER processed history — which episodes a user has run summaries
// on — so their history survives reloads, deploys, and device switches.
//
// Lean by design: an entry stores only the metadata needed to re-render an
// episode card and re-drive the client's hydrate path. The expensive artifacts
// (summary + transcript) live ONCE in the global shared cache (`sum:r…:<id>`,
// see summaryStore.ts) and are re-attached on read — never duplicated per user.
// On a GET, each entry is re-hydrated against the shared cache: hit → 'ready'
// with its summary (transcript stays lazy — the client fetches it from
// /api/summary as a pure store hit); miss (expired / revision bump) → 'detected'
// with notes/transcriptUrl/audioUrl intact for one-click reprocessing.
//
//   • Production (Pages Function /api/processed): Workers KV → `kvProcessedStore`,
//     one value per user at `u:<uid>:processed:v1` (no TTL → durable).
//   • Local dev (Vite middleware): one JSON file per user → processedStore.node.ts.
//
// GET is best-effort: a transient read failure returns [] and the client's
// localStorage cache stands in; only mutations hard-fail (a write must never
// follow a failed read — that would clobber the list). Last-write-wins races
// are scoped to a single user's own actions and self-heal on the next boot
// (the client re-pushes local entries the server copy is missing).
// ─────────────────────────────────────────────────────────────────────────────

export const processedKeyFor = (uid: string): string => `u:${uid}:processed:v1`

const MAX_PROCESSED = 200 // matches the client's localStorage cap (processedStore.ts)

/** One processed episode, lean: everything an episode card/detail needs EXCEPT
 *  the summary and transcript, which re-hydrate from the shared cache by id. */
export interface ProcessedEntry {
  id: string // episode id == the shared summary cache key suffix
  podcastId: string
  title: string
  publishedAt: string // ISO
  durationSec: number
  blurb: string
  sourceUrl?: string
  notes?: string // summary-regen fallback if the shared cache entry expired
  transcriptUrl?: string // transcript re-hydrate / reprocess via /api/summary
  audioUrl?: string
  signal?: 'high' | 'normal'
  processedAt: string // ISO — ALWAYS server-set, never client-supplied
}

export interface ProcessedStore {
  /** The stored history; [] when none yet; null when the read FAILED (callers
   *  must not write a list rebuilt from null — that would clobber the history). */
  get(): Promise<ProcessedEntry[] | null>
  /** Persists the history. Best-effort — a lost write self-heals on next boot. */
  put(list: ProcessedEntry[]): Promise<void>
}

/** Cloudflare Workers KV backend (production), keyed per user. Eventually
 *  consistent (~60s); the client's localStorage cache covers the window. */
export function kvProcessedStore(kv: KVNamespace, key: string): ProcessedStore {
  return {
    async get() {
      try {
        const v = await kv.get(key, 'json')
        if (v === null || v === undefined) return []
        return Array.isArray(v) ? (v as ProcessedEntry[]) : null
      } catch {
        return null
      }
    },
    async put(list) {
      try {
        await kv.put(key, JSON.stringify(list))
      } catch {
        // Quota/transient failure — the client's local cache still has the entry
        // and re-pushes it on its next boot (self-heal).
      }
    },
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' && v ? v.slice(0, max) : '')

/** Coerce one untrusted wire object into a lean ProcessedEntry (or null).
 *  Unknown fields — including a client accidentally posting `summary` or
 *  `transcript` — are dropped at the door; per-field caps keep one hostile
 *  payload from bloating the user's value. `processedAt` is always server-set. */
export function sanitizeProcessed(raw: unknown): ProcessedEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Record<string, unknown>
  const id = str(x.id, 200)
  const podcastId = str(x.podcastId, 200)
  const title = str(x.title, 300)
  if (!id || !podcastId || !title) return null
  const published = new Date(str(x.publishedAt, 40))
  const entry: ProcessedEntry = {
    id,
    podcastId,
    title,
    publishedAt: Number.isNaN(published.getTime()) ? new Date().toISOString() : published.toISOString(),
    durationSec:
      typeof x.durationSec === 'number' && Number.isFinite(x.durationSec) ? Math.max(0, Math.floor(x.durationSec)) : 0,
    blurb: str(x.blurb, 300),
    processedAt: new Date().toISOString(),
  }
  const sourceUrl = str(x.sourceUrl, 600)
  const notes = str(x.notes, 2500) // same cap the feed parser applies (feeds.ts)
  const transcriptUrl = str(x.transcriptUrl, 600)
  const audioUrl = str(x.audioUrl, 600)
  if (sourceUrl) entry.sourceUrl = sourceUrl
  if (notes) entry.notes = notes
  if (transcriptUrl) entry.transcriptUrl = transcriptUrl
  if (audioUrl) entry.audioUrl = audioUrl
  if (x.signal === 'high' || x.signal === 'normal') entry.signal = x.signal
  return entry
}

/** Upsert one entry into the history (newest first, capped). Null on invalid input. */
export function applyProcessedUpsert(list: ProcessedEntry[], raw: unknown): ProcessedEntry[] | null {
  const entry = sanitizeProcessed(raw)
  if (!entry) return null
  return [entry, ...list.filter((e) => e && e.id !== entry.id)].slice(0, MAX_PROCESSED)
}

/** Lean stored entry + optional shared-cache summary → the full Episode shape
 *  the client renders. Summary only — the bulky transcript stays lazy (the
 *  client's existing hydrate path fetches it from /api/summary, a pure store
 *  hit). A cache miss (expired / revision bump) degrades to 'detected' with the
 *  reprocessing inputs intact. */
export function entryToEpisode(e: ProcessedEntry, summary: Summary | null): Episode {
  const episode: Episode = {
    id: e.id,
    podcastId: e.podcastId,
    title: e.title,
    publishedAt: e.publishedAt,
    durationSec: e.durationSec,
    status: summary ? 'ready' : 'detected',
    signal: e.signal ?? 'normal',
    blurb: e.blurb || 'Processed episode.',
    entities: { people: [], companies: [], themes: [] },
  }
  if (e.sourceUrl) episode.sourceUrl = e.sourceUrl
  if (e.notes) episode.notes = e.notes
  if (e.transcriptUrl) episode.transcriptUrl = e.transcriptUrl
  if (e.audioUrl) episode.audioUrl = e.audioUrl
  if (summary) episode.summary = summary
  return episode
}

/** The whole /api/processed endpoint, runtime-agnostic — the Pages Function and
 *  the Vite dev middleware are thin wrappers around this one implementation.
 *    GET  → the user's history, re-hydrated against the shared summary cache
 *           (best-effort: anonymous / failed read → []).
 *    POST → upsert one entry { episode: Episode-ish } (requires identity). */
export async function handleProcessed(
  store: ProcessedStore | null, // null when anonymous OR no KV binding
  summaries: SummaryStore | null, // the shared cache, for GET re-hydration
  method: string,
  rawBody: string,
): Promise<{ status: number; body: unknown }> {
  if (method === 'GET') {
    const entries = store ? await store.get() : []
    if (!entries) return { status: 200, body: [] } // failed read → client's local cache stands in
    const hits = await Promise.all(entries.map((e) => (summaries ? summaries.get(sharedSummaryKey(e.id)) : null)))
    return { status: 200, body: entries.map((e, i) => entryToEpisode(e, hits[i]?.summary ?? null)) }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  if (!store) return { status: 401, body: { error: 'no_user' } } // mutations require identity — makes wiring bugs visible

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawBody || '{}') as Record<string, unknown>
  } catch {
    return { status: 400, body: { error: 'bad_json' } }
  }

  const current = await store.get()
  if (current === null) return { status: 503, body: { error: 'store_unreachable' } }

  const next = applyProcessedUpsert(current, parsed.episode)
  if (!next) return { status: 400, body: { error: 'invalid_episode' } }
  await store.put(next)
  return { status: 200, body: { ok: true } }
}
