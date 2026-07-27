import { kvReportStore, reportUrl } from '../../../server/reportStore'
import type { KVNamespace } from '../../../server/summaryStore'

// Cloudflare Pages Function → POST /api/report (production).
// Stores a client-generated weekly PDF and returns its hosted { id, url }. Used by
// the on-demand "Email this edition" flow: the browser already has jsPDF, so it
// renders the bytes, uploads them here, then sends a brief that links to the URL.
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

const MAX_BYTES = 10_000_000 // 10MB — a weekly PDF is ~50-300KB; this is a guard.

export const onRequestPost = async (context: { request: Request; env: { SUMMARIES?: KVNamespace; SITE_URL?: string } }): Promise<Response> => {
  const store = context.env?.SUMMARIES ? kvReportStore(context.env.SUMMARIES) : null
  if (!store) return json(503, { error: 'no_report_store' })
  const bytes = await context.request.arrayBuffer()
  if (!bytes.byteLength) return json(400, { error: 'empty' })
  if (bytes.byteLength > MAX_BYTES) return json(413, { error: 'too_large' })
  try {
    const id = await store.put(bytes)
    const origin = context.env?.SITE_URL || new URL(context.request.url).origin
    return json(200, { id, url: reportUrl(origin, id) })
  } catch {
    return json(502, { error: 'store_failed' })
  }
}
