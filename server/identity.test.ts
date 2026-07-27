import { describe, expect, it } from 'vitest'
import { canonicalUserKey, MAX_UID } from '../src/lib/identityKey'
import { userKeyFrom } from './identity'

describe('canonicalUserKey', () => {
  it('returns null for missing or blank input', () => {
    expect(canonicalUserKey(null)).toBeNull()
    expect(canonicalUserKey(undefined)).toBeNull()
    expect(canonicalUserKey('')).toBeNull()
    expect(canonicalUserKey('   ')).toBeNull()
    expect(canonicalUserKey('\t\n')).toBeNull()
  })

  it('passes already-canonical ids through unchanged (readable keys)', () => {
    expect(canonicalUserKey('usr_123')).toBe('usr_123')
    expect(canonicalUserKey('ceekay@muns.io')).toBe('ceekay@muns.io')
    expect(canonicalUserKey('a-b.c_d@e')).toBe('a-b.c_d@e')
  })

  it('returns null for identity-free punctuation', () => {
    expect(canonicalUserKey('..')).toBeNull()
    expect(canonicalUserKey('...')).toBeNull()
    expect(canonicalUserKey('---')).toBeNull()
    expect(canonicalUserKey('@')).toBeNull()
    expect(canonicalUserKey('._-')).toBeNull()
  })

  it('appends a hash whenever sanitization is lossy, keeping distinct raws distinct', () => {
    const upper = canonicalUserKey('Alice@Example.com')!
    const lower = canonicalUserKey('alice@example.com')!
    expect(upper).not.toBe(lower)
    expect(upper.startsWith('alice@example.com-')).toBe(true)

    // Case-sensitive opaque ids must not collide via case folding.
    expect(canonicalUserKey('usr_AbC')).not.toBe(canonicalUserKey('usr_abc'))

    // Two unicode names that sanitize to the same replacement chars stay distinct.
    const a = canonicalUserKey('usér')!
    const b = canonicalUserKey('usär')!
    expect(a).not.toBe(b)

    // Sanitized-garbage inputs become safe, distinct keys (not dotfiles, no slashes).
    const slashes = canonicalUserKey('///')!
    const hashes = canonicalUserKey('###')!
    expect(slashes).not.toBe(hashes)
    for (const k of [slashes, hashes]) expect(k).toMatch(/^[a-z0-9@._-]+$/)
  })

  it('caps length and never truncates the hash suffix', () => {
    const long = `user-${'x'.repeat(200)}@example.com`
    const longer = `user-${'x'.repeat(201)}@example.com`
    const k1 = canonicalUserKey(long)!
    const k2 = canonicalUserKey(longer)!
    expect(k1.length).toBeLessThanOrEqual(MAX_UID)
    expect(k2.length).toBeLessThanOrEqual(MAX_UID)
    expect(k1).not.toBe(k2) // differ only in the (hashed) tail that truncation drops
    expect(k1).toMatch(/-[a-z0-9]+$/) // hash survives intact at the end
  })

  it('is idempotent: canonicalizing an output returns it unchanged', () => {
    const inputs = ['usr_123', 'ceekay@muns.io', 'Alice@Example.com', 'usér', `id-${'y'.repeat(300)}`, '///']
    for (const raw of inputs) {
      const once = canonicalUserKey(raw)
      expect(canonicalUserKey(once)).toBe(once)
    }
  })

  it('is deterministic', () => {
    expect(canonicalUserKey('Alice@Example.com')).toBe(canonicalUserKey('Alice@Example.com'))
  })
})

describe('userKeyFrom', () => {
  it('mirrors the canonicalizer for header values', () => {
    expect(userKeyFrom(null)).toBeNull()
    expect(userKeyFrom(undefined)).toBeNull()
    expect(userKeyFrom('alice')).toBe('alice')
    expect(userKeyFrom('Alice')).toBe(canonicalUserKey('Alice'))
  })
})
