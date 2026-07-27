import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SummarizeResult } from './summarize'
import type { SummaryStore } from './summaryStore'

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem backend for the shared summary store — used by the Vite dev
// middleware only (Node runtime). Mirrors the Workers-KV backend so local and
// prod behave identically: one JSON file per key under a gitignored dir, so a
// summary generated once is reused across reloads and across every browser that
// hits the same dev server.
//
// Isolated in this `.node.ts` file (imported only from vite.config.ts) so the
// `node:fs` import never reaches the Cloudflare Workers bundle.
// ─────────────────────────────────────────────────────────────────────────────

// Map a cache key to a safe, flat filename: `sum:r4:live-allin-abc` → `sum_r4_live-allin-abc.json`.
function fileFor(dir: string, key: string): string {
  return path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function fileSummaryStore(dir: string): SummaryStore {
  return {
    async get(key) {
      try {
        return JSON.parse(await fs.readFile(fileFor(dir, key), 'utf8')) as SummarizeResult
      } catch {
        return null // missing file or malformed JSON (e.g. read during a write)
      }
    },
    async put(key, value) {
      try {
        await fs.mkdir(dir, { recursive: true })
        const target = fileFor(dir, key)
        // Atomic write: stage to a temp file, then rename, so a concurrent reader
        // never observes a half-written file.
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(value), 'utf8')
        await fs.rename(tmp, target)
      } catch {
        // Disk full / permissions — best-effort, same contract as the KV backend.
      }
    },
  }
}
