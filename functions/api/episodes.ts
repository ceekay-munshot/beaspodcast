import { episodesForFeed, getLiveEpisodes } from '../../server/feeds'
import { kvSummaryStore, type KVNamespace } from '../../server/summaryStore'

// Cloudflare Pages Function → GET /api/episodes (production).
// Mirrors the Vite dev middleware; both call the shared server/feeds.ts.
//   default                → all seed shows' recent episodes (edge-cached). The
//                            SUMMARIES KV binding (when present) overlays episodes
//                            already processed by any user as READY — shared state.
//   ?feed=<url>&id=<podId> → recent episodes for ONE user-added feed (no-store,
//                            per-user; SSRF-validated inside episodesForFeed).
export const onRequestGet = async (context: { request: Request; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  try {
    const params = new URL(context.request.url).searchParams
    const feed = params.get('feed')
    const id = params.get('id')
    const store = context.env?.SUMMARIES ? kvSummaryStore(context.env.SUMMARIES) : undefined
    if (feed && id) {
      // The store rides along so episodes already processed by ANY user come
      // back READY here too — same shared-state overlay as the seed path.
      return new Response(JSON.stringify(await episodesForFeed(feed, id, store)), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    const episodes = await getLiveEpisodes(store)
    return new Response(JSON.stringify(episodes), {
      headers: {
        'content-type': 'application/json',
        // Cache at the edge for 15 min so feed fetches aren't repeated per visit.
        'cache-control': 'public, max-age=300, s-maxage=900',
      },
    })
  } catch {
    return new Response('[]', { headers: { 'content-type': 'application/json' } })
  }
}
