import type { SummarizeResult } from './summarize' // type-only → erased at runtime, no import cycle

// ─────────────────────────────────────────────────────────────────────────────
// Shared, persistent summary store.
//
// A processed episode summary is expensive (transcription + an LLM pass). It is
// the SAME for every user of a given feed, so it should be computed once and
// reused by everyone — not regenerated per-browser. This module is the seam: a
// tiny get/put keyed by the stable episode id, with a runtime-specific backend.
//
//   • Production (Cloudflare Pages Function): Workers KV  → see `kvSummaryStore`.
//   • Local dev (Vite middleware, Node):      filesystem  → see `summaryStore.node.ts`.
//
// Kept free of Node imports so the Workers bundle never pulls in `node:fs`; the
// filesystem backend lives in the separate `.node.ts` file that only Vite imports.
// ─────────────────────────────────────────────────────────────────────────────

// Bump when the summary prompt/schema changes, so a warm worker (whose in-memory
// cache can outlive a deploy) AND the shared store never serve a summary written
// by the previous prompt — the revision is part of every cache key.
// r5: takeaways + moments merged into one `highlights` list (key-flagged).
// r6: added structured `ideas` (concrete pitches/calls + thesis) extraction.
// r7: added investable `insight` (what changed / why / who benefits / who's at
//     risk / diligence questions) + `quantData` (hard numbers) extraction.
// r8: harden normalize — coerce `synthesis` (and the weekly `overview`) to a
//     string[] even when the model returns one string, so the UI/PDF `.map` over
//     paragraphs can't crash; invalidates any poisoned r7 string-synthesis caches.
// r9: weekly replaces the comparison table with per-episode investment readouts
//     (table + cards) under a strict evidence rule; feeds diligence + lead
//     synthesis into the prompt. Invalidates r8 comparison-only weekly caches.
export const SUMMARY_REVISION = 9

/** The shared cache key for an episode. The episode id is stable across all users
 *  of the same feed (`live-${podcastId}-${hash(guid|link|title+date)}`), so this is
 *  the canonical "this episode's summary" key. */
export const sharedSummaryKey = (id: string): string => `sum:r${SUMMARY_REVISION}:${id}`

export interface SummaryStore {
  /** Returns the stored result, or null on a miss / any error (never throws). */
  get(key: string): Promise<SummarizeResult | null>
  /** Persists a result. Best-effort — failures must never break summarization. */
  put(key: string, value: SummarizeResult): Promise<void>
}

// Minimal Workers-KV shape. `functions/` and `server/` are NOT type-checked by
// `npm run build` (tsconfig includes only src/), so this lightweight local
// declaration is just for editor sanity — the real binding is provided at runtime.
export interface KVNamespace {
  get(key: string): Promise<string | null>
  get(key: string, type: 'json'): Promise<unknown>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void>
}

// 90 days: long enough that popular episodes effectively never re-process, short
// enough that anything stale eventually refreshes on its own.
const TTL_SECONDS = 60 * 60 * 24 * 90

/** Cloudflare Workers KV backend (production). Eventually consistent (~60s global). */
export function kvSummaryStore(kv: KVNamespace): SummaryStore {
  return {
    async get(key) {
      try {
        return ((await kv.get(key, 'json')) as SummarizeResult | null) ?? null
      } catch {
        return null
      }
    },
    async put(key, value) {
      try {
        await kv.put(key, JSON.stringify(value), { expirationTtl: TTL_SECONDS })
      } catch {
        // KV write failed (quota, transient) — the summary still returns to the
        // caller; the next visitor simply recomputes. Never surface this.
      }
    },
  }
}
