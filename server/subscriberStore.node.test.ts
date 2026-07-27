import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applySubscribe, applyUnsubscribe, handleSubscribers, normalizeEmail, type Subscriber } from './subscriberStore'
import { fileSubscriberStore } from './subscriberStore.node'

// The weekly-brief subscriber list: the dev (filesystem) backend, the pure list
// operations, and the shared /api/subscriptions/weekly handler. Same data-loss
// guard as the channel roster: a failed READ must never let a write clobber the list.

describe('normalizeEmail', () => {
  it('trims, lowercases, and shape-checks', () => {
    expect(normalizeEmail('  Asha@Muns.IO ')).toBe('asha@muns.io')
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull() // no dot in domain
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
    expect(normalizeEmail(`${'x'.repeat(300)}@muns.io`)).toBeNull() // over the length cap
  })
})

describe('list operations', () => {
  it('subscribes (newest first), is idempotent, and records the user key', () => {
    const one = applySubscribe([], 'a@muns.io', 'asha@muns.io')!
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ email: 'a@muns.io', userKey: 'asha@muns.io' })

    const two = applySubscribe(one, 'B@MUNS.IO')!
    expect(two.map((s) => s.email)).toEqual(['b@muns.io', 'a@muns.io'])

    // Already present → SAME reference (so the caller skips a needless write).
    expect(applySubscribe(two, 'a@muns.io')).toBe(two)
    // Invalid → null.
    expect(applySubscribe(two, 'nope')).toBeNull()
  })

  it('unsubscribes, returning the same reference when nothing changed', () => {
    const list: Subscriber[] = [{ email: 'a@muns.io', addedAt: 'x' }, { email: 'b@muns.io', addedAt: 'y' }]
    expect(applyUnsubscribe(list, 'A@muns.io').map((s) => s.email)).toEqual(['b@muns.io'])
    expect(applyUnsubscribe(list, 'missing@muns.io')).toBe(list)
  })
})

describe('fileSubscriberStore', () => {
  const made: string[] = []
  async function tmpFile(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'munshot-subs-'))
    made.push(d)
    return path.join(d, 'subs.json')
  }
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  it('reads a missing file as an empty list, and round-trips', async () => {
    const store = fileSubscriberStore(await tmpFile())
    expect(await store.get()).toEqual([])
    const list: Subscriber[] = [{ email: 'a@muns.io', addedAt: 'now' }]
    await store.put(list)
    expect(await store.get()).toEqual(list)
  })

  it('returns null for an unreadable list, so the handler refuses to clobber it', async () => {
    const file = await tmpFile()
    await fs.writeFile(file, '{bad', 'utf8')
    expect(await fileSubscriberStore(file).get()).toBeNull()
    const { status } = await handleSubscribers(fileSubscriberStore(file), 'POST', JSON.stringify({ email: 'a@muns.io' }))
    expect(status).toBe(503)
    expect(await fs.readFile(file, 'utf8')).toBe('{bad') // untouched
  })
})

describe('handleSubscribers (the shared endpoint)', () => {
  const memStore = (initial: Subscriber[] = []) => {
    let list: Subscriber[] | null = initial
    return {
      store: { get: async () => list, put: async (l: Subscriber[]) => void (list = l) },
      current: () => list,
    }
  }

  it('GET returns a count, never the addresses', async () => {
    const { store } = memStore([{ email: 'a@muns.io', addedAt: 'x' }])
    const res = await handleSubscribers(store, 'GET', '')
    expect(res.body).toEqual({ count: 1 })
  })

  it('POST subscribes, DELETE unsubscribes, round-tripping through the store', async () => {
    const m = memStore()
    const sub = await handleSubscribers(m.store, 'POST', JSON.stringify({ email: 'a@muns.io' }), 'asha@muns.io')
    expect(sub.body).toEqual({ subscribed: true, email: 'a@muns.io' })
    expect(m.current()).toHaveLength(1)
    expect(m.current()![0].userKey).toBe('asha@muns.io')

    const unsub = await handleSubscribers(m.store, 'DELETE', JSON.stringify({ email: 'A@MUNS.IO' }))
    expect(unsub.body).toEqual({ subscribed: false, email: 'a@muns.io' })
    expect(m.current()).toHaveLength(0)
  })

  it('rejects an invalid email and bad JSON without writing', async () => {
    const m = memStore()
    expect((await handleSubscribers(m.store, 'POST', JSON.stringify({ email: 'nope' }))).status).toBe(400)
    expect((await handleSubscribers(m.store, 'POST', 'not json')).status).toBe(400)
    expect(m.current()).toEqual([])
  })

  it('GET degrades to count 0 without a store; mutations refuse with 503', async () => {
    expect(await handleSubscribers(null, 'GET', '')).toEqual({ status: 200, body: { count: 0 } })
    expect((await handleSubscribers(null, 'POST', '{}')).status).toBe(503)
  })
})
