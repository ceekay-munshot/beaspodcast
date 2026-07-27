import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Podcast } from '../src/lib/types'
import type { ChannelStore } from './channelStore'

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem backend for the durable channel roster — Vite dev middleware only
// (Node runtime). Mirrors the Workers-KV backend so local and prod behave
// identically: the whole roster in one JSON file under the gitignored .cache/.
//
// Isolated in this `.node.ts` file (imported only from vite.config.ts) so the
// `node:fs` import never reaches the Cloudflare Workers bundle.
// ─────────────────────────────────────────────────────────────────────────────

export function fileChannelStore(file: string): ChannelStore {
  return {
    async get() {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        return Array.isArray(parsed) ? (parsed as Podcast[]) : null
      } catch (e) {
        // Missing file = a legitimately empty roster; anything else (perms,
        // malformed JSON) = unknown state → null, so callers never overwrite
        // a roster they couldn't read.
        return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null
      }
    },
    async put(list) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        // Atomic write: stage to a temp file, then rename, so a concurrent
        // reader never observes a half-written roster.
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(list), 'utf8')
        await fs.rename(tmp, file)
      } catch {
        // Disk full / permissions — best-effort, same contract as the KV backend.
      }
    },
  }
}
