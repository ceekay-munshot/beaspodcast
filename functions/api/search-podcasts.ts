import { searchPodcasts } from '../../server/search'

// Cloudflare Pages Function → GET /api/search-podcasts?q=… (production).
// Mirrors the Vite dev middleware; both call the shared server/search.ts.
// Plain-text searches with results are edge-cacheable; a URL query is per-user
// and an empty list is usually an upstream refusal — neither may be cached, or
// a blip would pin "no results" in every browser for minutes.
export const onRequestGet = async (context: { request: Request }): Promise<Response> => {
  try {
    const params = new URL(context.request.url).searchParams
    const q = (params.get('q') ?? '').trim()
    const isUrl = /^https?:\/\//i.test(q)
    const results = await searchPodcasts(q, Number(params.get('limit')) || undefined)
    return new Response(JSON.stringify(results), {
      headers: {
        'content-type': 'application/json',
        'cache-control': isUrl || results.length === 0 ? 'no-store' : 'public, max-age=300, s-maxage=900',
      },
    })
  } catch {
    return new Response('[]', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
}
