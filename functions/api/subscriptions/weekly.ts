import { handleSubscribers, kvSubscriberStore } from '../../../server/subscriberStore'
import { USER_HEADER, userKeyFrom } from '../../../server/identity'
import type { KVNamespace } from '../../../server/summaryStore'

// Cloudflare Pages Function → /api/subscriptions/weekly (production).
// The durable weekly-brief subscriber list lives in the SUMMARIES KV namespace
// (no TTL) so the scheduled Monday digest can reach everyone. One global list
// (the chosen "one shared edition for everyone" design), so it is NOT scoped by
// the identity header — but a signed-in subscriber's user key is recorded.
// Mirrors the Vite dev middleware; both call the shared server/subscriberStore.ts.
//   GET    → { count }                 (never the addresses)
//   POST   → subscribe   { email }     → { subscribed: true,  email }
//   DELETE → unsubscribe { email }     → { subscribed: false, email }
export const onRequest = async (context: { request: Request; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  let result: { status: number; body: unknown }
  try {
    const uid = userKeyFrom(context.request.headers.get(USER_HEADER))
    const store = context.env?.SUMMARIES ? kvSubscriberStore(context.env.SUMMARIES) : null
    const method = context.request.method
    const rawBody = method === 'GET' ? '' : await context.request.text()
    result = await handleSubscribers(store, method, rawBody, uid)
  } catch {
    result = { status: 500, body: { error: 'subscribers_failed' } }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
