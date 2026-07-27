import { USER_HEADER } from './identityKey'

// ─────────────────────────────────────────────────────────────────────────────
// Identity-aware fetch for SAME-ORIGIN /api/* calls. Its own tiny module (not
// api.ts) so weeklyApi.ts can use it too without a circular import.
//
// Once AppData resolves the Munshot identity (src/lib/munshot.ts) it calls
// setApiUser with the CANONICAL user key (src/lib/identityKey.ts) — already
// header-safe, no encoding needed — and every subsequent /api/* request carries
// it, letting the server pick that user's KV keys. No identity → plain fetch →
// the server's legacy/global behavior, byte-identical to before.
//
// Cross-origin calls (e.g. the direct Apple Search path in api.ts) must NOT go
// through this wrapper: a custom header would trigger a CORS preflight Apple
// doesn't answer.
// ─────────────────────────────────────────────────────────────────────────────

let apiUser: string | null = null

/** Set by AppData when identity resolves or changes. null = anonymous. */
export function setApiUser(key: string | null): void {
  apiUser = key
}

/** fetch(), plus the Munshot user header when an identity is active. */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!apiUser) return fetch(input, init)
  const headers = new Headers(init?.headers)
  headers.set(USER_HEADER, apiUser)
  return fetch(input, { ...init, headers })
}
