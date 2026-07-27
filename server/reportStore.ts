import type { KVNamespace } from './summaryStore'
import { withReportDownloadName } from '../src/lib/reportName'

// ─────────────────────────────────────────────────────────────────────────────
// Hosted PDF report store — the weekly brief's deliverable.
//
// The raw-email endpoint can't carry attachments, so we generate the real .pdf,
// store its bytes on our own domain, and email a link. Reports are keyed by a
// sha-256 of their CONTENT (so identical editions dedupe and the link is stable)
// and expire after 30 days — long enough to read this week's brief, short enough
// to keep the KV value store from growing without bound.
//
//   • Production (Pages Function): Workers KV (`SUMMARIES`), value = raw bytes.
//   • Local dev (Vite middleware): an in-process Map (see vite.config.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const REPORT_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const REPORT_PREFIX = 'rpt:'

/** Content-hash id for a PDF — identical bytes ⇒ identical id ⇒ stable, dedup link. */
export async function reportId(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

export interface ReportStore {
  /** Store the PDF bytes; resolves to the content-hash id used in the URL. */
  put(bytes: ArrayBuffer): Promise<string>
  /** Fetch stored PDF bytes by id, or null on a miss. */
  get(id: string): Promise<ArrayBuffer | null>
}

/** Cloudflare Workers KV backend (production). */
export function kvReportStore(kv: KVNamespace): ReportStore {
  return {
    async put(bytes) {
      const id = await reportId(bytes)
      await kv.put(`${REPORT_PREFIX}${id}`, bytes, { expirationTtl: REPORT_TTL_SECONDS })
      return id
    },
    async get(id) {
      // Reject anything that isn't a clean hex id (defends the KV key space).
      if (!/^[a-f0-9]{8,40}$/.test(id)) return null
      try {
        return (await kv.get(`${REPORT_PREFIX}${id}`, 'arrayBuffer')) ?? null
      } catch {
        return null
      }
    },
  }
}

/** Absolute, click-from-an-inbox URL for a stored report. The cron has no request,
 *  so `SITE_URL` is the source of truth there; the on-demand path can fall back to
 *  the request origin. An optional `downloadName` rides along as `?dl=` so the GET
 *  endpoint can serve the bytes with a proper "Munshot AI Podcasts — <week>.pdf". */
export function reportUrl(origin: string, id: string, downloadName?: string): string {
  const url = `${origin.replace(/\/$/, '')}/api/report/${id}`
  return downloadName ? withReportDownloadName(url, downloadName) : url
}
