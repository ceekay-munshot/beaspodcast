// ─────────────────────────────────────────────────────────────────────────────
// URL safety (SSRF guard) for server-side fetches of user-supplied URLs.
//
// The search endpoint and the /api/episodes?feed= param both fetch URLs the user
// typed. Without a guard, someone could point us at internal addresses
// (127.0.0.1, 169.254.169.254 cloud-metadata, RFC-1918 ranges, …) and use the
// server as a proxy into the private network. Every such URL — and every
// redirect hop — is validated before we open a connection.
//
// Limitation (acceptable for this backend-less prototype): we validate URL
// *literals* and *redirect hops*, not DNS. A hostname that resolves to a private
// IP isn't caught, since edge runtimes can't do raw DNS resolution. Documented,
// not silently ignored.
// ─────────────────────────────────────────────────────────────────────────────

function isPublicIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  if (a === 0) return false // 0.0.0.0/8 — "this host"
  if (a === 127) return false // loopback
  if (a === 10) return false // RFC1918 private
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918 private
  if (a === 192 && b === 168) return false // RFC1918 private
  if (a === 169 && b === 254) return false // link-local, incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64.0.0/10
  return true
}

function isPublicIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase() // hostname already strips brackets; be defensive
  if (h === '::' || h === '::1') return false // unspecified / loopback
  if (/^f[cd]/.test(h)) return false // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return false // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d). URL parsing may normalize the embedded IPv4 into
  // two hex groups (::ffff:7f00:1) — handle both so a mapped private isn't missed.
  const dotted = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return isPublicIpv4(dotted[1].split('.').map(Number))
  const hex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return isPublicIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff])
  }
  return true
}

/** True only for http(s) URLs whose host isn't loopback/private/link-local. Never throws. */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.includes(':')) return isPublicIpv6(host) // IPv6 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) return isPublicIpv4(v4.slice(1).map(Number)) // IPv4 literal
  return true // a regular hostname — allowed (no DNS resolution at the edge)
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

// fetch() that follows redirects MANUALLY, re-validating every hop. We never set
// redirect:'follow' on a user URL — otherwise a public host could 30x us straight
// into a private address. Verified on Node/undici (dev) and Cloudflare Workers
// (prod): redirect:'manual' surfaces the real 3xx status and a readable Location.
export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = 3): Promise<Response | null> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isPublicHttpUrl(current)) return null
    let res: Response
    try {
      res = await fetch(current, { ...init, redirect: 'manual' })
    } catch {
      return null
    }
    if (!REDIRECT_CODES.has(res.status)) return res // final (non-redirect) response
    const loc = res.headers.get('location')
    await res.body?.cancel().catch(() => {}) // free the redirect connection
    if (!loc) return null // opaque / malformed redirect → refuse to guess
    try {
      current = new URL(loc, current).toString()
    } catch {
      return null
    }
  }
  return null // exceeded the redirect budget
}
