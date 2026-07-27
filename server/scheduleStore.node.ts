import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizeSchedule, type ScheduleStore } from './scheduleStore'

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem backend for the weekly-digest schedule — Vite dev middleware only
// (Node runtime). Mirrors the Workers-KV backend: one JSON file ({ schedule,
// lastSent }) under the gitignored .cache/. Kept in a `.node.ts` so the node:fs
// import never reaches the Cloudflare Workers bundle.
// ─────────────────────────────────────────────────────────────────────────────

export function fileScheduleStore(file: string): ScheduleStore {
  const read = async (): Promise<{ schedule?: unknown; lastSent?: string }> => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as { schedule?: unknown; lastSent?: string }) : {}
    } catch {
      return {}
    }
  }
  const write = async (data: object): Promise<void> => {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
      await fs.rename(tmp, file)
    } catch {
      /* best-effort — same contract as the KV backend */
    }
  }
  return {
    async getSchedule() {
      return normalizeSchedule((await read()).schedule)
    },
    async putSchedule(s) {
      await write({ ...(await read()), schedule: s })
    },
    async getLastSent() {
      return (await read()).lastSent ?? null
    },
    async setLastSent(dateStr) {
      await write({ ...(await read()), lastSent: dateStr })
    },
  }
}
