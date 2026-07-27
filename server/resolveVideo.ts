import type { KVNamespace } from './summaryStore'

// ─────────────────────────────────────────────────────────────────────────────
// "<show> <episode title>" → the top YouTube video id.
//
// YouTube-surfaced shows that syndicate over plain RSS (e.g. All-In) have no
// per-episode video link, so Watch on YouTube used to open a results-page tab.
// That breaks inside the chat.muns.io dashboard: the widget iframe is sandboxed
// WITHOUT allow-popups-to-escape-sandbox, popups inherit the sandbox, and
// youtube.com refuses to render in a sandboxed context (ERR_BLOCKED_BY_RESPONSE).
// Resolving the id server-side lets the client play every episode in the in-app
// /embed/ modal — the one YouTube surface built for iframes — popup-free.
//
// Resolution scrapes the results page for the first organic hit. Best-effort by
// design: a bot-wall or layout change returns null and the UI degrades to the
// old external link. Hits are cached (in-isolate + KV, 7 days); misses only
// in-isolate, so a transient block never sticks.
// ─────────────────────────────────────────────────────────────────────────────

/** First organic result's video id. Promoted slots use "promotedVideoRenderer"
 *  (no leading quote before `videoRenderer`), so this regex skips ads. */
export function extractFirstVideoId(html: string): string | null {
  const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/)
  return m ? m[1] : null
}

const memo = new Map<string, string | null>() // per-isolate; misses live only here

export async function resolveVideoId(query: string, kv?: KVNamespace): Promise<string | null> {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!q) return null
  const key = `ytv:1:${q.toLowerCase()}`
  if (memo.has(key)) return memo.get(key) ?? null
  if (kv) {
    try {
      const hit = await kv.get(key, 'json')
      if (typeof hit === 'string' && hit) {
        memo.set(key, hit)
        return hit
      }
    } catch {
      /* KV read failure → resolve fresh */
    }
  }
  let id: string | null = null
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en`, {
      headers: {
        'accept-language': 'en',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
    })
    if (res.ok) id = extractFirstVideoId(await res.text())
  } catch {
    /* network error / timeout → null, client falls back to the external link */
  }
  memo.set(key, id)
  if (kv && id) {
    try {
      await kv.put(key, JSON.stringify(id), { expirationTtl: 60 * 60 * 24 * 7 })
    } catch {
      /* best-effort cache */
    }
  }
  return id
}
