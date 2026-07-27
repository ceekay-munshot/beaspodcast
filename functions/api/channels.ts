import { channelsKeyFor, handleChannels, kvChannelStore } from '../../server/channelStore'
import { USER_HEADER, userKeyFrom } from '../../server/identity'
import { SEED_IDS } from '../../server/feeds'
import type { KVNamespace } from '../../server/summaryStore'

// Cloudflare Pages Function → /api/channels (production).
// The durable channel roster — which shows are tracked, including user-added
// ones — lives in the SUMMARIES KV namespace (no TTL) and survives deploys.
// Requests carrying the Munshot identity header get their OWN roster
// (`u:<uid>:channels:v1`); anonymous requests keep the legacy global
// `channels:v1`. Mirrors the Vite dev middleware; both call the shared
// server/channelStore.ts.
//   GET  → the roster (always no-store: per-user, and a deploy must never serve a stale list)
//   POST → upsert one channel  { podcast: Podcast }   (tracked:false = untrack)
//   PUT  → bulk merge          { podcasts: Podcast[] } (one-time localStorage migration)
export const onRequest = async (context: { request: Request; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  let result: { status: number; body: unknown }
  try {
    const uid = userKeyFrom(context.request.headers.get(USER_HEADER))
    const store = context.env?.SUMMARIES ? kvChannelStore(context.env.SUMMARIES, channelsKeyFor(uid)) : null
    result = await handleChannels(store, context.request.method, await context.request.text(), SEED_IDS)
  } catch {
    result = { status: 500, body: { error: 'channels_failed' } }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
