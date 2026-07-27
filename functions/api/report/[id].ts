import { kvReportStore, REPORT_TTL_SECONDS } from '../../../server/reportStore'
import type { KVNamespace } from '../../../server/summaryStore'
import { contentDispositionInline, REPORT_DL_PARAM } from '../../../src/lib/reportName'

// Cloudflare Pages Function → GET /api/report/:id (production).
// Serves a hosted weekly-brief PDF that the emailed brief links to. Bytes live in
// the SUMMARIES KV namespace under rpt:<id> (see server/reportStore.ts).
export const onRequestGet = async (context: { request: Request; params: { id?: string }; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  const id = String(context.params?.id ?? '').replace(/\.pdf$/i, '')
  const store = context.env?.SUMMARIES ? kvReportStore(context.env.SUMMARIES) : null
  const bytes = store ? await store.get(id) : null
  if (!bytes) return new Response('Report not found or expired.', { status: 404, headers: { 'content-type': 'text/plain' } })
  // The dated brand filename rides along as `?dl=` (set when the link is built); fall
  // back to a generic branded name when it's absent rather than a bare slug.
  const downloadName = new URL(context.request.url).searchParams.get(REPORT_DL_PARAM)
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': contentDispositionInline(downloadName),
      // Content-hash ids are immutable, so cache hard for the report's lifetime.
      'cache-control': `public, max-age=${REPORT_TTL_SECONDS}, immutable`,
    },
  })
}
