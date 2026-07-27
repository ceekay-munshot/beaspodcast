import { canonicalUserKey } from './identityKey'
import { sdk, type DashboardHostContext, type DashboardSdkEnvelope } from './sdk'

// ─────────────────────────────────────────────────────────────────────────────
// Munshot host identity — the app's identity layer, sitting ON TOP of the single
// canonical Dashboard SDK client (src/lib/sdk.ts). This module owns NO SDK
// client of its own: per the Munshot dashboard auth standard there is exactly
// one client, created at module load in sdk.ts, whose message listener is live
// before host:init can arrive. Here we only READ from it (getContext +
// onMessage) and never call ready()/requestContext().
//
// The host injects context per the standard contract: an envelope of kind
// `host:init` (on load) or `host:context:update` (login / sign-out / user
// switch) with the data at `payload.context`, which the SDK caches. We read
// `context.session` ({ token, userName, email, orgId, orgName }) and resolve it
// to an Identity — or null (anonymous) — notifying on every change so the app
// personalizes per user without a refresh. The session carries no userId, so
// (as the host intends) the email IS the identity.
//
// Resolution state machine:
//   not embedded — synchronous: window.self === window.top → anonymous at once
//                  (standalone visits never have a host).
//   awaiting     — embedded: read any already-cached host:init, and listen for
//                  the first explicit host context; 3s of host silence settles
//                  anonymous. The listener stays live, so a LATE host:init is
//                  handled as an identity change rather than lost.
//   settled      — later host:init / host:context:update transition the identity
//                  (switch / sign-out) and fire onIdentityChange; same-user
//                  updates are no-ops.
//
// Safety: every incoming session field is type-checked, trimmed, and length-
// capped; an identity whose canonical key is null is unusable. Identity failure
// of any kind degrades to anonymous — the app stays fully functional. Origin
// safety (lock-on-first-message) is handled by the SDK client in sdk.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface Identity {
  /** The raw host-provided id (the session email). For display/debug. */
  userId: string
  /** canonicalUserKey(userId) — what scopes storage, headers, and KV. Never null here. */
  key: string
  email?: string
  name?: string
}

const HOST_INIT_TIMEOUT_MS = 3000 // host:init is a same-machine postMessage round trip — 3s is ~30x margin

let current: Identity | null = null
let settled = false
let inFlight: Promise<Identity | null> | null = null
const listeners = new Set<(identity: Identity | null) => void>()

/** Sync snapshot of the latest known identity (null until resolved, or anonymous). */
export function getIdentity(): Identity | null {
  return current
}

/** Fires on every identity TRANSITION after first resolution: user switch,
 *  sign-out (→ null), or a late host:init after the anonymous timeout.
 *  Same-user updates do not fire. Returns an unsubscribe function. */
export function onIdentityChange(cb: (identity: Identity | null) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Resolve the embedded identity once (memoized single-flight — every caller
 *  shares one promise). Resolves null when standalone, the host stays silent
 *  past the timeout, or the context is unusable. */
export function resolveIdentity(): Promise<Identity | null> {
  if (inFlight) return inFlight
  inFlight = new Promise((resolve) => {
    if (!isEmbedded()) {
      settle(null, resolve)
      return
    }

    // Settle anonymous if the host never sends context — the listener below
    // stays live, so a late host:init is still handled (as a transition).
    const timer = setTimeout(() => settle(null, resolve), HOST_INIT_TIMEOUT_MS)

    const handle = (ctx: DashboardHostContext | null, explicit: boolean) => {
      const id = parseIdentity(ctx)
      // An empty result from a non-explicit probe just means host:init hasn't
      // landed yet — it must NOT settle us anonymous; keep waiting for the timeout.
      if (!id && !explicit) return
      if (!settled) {
        clearTimeout(timer)
        settle(id, resolve)
        return
      }
      // Post-settlement: transition only when the user actually changed.
      if ((id?.key ?? null) === (current?.key ?? null)) return
      current = id
      notify(id)
    }

    // Persistent listener — catches host:init (settles) and later
    // host:context:update (transitions). Never unsubscribed: it lives for the
    // app's lifetime so a sign-in / switch / sign-out always re-points the app.
    try {
      sdk.onMessage((envelope: DashboardSdkEnvelope) => {
        try {
          const kind = envelope?.kind
          if (kind !== 'host:init' && kind !== 'host:context:update') return
          handle(sdk.getContext(), true)
        } catch {
          /* hostile/odd payload — never throw out of a message handler */
        }
      })
    } catch {
      /* no-op SDK (standalone) — the timeout still settles us anonymous */
    }

    // host:init may have arrived before this ran — the single client caches it
    // at module load, so apply any already-cached context now.
    try {
      handle(sdk.getContext(), false)
    } catch {
      /* getContext threw — the onMessage path still covers init */
    }
  })
  return inFlight
}

// ── internals ────────────────────────────────────────────────────────────────

/** True when this app runs inside the Munshot host iframe (vs. opened standalone).
 *  Inside the host the user is, by definition, signed in — so the UI treats an
 *  as-yet-unresolved identity as "signing in", never "not signed in". */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true // cross-origin access to window.top throws → we ARE embedded
  }
}

/** Validate an untrusted host context into an Identity (or null). Reads the
 *  standard nested `context.session`; type-checks, trims, caps lengths; an
 *  identity whose canonical key is null is unusable. */
function parseIdentity(ctx: DashboardHostContext | null): Identity | null {
  const session = ctx?.session
  if (!session || typeof session !== 'object') return null
  const s = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined
  const email = s(session.email)
  const userId = email // the host session carries no userId — email is the identity
  if (!userId) return null
  const key = canonicalUserKey(userId)
  if (!key) return null
  return { userId, key, email, name: s(session.userName) }
}

function notify(id: Identity | null): void {
  for (const cb of listeners) {
    try {
      cb(id)
    } catch {
      /* one listener's bug must not break the rest */
    }
  }
}

function settle(id: Identity | null, resolve: (id: Identity | null) => void): void {
  if (settled) return
  settled = true
  current = id
  resolve(id)
}
