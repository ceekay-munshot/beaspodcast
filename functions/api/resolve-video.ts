import { resolveVideoId } from '../../server/resolveVideo'
import type { KVNamespace } from '../../server/summaryStore'

// Cloudflare Pages Function → GET /api/resolve-video?q=<show + episode title>.
// Returns { videoId } (or { videoId: null }) for the in-app YouTube player.
// Mirrors the Vite dev middleware; both call server/resolveVideo.ts. Cached at
// the edge: the same episode resolves once, everyone else gets the cached hit.
export const onRequestGet = async (context: { request: Request; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  let videoId: string | null = null
  try {
    const q = new URL(context.request.url).searchParams.get('q') ?? ''
    videoId = await resolveVideoId(q, context.env?.SUMMARIES)
  } catch {
    videoId = null
  }
  return new Response(JSON.stringify({ videoId }), {
    headers: {
      'content-type': 'application/json',
      // Misses may be transient (bot-wall) — keep them short; hits can live long.
      'cache-control': videoId ? 'public, max-age=3600, s-maxage=604800' : 'public, max-age=120',
    },
  })
}
