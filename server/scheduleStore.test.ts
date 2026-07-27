import { describe, it, expect } from 'vitest'
import { normalizeSchedule, localParts, dueToSend, isValidTimezone, DEFAULT_SCHEDULE, type WeeklySchedule } from './scheduleStore'

// 2024-01-01 is a Monday. 03:30 UTC = 09:00 in Asia/Kolkata (UTC+5:30).
const MON_0900_IST = new Date('2024-01-01T03:30:00Z')
const IST: WeeklySchedule = { dayOfWeek: 1, hour: 9, minute: 0, timezone: 'Asia/Kolkata' }

describe('normalizeSchedule', () => {
  it('accepts a valid schedule', () => {
    expect(normalizeSchedule({ dayOfWeek: 3, hour: 17, minute: 30, timezone: 'Europe/London' })).toEqual({ dayOfWeek: 3, hour: 17, minute: 30, timezone: 'Europe/London' })
  })
  it('rejects out-of-range parts', () => {
    expect(normalizeSchedule({ dayOfWeek: 7, hour: 9, minute: 0, timezone: 'UTC' })).toBeNull()
    expect(normalizeSchedule({ dayOfWeek: 1, hour: 24, minute: 0, timezone: 'UTC' })).toBeNull()
    expect(normalizeSchedule({ dayOfWeek: 1, hour: 9, minute: 60, timezone: 'UTC' })).toBeNull()
  })
  it('rejects an unknown timezone and non-objects', () => {
    expect(normalizeSchedule({ dayOfWeek: 1, hour: 9, minute: 0, timezone: 'Mars/Phobos' })).toBeNull()
    expect(normalizeSchedule(null)).toBeNull()
    expect(normalizeSchedule('nope')).toBeNull()
  })
})

describe('isValidTimezone', () => {
  it('knows real zones from fake ones', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('Not/AZone')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })
})

describe('localParts', () => {
  it('converts a UTC instant into the target zone parts', () => {
    expect(localParts(MON_0900_IST, 'Asia/Kolkata')).toEqual({ dow: 1, hour: 9, minute: 0, dateStr: '2024-01-01' })
  })
  it('reflects the zone offset (same instant, different zone)', () => {
    // 03:30 UTC is still Monday, 03:30, in UTC.
    expect(localParts(MON_0900_IST, 'UTC')).toMatchObject({ dow: 1, hour: 3, minute: 30 })
  })
})

describe('dueToSend', () => {
  it('is due on the chosen weekday at/after the chosen local time', () => {
    expect(dueToSend(IST, MON_0900_IST, null)).toEqual({ due: true, dateStr: '2024-01-01' })
  })
  it('is NOT due before the chosen time', () => {
    const before = new Date('2024-01-01T03:00:00Z') // 08:30 IST
    expect(dueToSend(IST, before, null).due).toBe(false)
  })
  it('is NOT due on a different weekday', () => {
    expect(dueToSend({ ...IST, dayOfWeek: 2 }, MON_0900_IST, null).due).toBe(false)
  })
  it('is NOT due again once already sent on that local date (idempotent)', () => {
    expect(dueToSend(IST, MON_0900_IST, '2024-01-01').due).toBe(false)
  })
  it('the default schedule fires Monday 13:00 UTC (the old hard-coded behaviour)', () => {
    expect(DEFAULT_SCHEDULE).toEqual({ dayOfWeek: 1, hour: 13, minute: 0, timezone: 'UTC' })
    expect(dueToSend(DEFAULT_SCHEDULE, new Date('2024-01-01T13:00:00Z'), null).due).toBe(true)
    expect(dueToSend(DEFAULT_SCHEDULE, new Date('2024-01-01T12:30:00Z'), null).due).toBe(false)
  })
})
