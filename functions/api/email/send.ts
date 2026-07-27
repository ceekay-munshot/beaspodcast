import { sendRawEmail, cleanAttachments, type RawEmail } from '../../../src/lib/email'
import type { KVNamespace } from '../../../server/summaryStore'

// Cloudflare Pages Function → POST /api/email/send (production).
// The SAME-ORIGIN email proxy. The browser can't reliably reach the raw-email
// endpoint cross-origin (the app is a partitioned iframe, so its muns.io session
// cookie isn't sent), and we never want the service token in the client bundle.
// So all on-demand sends (subscribe welcome, "email this edition") POST here, and
// this holds MUNSHOT_EMAIL_TOKEN server-side and relays with it.
//
// Because that token can send as Munshot to anyone, this endpoint is hardened so it
// can't be used as an open relay — WITHOUT any config or UX cost:
//   • recipient validation — exactly one valid address, no CRLF (header injection),
//   • a soft same-origin gate — a foreign browser Origin is rejected (absent Origin
//     is allowed, so legit same-origin posts that omit it never break),
//   • best-effort KV rate limiting — a per-recipient cooldown (stops inbox bombing)
//     plus a generous global hourly cap (stops runaway abuse). Fails OPEN if KV is
//     unavailable, so a flaky cache never blocks a legitimate send.
// The Monday cron sends via sendRawEmail directly (not this proxy), so its bulk
// per-subscriber loop is never rate-limited.
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

interface Env {
  MUNSHOT_EMAIL_TOKEN?: string
  SUMMARIES?: KVNamespace
  SITE_URL?: string
  // "1" ⇒ forward file attachments to the raw-email endpoint. Off by default so the
  // proxy stays a plain text/html relay until the endpoint supports attachments.
  EMAIL_ATTACHMENTS?: string
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/
const MAX_CONTENT = 200_000 // generous: a designed weekly brief is ~30-60KB
const GLOBAL_HOURLY_CAP = 300 // on-demand sends only (cron bypasses this proxy)
const PER_RECIPIENT_COOLDOWN_S = 30

/** Bare origin (scheme://host[:port]) or '' when unparseable. */
function bareOrigin(u: string | null | undefined): string {
  if (!u) return ''
  try {
    return new URL(u).origin
  } catch {
    return ''
  }
}

/** Tiny non-crypto hash → a safe KV key suffix for a recipient. */
function keyHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context

  // Soft same-origin gate: only reject a present-but-foreign Origin. (Absent Origin
  // — which some browsers do for same-origin POSTs — is allowed so we never block a
  // legitimate dashboard send.)
  const origin = bareOrigin(request.headers.get('origin'))
  if (origin) {
    const allowed = new Set([bareOrigin(env.SITE_URL), 'https://chat.muns.io', 'https://muns.io'].filter(Boolean))
    if (!allowed.has(origin)) return json(403, { ok: false, message: 'Forbidden origin.' })
  }

  let body: { to?: unknown; subject?: unknown; text?: unknown; html?: unknown; attachments?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json(400, { ok: false, message: 'Invalid request.' })
  }
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject : ''
  const text = typeof body.text === 'string' ? body.text : undefined
  const html = typeof body.html === 'string' ? body.html : undefined
  // Attachments only ride along when the feature is enabled; otherwise the client's
  // bytes are simply ignored and the brief goes out with its hosted link as before.
  const attachments = env.EMAIL_ATTACHMENTS === '1' ? cleanAttachments(body.attachments) : []
  // Exactly one valid recipient, no header-injection newlines.
  if (!EMAIL_RE.test(to) || /[\r\n]/.test(to)) return json(400, { ok: false, message: 'A valid recipient email is required.' })
  if (!subject || /[\r\n]/.test(subject) || (!!text === !!html)) return json(400, { ok: false, message: 'A subject and exactly one of text or html are required.' })
  if ((html ?? text ?? '').length > MAX_CONTENT) return json(413, { ok: false, message: 'Email content is too large.' })

  // Best-effort rate limiting (fails open). Per-recipient cooldown stops bombing one
  // inbox; the hourly global cap stops runaway abuse of the service token.
  const kv = env.SUMMARIES
  if (kv) {
    try {
      const rk = `erl:r:${keyHash(to.toLowerCase())}`
      if (await kv.get(rk)) return json(429, { ok: false, message: 'Please wait a moment before emailing this address again.' })
      const gk = `erl:g:${Math.floor(Date.now() / 3_600_000)}`
      const n = Number((await kv.get(gk)) ?? '0') || 0
      if (n >= GLOBAL_HOURLY_CAP) return json(429, { ok: false, message: 'Email is temporarily rate-limited. Please try again shortly.' })
      // Record before sending so concurrent requests see the cooldown.
      await Promise.all([kv.put(rk, '1', { expirationTtl: PER_RECIPIENT_COOLDOWN_S }), kv.put(gk, String(n + 1), { expirationTtl: 3700 })])
    } catch {
      /* KV unavailable — degrade open; never block a legitimate send on a cache hiccup */
    }
  }

  const base = { email: to, subject, ...(attachments.length ? { attachments } : {}) }
  const msg: RawEmail = html ? { ...base, html } : { ...base, text: text as string }
  const res = await sendRawEmail(msg, { token: env.MUNSHOT_EMAIL_TOKEN })
  return json(res.ok ? 200 : 502, res)
}
