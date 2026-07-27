import type { KVNamespace } from './summaryStore'
import type { WeeklySchedule } from '../src/lib/types'

export type { WeeklySchedule }

// ─────────────────────────────────────────────────────────────────────────────
// Weekly-digest SEND SCHEDULE — the day/time/timezone the Monday brief goes out.
//
// Cloudflare Pages can't run cron, and GitHub Actions cron is a fixed UTC string
// in YAML — neither is changeable from the app. So instead the workflow pings
// /api/cron/weekly-digest every 30 min, and the endpoint GATES the actual send on
// THIS schedule (see dueToSend): it fires on the chosen weekday at/after the chosen
// local time, once per week, recording a `lastSent` date marker for idempotency.
//
// One global value (the same "one shared edition for everyone" design as the
// subscriber list), stored in the SUMMARIES KV namespace. Until a user sets it,
// DEFAULT_SCHEDULE reproduces the previous hard-coded behaviour (Mon 13:00 UTC).
// ─────────────────────────────────────────────────────────────────────────────

/** Reproduces the old hard-coded cron (Mondays 13:00 UTC) until a user picks one. */
export const DEFAULT_SCHEDULE: WeeklySchedule = { dayOfWeek: 1, hour: 13, minute: 0, timezone: 'UTC' }

export const SCHEDULE_KEY = 'weekly:schedule:v1'
export const LAST_SENT_KEY = 'weekly:last-sent:v1'

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** True when `tz` is a timezone the runtime's Intl understands. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Coerce untrusted input into a valid schedule, or null when it can't be trusted. */
export function normalizeSchedule(raw: unknown): WeeklySchedule | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : NaN)
  const dayOfWeek = int(r.dayOfWeek)
  const hour = int(r.hour)
  const minute = int(r.minute)
  if (!(dayOfWeek >= 0 && dayOfWeek <= 6)) return null
  if (!(hour >= 0 && hour <= 23)) return null
  if (!(minute >= 0 && minute <= 59)) return null
  if (!isValidTimezone(r.timezone)) return null
  return { dayOfWeek, hour, minute, timezone: r.timezone }
}

/** The current weekday/hour/minute and local date (YYYY-MM-DD) in `tz`. */
export function localParts(now: Date, tz: string): { dow: number; hour: number; minute: number; dateStr: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    dow: DOW[get('weekday')] ?? 0,
    hour: parseInt(get('hour'), 10) % 24, // some engines emit "24" at midnight
    minute: parseInt(get('minute'), 10) || 0,
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/**
 * Decide whether the digest is due right now. Due when, in the schedule's timezone,
 * it's the chosen weekday, the local time is at/after the chosen time, and we haven't
 * already sent on this local date. `dateStr` is the marker to persist on a send.
 */
export function dueToSend(schedule: WeeklySchedule, now: Date, lastSent: string | null): { due: boolean; dateStr: string } {
  const p = localParts(now, schedule.timezone)
  if (p.dow !== schedule.dayOfWeek) return { due: false, dateStr: p.dateStr }
  if (p.hour * 60 + p.minute < schedule.hour * 60 + schedule.minute) return { due: false, dateStr: p.dateStr }
  if (lastSent === p.dateStr) return { due: false, dateStr: p.dateStr }
  return { due: true, dateStr: p.dateStr }
}

export interface ScheduleStore {
  getSchedule(): Promise<WeeklySchedule | null>
  putSchedule(s: WeeklySchedule): Promise<void>
  getLastSent(): Promise<string | null>
  setLastSent(dateStr: string): Promise<void>
}

/** Cloudflare Workers KV backend (production). */
export function kvScheduleStore(kv: KVNamespace): ScheduleStore {
  return {
    async getSchedule() {
      try {
        return normalizeSchedule(await kv.get(SCHEDULE_KEY, 'json'))
      } catch {
        return null
      }
    },
    async putSchedule(s) {
      await kv.put(SCHEDULE_KEY, JSON.stringify(s))
    },
    async getLastSent() {
      try {
        return (await kv.get(LAST_SENT_KEY)) || null
      } catch {
        return null
      }
    },
    async setLastSent(dateStr) {
      // 8-day TTL: outlives the week so a same-day re-tick is suppressed, expires
      // before the next week's slot so it never blocks it.
      await kv.put(LAST_SENT_KEY, dateStr, { expirationTtl: 60 * 60 * 24 * 8 })
    },
  }
}

/** The /api/schedule/weekly endpoint, runtime-agnostic (Pages Function + dev mirror).
 *   GET → { schedule }                         (the effective schedule, defaulted)
 *   PUT → { dayOfWeek, hour, minute, timezone } → { schedule } | 400 invalid */
export async function handleSchedule(store: ScheduleStore | null, method: string, rawBody: string): Promise<{ status: number; body: unknown }> {
  if (method === 'GET') {
    const schedule = (store ? await store.getSchedule() : null) ?? DEFAULT_SCHEDULE
    return { status: 200, body: { schedule } }
  }
  if (method !== 'PUT' && method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  if (!store) return { status: 503, body: { error: 'no_schedule_store' } }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody || '{}')
  } catch {
    return { status: 400, body: { error: 'bad_json' } }
  }
  const schedule = normalizeSchedule(parsed)
  if (!schedule) return { status: 400, body: { error: 'invalid_schedule' } }
  await store.putSchedule(schedule)
  return { status: 200, body: { schedule } }
}
