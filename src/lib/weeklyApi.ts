import type { Episode, Podcast, WeeklyAi, WeeklySummary } from './types'
import { apiFetch } from './apiFetch'
import { scopedKey } from './storageScope'
import { assembleWeekly, buildCitations, buildShowDigests, buildWeeklySources, hashKey, mergeWeeklyAi, rangeLabel } from './weeklyAssemble'

// ─────────────────────────────────────────────────────────────────────────────
// Real Weekly Summary — a "summary of summaries" built ONLY from analysed
// episodes (zero fake data). Two layers:
//
//   • Deterministic (always): the by-show digests, top themes, mentions, the
//     interesting pull-quote, source episodes, the date range — all in the pure,
//     runtime-agnostic engine (weeklyAssemble.ts), shared with the server-side
//     Monday digest so the emailed and on-screen editions are built the same way.
//   • AI narrative (when a key is configured): the cross-episode overview, the
//     key takeaways, and the open questions — synthesised by reusing the same
//     /api/summary endpoint the episodes use (no new backend). Falls back to the
//     deterministic layer's prose when there's no key or the call fails.
//
// Caching is layered. L1 (per browser): a memory map + user-scoped localStorage,
// keyed by the EDITION SCOPE (the ISO week, or 'all') — NOT the exact episode set.
// So once an edition is generated it's SAVED and shown instantly on every later
// visit, and detecting a new episode no longer silently re-runs the synthesis;
// the page surfaces "new episodes" and only Refresh (force) regenerates. L2
// (global): the AI synthesis still posts a content-derived `id`, so the shared
// summary store reuses it across ALL users — the same episode set is run through
// the model ONCE total, not once per visitor.
// ─────────────────────────────────────────────────────────────────────────────

type ById = (id: string) => Podcast | undefined

// Re-exported so existing importers (and tests) keep a stable surface.
export { buildShowDigests }

const SESSION = new Map<string, WeeklySummary>()

// In-flight generations, keyed by the scope cache key. Module-level, so a run
// SURVIVES the Weekly page unmounting on navigation: a second caller (e.g. the page
// remounting on return) re-attaches to the SAME promise instead of starting another
// — the synthesis is never lost or duplicated by leaving and coming back.
const inFlight = new Map<string, Promise<WeeklySummary | null>>()

// Saved-edition cache key — per user, per SCOPE (week key | 'all'). `:v5` retires
// the old per-episode-set keying (and the comparison-table shape before it), so a
// stale cached edition is never read after this change.
const cacheKey = (scope: string): string => scopedKey('munshot:weekly:v5') + `:${scope}`

/** The saved edition for a scope, read synchronously (memory then localStorage),
 *  WITHOUT generating. Lets the page show the saved edition instantly and decide
 *  separately whether new episodes warrant a refresh. */
export function peekWeekly(scope = 'all'): WeeklySummary | null {
  const ck = cacheKey(scope)
  return SESSION.get(ck) ?? readCache(ck)
}

/** The in-flight generation for a scope, if one is running right now (else null).
 *  Lets a remounting page re-attach to a synthesis that's still going. */
export function pendingWeekly(scope = 'all'): Promise<WeeklySummary | null> | null {
  return inFlight.get(cacheKey(scope)) ?? null
}

export interface WeeklyOptions {
  /** Disambiguates the cache entry — pass the ISO week key (or 'all'). Keeps two
   *  different views over the same episode set (a single week vs. all-time) from
   *  colliding on the content hash. */
  scope?: string
  /** Canonical label to use instead of the episodes' min/max range (e.g. the
   *  week's Mon–Sun span for a per-week edition). */
  rangeLabel?: string
  /** Skip the cache READ and regenerate from scratch (still overwrites the cache).
   *  Powers the "Refresh" button: after a format/prompt change ships, a user can
   *  force the latest version instead of being served the stale cached edition. */
  force?: boolean
}

export async function generateWeekly(
  episodes: Episode[],
  podcastById: ById,
  opts: WeeklyOptions = {},
): Promise<WeeklySummary | null> {
  const ready = episodes
    .filter((e) => e.status === 'ready' && e.summary)
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
  if (!ready.length) return null

  const scope = opts.scope || 'all'
  const ck = cacheKey(scope)
  // On a normal load, return the SAVED edition for this scope — never reprocess just
  // because a new episode was detected (the page surfaces that and offers Refresh).
  if (!opts.force) {
    const cached = SESSION.get(ck) ?? readCache(ck)
    if (cached) {
      SESSION.set(ck, cached)
      return cached
    }
  }

  // A run for this scope already going? Re-attach to it (survives navigation; never
  // double-runs the synthesis from a remount or a double-click).
  const existing = inFlight.get(ck)
  if (existing) return existing

  // Always-real deterministic base (shared engine), then the AI narrative on top.
  // The GLOBAL server id stays content-derived (episode-set hash) so the same set is
  // synthesised once across all users; only the per-browser SAVED edition is scoped.
  const run = (async () => {
    const contentKey = `${hashKey(ready)}:${scope}`
    const range = opts.rangeLabel ?? rangeLabel(ready)
    const base = assembleWeekly(ready, podcastById, { rangeLabel: range, id: `wk-${contentKey}` })
    // Guidepoint AI layer (overview, key themes, quant table, readouts, questions) with
    // the deterministic fallback baked into mergeWeeklyAi.
    const ai = await aiSynthesize(ready, range, podcastById, { id: `weekly:${contentKey}`, force: opts.force })
    const weekly = ai ? mergeWeeklyAi(base, ai) : base
    SESSION.set(ck, weekly)
    writeCache(ck, weekly)
    return weekly
  })()
  inFlight.set(ck, run)
  try {
    return await run
  } finally {
    inFlight.delete(ck)
  }
}

// ── AI narrative via the shared /api/summary endpoint (weekly mode) ───────────
// Builds the numbered source payload from the per-episode insights, posts it to
// /api/summary with mode:'weekly', and returns the WeeklyAi narrative (or null on
// timeout / no-key / failure, so the caller keeps the deterministic base).
async function aiSynthesize(
  ready: Episode[],
  range: string,
  podcastById: ById,
  opts: { id?: string; force?: boolean } = {},
): Promise<WeeklyAi | null> {
  const citations = buildCitations(ready, podcastById)
  const sources = buildWeeklySources(ready, citations, podcastById)

  try {
    // Bound the call so the edition never hangs on a stuck endpoint — on timeout we
    // abort and fall through to the deterministic layer. Generous: the per-episode
    // Investment Readout makes the synthesis heavier (~20-40s for a full week), and
    // a 25s cap was tripping it into the deterministic fallback on real-sized weeks.
    // This is a one-time, shared, cache-miss cost (the result is cached server- AND
    // client-side), so a longer ceiling beats silently degrading the brief.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 75_000)
    let res: Response
    try {
      res = await apiFetch('/api/summary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'weekly', id: opts.id, range, sources, force: opts.force }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return null
    const data = (await res.json()) as { weekly?: WeeklyAi }
    return data.weekly ?? null
  } catch {
    return null
  }
}

function readCache(storageKey: string): WeeklySummary | null {
  try {
    const raw = localStorage.getItem(storageKey)
    return raw ? (JSON.parse(raw) as WeeklySummary) : null
  } catch {
    return null
  }
}

function writeCache(storageKey: string, w: WeeklySummary): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(w))
  } catch {
    /* storage unavailable — fine, session cache still applies */
  }
}
