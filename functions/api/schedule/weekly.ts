import { handleSchedule, kvScheduleStore } from '../../../server/scheduleStore'
import type { KVNamespace } from '../../../server/summaryStore'

// Cloudflare Pages Function → /api/schedule/weekly (production).
// Reads/writes the global weekly-digest send schedule (day · time · timezone) in
// the SUMMARIES KV namespace — the cron endpoint gates the Monday send on it.
//   GET → { schedule }      (the effective schedule, defaulted to Mon 13:00 UTC)
//   PUT → { dayOfWeek, hour, minute, timezone } → { schedule } | 400 invalid
// Mirrors the Vite dev middleware; both call the shared server/scheduleStore.ts.
export const onRequest = async (context: { request: Request; env: { SUMMARIES?: KVNamespace } }): Promise<Response> => {
  let result: { status: number; body: unknown }
  try {
    const store = context.env?.SUMMARIES ? kvScheduleStore(context.env.SUMMARIES) : null
    const method = context.request.method
    const rawBody = method === 'GET' ? '' : await context.request.text()
    result = await handleSchedule(store, method, rawBody)
  } catch {
    result = { status: 500, body: { error: 'schedule_failed' } }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
