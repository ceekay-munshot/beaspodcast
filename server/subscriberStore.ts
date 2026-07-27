import type { KVNamespace } from './summaryStore'

// ─────────────────────────────────────────────────────────────────────────────
// Durable weekly-brief subscriber list — the recipients the Monday digest job
// (server/weeklyDigest.ts) mails. One KV value (no TTL → permanent) holding an
// array of { email, addedAt, userKey? }. Mirrors the channel-roster store:
//   • Production (Pages Function /api/subscriptions/weekly): Workers KV.
//   • Local dev (Vite middleware):                           one JSON file.
//
// This is a single global list (the chosen design: one shared weekly edition for
// everyone), not per-user — so it is NOT scoped by the Munshot identity header.
// The list is low-sensitivity (just emails the user themselves entered), trusted
// at the same level as the rest of this unauthenticated API.
// ─────────────────────────────────────────────────────────────────────────────

export const SUBSCRIBERS_KEY = 'weekly:subscribers:v1'
const MAX_SUBSCRIBERS = 10_000 // guards the KV value from unbounded growth
const EMAIL_MAX = 254 // RFC 5321 practical maximum

export interface Subscriber {
  email: string
  addedAt: string
  /** The Munshot user key, when the subscriber was signed in (debug/cleanup). */
  userKey?: string
}

export interface SubscriberStore {
  /** The stored list; [] when none yet; null when the read FAILED (callers must
   *  not rebuild-and-write from null — that would clobber the list). */
  get(): Promise<Subscriber[] | null>
  /** Persists the list. Best-effort — a lost write self-heals on the next one. */
  put(list: Subscriber[]): Promise<void>
}

/** Cloudflare Workers KV backend (production). */
export function kvSubscriberStore(kv: KVNamespace, key: string = SUBSCRIBERS_KEY): SubscriberStore {
  return {
    async get() {
      try {
        const v = await kv.get(key, 'json')
        if (v === null || v === undefined) return []
        return Array.isArray(v) ? (v as Subscriber[]) : null
      } catch {
        return null
      }
    },
    async put(list) {
      try {
        await kv.put(key, JSON.stringify(list))
      } catch {
        // Quota/transient failure — the client keeps its localStorage mirror and
        // re-pushes on its next subscribe; the digest simply misses this addition.
      }
    },
  }
}

/** Trim + lowercase + shape-check an untrusted email, or null. Deliberately
 *  permissive (one @, a dot in the domain) — real validation is the delivery. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (!email || email.length > EMAIL_MAX) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

/** Add an email if absent (idempotent). Returns the SAME array reference when the
 *  email is already present (so the caller can skip a needless write), a new array
 *  when added, or null when the email is invalid. */
export function applySubscribe(list: Subscriber[], rawEmail: unknown, userKey?: string | null): Subscriber[] | null {
  const email = normalizeEmail(rawEmail)
  if (!email) return null
  if (list.some((s) => s.email === email)) return list
  const entry: Subscriber = { email, addedAt: new Date().toISOString() }
  if (userKey) entry.userKey = userKey
  return [entry, ...list].slice(0, MAX_SUBSCRIBERS)
}

/** Remove an email. Returns the same reference when nothing changed. */
export function applyUnsubscribe(list: Subscriber[], rawEmail: unknown): Subscriber[] {
  const email = normalizeEmail(rawEmail)
  if (!email) return list
  const next = list.filter((s) => s.email !== email)
  return next.length === list.length ? list : next
}

/** The whole /api/subscriptions/weekly endpoint, runtime-agnostic.
 *   GET    → { count } (never the addresses — the list isn't public)
 *   POST   → subscribe   { email }  → { subscribed: true,  email }
 *   DELETE → unsubscribe { email }  → { subscribed: false, email } */
export async function handleSubscribers(
  store: SubscriberStore | null,
  method: string,
  rawBody: string,
  userKey: string | null = null,
): Promise<{ status: number; body: unknown }> {
  if (method === 'GET') {
    const list = store ? await store.get() : []
    return { status: 200, body: { count: (list ?? []).length } }
  }
  if (method !== 'POST' && method !== 'DELETE') return { status: 405, body: { error: 'method_not_allowed' } }
  if (!store) return { status: 503, body: { error: 'no_subscriber_store' } }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawBody || '{}') as Record<string, unknown>
  } catch {
    return { status: 400, body: { error: 'bad_json' } }
  }

  const current = await store.get()
  if (current === null) return { status: 503, body: { error: 'store_unreachable' } }

  if (method === 'POST') {
    const next = applySubscribe(current, parsed.email, userKey)
    if (!next) return { status: 400, body: { error: 'invalid_email' } }
    if (next !== current) await store.put(next)
    return { status: 200, body: { subscribed: true, email: normalizeEmail(parsed.email) } }
  }
  const next = applyUnsubscribe(current, parsed.email)
  if (next !== current) await store.put(next)
  return { status: 200, body: { subscribed: false, email: normalizeEmail(parsed.email) } }
}
