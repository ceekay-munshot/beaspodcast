import { isPublicHttpUrl, safeFetch } from '../../../server/safeUrl'

// Cloudflare Pages Function → GET /api/health/transcribe
//
// Answers "why is the Transcript tab still empty?" — the question the normal
// pipeline cannot answer for you, because server/transcribe.ts deliberately
// swallows every transcription failure (`if (!res.ok) return empty`) and falls
// back to show-notes. That is right for production (a dead provider must never
// break a summary) but it means a bad key, an exhausted balance and an
// unreachable audio file all look identical from the outside: nothing happens.
//
// Two checks, neither of which spends transcription credit:
//
//   1. Is the Deepgram key valid? Calls Deepgram's own /v1/projects endpoint,
//      which just authenticates — no audio, no cost, instant.
//   2. (optional, ?url=<audio>) Can the audio actually be fetched? Podcast CDNs
//      sometimes reject non-browser clients, which Deepgram would hit too.
//
// The key is read from the `env` binding and never appears in the response; any
// echoed provider text is scrubbed of it and truncated.

interface TranscribeHealthEnv {
  DEEPGRAM_API_KEY?: string
  GROQ_API_KEY?: string
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/** Never let a key reach the client, even via an upstream error body. */
const scrub = (text: string, key: string | undefined): string =>
  (key && key.length >= 8 ? text.split(key).join('[redacted]') : text).slice(0, 300)

/** What a Deepgram auth status actually means, in words the caller can act on. */
function explainKey(status: number): string {
  if (status === 200) return 'Key is valid.'
  if (status === 401) return 'Key is invalid or was copied incorrectly (Deepgram rejected it).'
  if (status === 403) return 'Key is valid but lacks permission for this project.'
  if (status === 402) return 'Key is valid but the account is out of credit.'
  return `Deepgram returned an unexpected status (${status}).`
}

export const onRequestGet = async (context: { request: Request; env: TranscribeHealthEnv }): Promise<Response> => {
  const key = context.env?.DEEPGRAM_API_KEY
  const audioUrl = new URL(context.request.url).searchParams.get('url')

  if (!key) {
    return json(503, {
      ok: false,
      error: 'no_deepgram_key',
      detail: 'DEEPGRAM_API_KEY is not bound to this deployment. Add it, then redeploy.',
    })
  }

  // ── 1. Validate the key (authentication only — no audio, no credit) ────────
  let keyValid = false
  let keyStatus = 0
  let keyDetail = ''
  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { authorization: `Token ${key}` },
    })
    keyStatus = res.status
    keyValid = res.ok
    keyDetail = res.ok ? explainKey(200) : `${explainKey(res.status)} ${scrub(await res.text().catch(() => ''), key)}`.trim()
  } catch (e) {
    keyDetail = `Could not reach Deepgram: ${scrub(String(e), key)}`
  }

  // ── 2. Optionally check the episode audio is actually fetchable ────────────
  let audio: Record<string, unknown> | undefined
  if (audioUrl) {
    if (!isPublicHttpUrl(audioUrl)) {
      audio = { checked: true, reachable: false, detail: 'Not a valid public http(s) URL.' }
    } else {
      // safeFetch re-validates every redirect hop, so this can't be used to probe
      // private addresses. GET (not HEAD) because some podcast CDNs reject HEAD.
      const res = await safeFetch(audioUrl, { method: 'GET' })
      if (!res) {
        audio = { checked: true, reachable: false, detail: 'Could not fetch the audio (blocked, bad redirect, or network error).' }
      } else {
        const len = Number(res.headers.get('content-length') || 0)
        await res.body?.cancel().catch(() => {}) // don't download the episode
        audio = {
          checked: true,
          reachable: res.ok,
          status: res.status,
          contentType: res.headers.get('content-type') || 'unknown',
          ...(len ? { sizeMb: Math.round((len / 1024 / 1024) * 10) / 10 } : {}),
          ...(res.ok ? {} : { detail: 'The audio host rejected the request — Deepgram would be refused too.' }),
        }
      }
    }
  }

  const ok = keyValid && (!audio || audio.reachable === true)
  return json(ok ? 200 : 502, {
    ok,
    deepgram: { configured: true, keyValid, status: keyStatus, detail: keyDetail },
    ...(audio ? { audio } : { audio: 'not checked — add ?url=<episode audio url> to test one' }),
  })
}
