import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Subscriber, SubscriberStore } from './subscriberStore'

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem backend for the weekly-brief subscriber list — Vite dev middleware
// only (Node runtime). Mirrors the Workers-KV backend so local and prod behave
// identically: the whole list in one JSON file under the gitignored .cache/.
//
// Isolated in this `.node.ts` file (imported only from vite.config.ts) so the
// `node:fs` import never reaches the Cloudflare Workers bundle.
// ─────────────────────────────────────────────────────────────────────────────

export function fileSubscriberStore(file: string): SubscriberStore {
  return {
    async get() {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        return Array.isArray(parsed) ? (parsed as Subscriber[]) : null
      } catch (e) {
        // Missing file = a legitimately empty list; anything else (perms, malformed
        // JSON) = unknown state → null, so callers never overwrite a list they
        // couldn't read.
        return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null
      }
    },
    async put(list) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        // Atomic write: stage to a temp file, then rename.
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(list), 'utf8')
        await fs.rename(tmp, file)
      } catch {
        // Disk full / permissions — best-effort, same contract as the KV backend.
      }
    },
  }
}
