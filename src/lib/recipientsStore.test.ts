import { describe, it, expect, beforeEach } from 'vitest'
import { isValidEmail, computeAdd, normalizeRecipients, loadRecipients, addRecipient, removeRecipient } from './recipientsStore'

// The store persists to localStorage; the node test env has none, so back it with a Map.
const mem = new Map<string, string>()
beforeEach(() => mem.clear())
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage

describe('isValidEmail', () => {
  it('accepts a normal address and rejects junk / list-smuggling', () => {
    expect(isValidEmail('a@b.co')).toBe(true)
    expect(isValidEmail('not-an-email')).toBe(false)
    expect(isValidEmail('a@b.co, c@d.co')).toBe(false) // a comma can't smuggle a 2nd recipient
    expect(isValidEmail('a@b.co\nbcc: x@y.co')).toBe(false) // no header-injection newline
  })
})

describe('computeAdd — pure validation/dedupe/cap', () => {
  it('adds a valid new address', () => {
    expect(computeAdd([], 'alice@x.com')).toEqual({ ok: true, list: ['alice@x.com'] })
  })
  it('trims and rejects invalid input', () => {
    expect(computeAdd([], '  nope ').ok).toBe(false)
  })
  it('rejects a case-insensitive duplicate', () => {
    const res = computeAdd(['Alice@X.com'], 'alice@x.com')
    expect(res.ok).toBe(false)
    expect(res.list).toEqual(['Alice@X.com'])
  })
  it('caps the list at 20', () => {
    const full = Array.from({ length: 20 }, (_, i) => `u${i}@x.com`)
    expect(computeAdd(full, 'one-more@x.com').ok).toBe(false)
  })
})

describe('normalizeRecipients — final send set', () => {
  it('puts the user first and de-dupes against the extras (case-insensitive)', () => {
    expect(normalizeRecipients('me@x.com', ['Me@X.com', 'a@x.com', 'a@x.com'])).toEqual(['me@x.com', 'a@x.com'])
  })
  it('drops blanks and invalid addresses', () => {
    expect(normalizeRecipients('me@x.com', ['', 'bad', 'good@x.com'])).toEqual(['me@x.com', 'good@x.com'])
  })
  it('works with no self', () => {
    expect(normalizeRecipients(null, ['a@x.com'])).toEqual(['a@x.com'])
  })
})

describe('addRecipient / loadRecipients / removeRecipient — persisted', () => {
  it('round-trips through storage and de-dupes', () => {
    expect(addRecipient('alice@x.com').ok).toBe(true)
    expect(addRecipient('bob@x.com').ok).toBe(true)
    expect(loadRecipients()).toEqual(['alice@x.com', 'bob@x.com'])
    expect(addRecipient('ALICE@x.com').ok).toBe(false) // dupe
    removeRecipient('Alice@X.com') // case-insensitive remove
    expect(loadRecipients()).toEqual(['bob@x.com'])
  })
  it('persists invalid-free: malformed stored rows are dropped on load', () => {
    mem.set('munshot:weekly-recipients:v1', JSON.stringify(['ok@x.com', 'garbage', 42]))
    expect(loadRecipients()).toEqual(['ok@x.com'])
  })
})
