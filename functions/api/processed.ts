import { handleProcessed, kvProcessedStore, processedKeyFor } from '../../server/processedStore'
import { kvSummaryStore, type KVNamespace } from '../../server/summaryStore'
import { USER_HEADER, userKeyFrom } from '../../server/identity'

// Cloudflare Pages Function → /api/processed (production).
// The PER-USER processed-episode history (lean entries, no summaries) lives in
// the SUMMARIES KV namespace at `u:<uid>:processed:v1`; GETs re-hydrate each
// entry against the global shared summary cache so an episode processed by ANY
// user comes back ready. Anonymous requests have no history here (GET → [],
// POST → 401) — their history stays in the browser, exactly as before.
// Mirrors the Vite dev middleware; both call the shared server/processedStore.ts.
//   GET  → the user's history as Episode[] (summary attached, transcript lazy)
//   POST → upsert one entry { episode: Episode-ish }
export const onRequest = async (context: { request: Request; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  let result: { status: number; body: unknown }
  try {
    const kv = context.env?.SUMMARIES
    const uid = userKeyFrom(context.request.headers.get(USER_HEADER))
    const store = kv && uid ? kvProcessedStore(kv, processedKeyFor(uid)) : null
    const summaries = kv ? kvSummaryStore(kv) : null
    result = await handleProcessed(store, summaries, context.request.method, await context.request.text())
  } catch {
    result = { status: 500, body: { error: 'processed_failed' } }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    // Per-user payload — must never be cached at the edge or shared between users.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
