import { canonicalUserKey, USER_HEADER } from '../src/lib/identityKey'

// ─────────────────────────────────────────────────────────────────────────────
// Server-side user identity — read from a request header, canonicalized by the
// SAME shared module the browser uses (src/lib/identityKey.ts), so the client's
// localStorage scoping and the server's KV keys can never drift apart.
//
// Trust model: the header is sent by the embedded frontend from the identity the
// Munshot host injected via the Dashboard SDK. It is TRUSTED as-is (no JWT
// verification) — the same trust level as the rest of this unauthenticated API;
// the data behind it (a podcast roster) is low-sensitivity by design.
//
// No header (standalone visits, local dev without the harness, curl) → null →
// every store falls back to its legacy/global key: today's behavior, unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export { USER_HEADER }

/** Raw header value → safe, stable per-user key segment, or null (anonymous).
 *  Idempotent: the client already sends the canonical form, but re-running the
 *  canonicalizer here keeps non-browser callers (curl, tests) just as safe. */
export const userKeyFrom = (headerValue: string | null | undefined): string | null =>
  canonicalUserKey(headerValue)
