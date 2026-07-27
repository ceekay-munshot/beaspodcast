import type { Episode } from '../src/lib/types'
import { EPISODES } from '../src/lib/mock-data'
import { sharedSummaryKey, type SummaryStore } from './summaryStore'
import { isPublicHttpUrl, safeFetch } from './safeUrl'

// ─────────────────────────────────────────────────────────────────────────────
// Live feed fetching — runtime-agnostic (runs in the Vite dev middleware AND in
// the Cloudflare Pages Function). Pulls each show's real podcast RSS, parses the
// latest episodes, and maps them to the app's Episode shape. Keyless.
//
// Shows with no clean public feed (Stratechery is members-only; "Access" has no
// resolvable feed) fall back to that show's seeded episodes, so the dashboard is
// always populated. A feed that errors or times out also falls back per-source.
// ─────────────────────────────────────────────────────────────────────────────

interface Source {
  id: string // matches a Podcast.id in mock-data
  feedUrl: string | null // verified real RSS feed; null → seed fallback
}

// Feed URLs resolved + verified via the iTunes Search API. Kept in sync with the
// PODCASTS roster in src/lib/mock-data.ts.
const SOURCES: Source[] = [
  { id: 'iltb', feedUrl: 'https://feeds.megaphone.fm/CLS2859450455' },
  { id: 'acquired', feedUrl: 'https://feeds.transistor.fm/acquired' },
  { id: 'founders', feedUrl: 'https://feeds.megaphone.fm/DSLLC6297708582' },
  { id: 'thecorereport', feedUrl: 'https://anchor.fm/s/faf1e050/podcast/rss' },
  { id: 'indiaeconomy', feedUrl: 'https://anchor.fm/s/fb4a3980/podcast/rss' },
  { id: 'signalbrief', feedUrl: 'https://anchor.fm/s/fb4a64dc/podcast/rss' },
  { id: 'mediaroom', feedUrl: 'https://anchor.fm/s/ffe806e8/podcast/rss' },
]

/** Ids of the curated seed shows. The channel roster (server/channelStore.ts)
 *  needs them: untracking a seed stores a tracked:false override, while
 *  untracking a user-added show deletes its entry outright. */
export const SEED_IDS: ReadonlySet<string> = new Set(SOURCES.map((s) => s.id))

const PER_SOURCE = 4 // recent episodes to surface per show

// Stream only the head of a feed — items are newest-first, so the first ~800 KB
// (or first 8 closed <item>/<entry>s) covers the recent episodes without
// downloading multi-megabyte archives. Goes through safeFetch so redirects are
// followed manually and every hop is re-validated against the SSRF guard.
export async function fetchFeedHead(url: string, maxBytes = 800_000, timeoutMs = 9000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'MunshotPodcasts/1.0 (+https://munshot.io)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    })
    if (!res || !res.ok || !res.body) return ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let text = ''
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (received >= maxBytes || (text.match(/<\/(?:item|entry)>/gi)?.length ?? 0) >= 8) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    return text
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

export function innerTag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1] : ''
}

export function attrOf(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? m[1] : ''
}

// Best publisher-provided transcript URL in an item (Podcasting 2.0 tag): prefer SRT, then VTT.
function transcriptUrlFrom(block: string): string {
  const tags = block.match(/<podcast:transcript\b[^>]*>/gi) || []
  if (!tags.length) return ''
  const urlOf = (tag: string) => (tag.match(/\burl\s*=\s*["']([^"']+)["']/i)?.[1] || '').replace(/&amp;/g, '&')
  const srt = tags.find((t) => /application\/srt|format=SubRip/i.test(t))
  const vtt = tags.find((t) => /text\/vtt|format=WebVTT/i.test(t))
  return urlOf(srt || vtt || tags[0] || '')
}

export function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

export function decodeEntities(s: string): string {
  // Astral-safe: fromCodePoint (not fromCharCode) so emoji / rare CJK survive; an
  // out-of-range code point decodes to nothing rather than throwing RangeError.
  const cp = (n: number) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '')
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    // `&amp;` LAST: an already-escaped sequence like `&amp;lt;` (the literal text
    // "&lt;") must decode exactly once to "&lt;", not collapse all the way to "<".
    .replace(/&amp;/g, '&')
}

export function plainText(s: string): string {
  return decodeEntities(unwrapCdata(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

function parseDuration(raw: string): number {
  const s = unwrapCdata(raw).trim()
  if (!s) return 0
  if (s.includes(':')) {
    return s.split(':').reduce((acc, part) => acc * 60 + (Number(part) || 0), 0)
  }
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function mockFor(podcastId: string): Episode[] {
  // Shallow-clone each match: overlaySummaries mutates status/summary in place, and
  // these are references into the module-level EPISODES singleton — mutating them
  // would leak one request's overlaid summary into every later request on a warm isolate.
  return EPISODES.filter((e) => e.podcastId === podcastId).map((e) => ({ ...e }))
}

// Tiny, dependency-free, stable string hash → short base36 token. Used to build a
// stable episode id from the feed's own identifiers, so it survives reordering.
export function hashKey(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function parseEpisodes(xml: string, podcastId: string): Episode[] {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0])
  const out: Episode[] = []
  for (const block of blocks) {
    if (out.length >= PER_SOURCE) break // take the first PER_SOURCE *valid* items, not raw items
    const title = decodeEntities(unwrapCdata(innerTag(block, 'title'))).trim()
    if (!title) continue
    const pub = unwrapCdata(innerTag(block, 'pubDate')).trim()
    const parsed = pub ? new Date(pub) : null
    const publishedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
    // Decode entities on the URLs too — RSS routinely XML-escapes query separators
    // (`?a=1&amp;b=2`), and a literal "&amp;" in audioUrl makes the Whisper fetch 404.
    const link = decodeEntities(unwrapCdata(innerTag(block, 'link')).trim() || attrOf(block, 'enclosure', 'url'))
    const audioUrl = decodeEntities(attrOf(block, 'enclosure', 'url'))
    const guid = plainText(innerTag(block, 'guid'))
    const description = innerTag(block, 'description') || innerTag(block, 'content:encoded')
    const notes = plainText(description)
    // Stable id from the feed's own identifiers (guid → link → title+date) rather
    // than the item's position. The old positional index shifted every time a new
    // episode published, which would re-point a saved summary at the wrong episode.
    const identity = guid || link || `${title}|${publishedAt}`
    out.push({
      id: `live-${podcastId}-${hashKey(identity)}`,
      podcastId,
      title,
      publishedAt,
      durationSec: parseDuration(innerTag(block, 'itunes:duration')),
      status: 'detected', // real episode found on the feed; AI summary not yet generated
      signal: 'normal',
      blurb: truncate(notes, 200) || 'New episode — open the source to listen.',
      sourceUrl: link || undefined,
      notes: notes ? notes.slice(0, 2500) : undefined, // fallback material for the AI summary
      transcriptUrl: transcriptUrlFrom(block) || undefined, // free publisher transcript, when present
      audioUrl: audioUrl || undefined, // for Whisper providers
      entities: { people: [], companies: [], themes: [] },
    })
  }
  return out
}

// YouTube channel feeds are Atom (<entry>), not RSS (<item>). Map each entry to
// the app's Episode shape. No audio enclosure / transcript / duration exists in
// a YouTube feed, so those stay undefined and durationSec is 0.
export function parseAtomEntries(xml: string, podcastId: string): Episode[] {
  const blocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
  const out: Episode[] = []
  for (const block of blocks) {
    if (out.length >= PER_SOURCE) break // first PER_SOURCE *valid* entries, not raw entries
    const title = decodeEntities(unwrapCdata(innerTag(block, 'title'))).trim()
    if (!title) continue
    const pub = unwrapCdata(innerTag(block, 'published')).trim() || unwrapCdata(innerTag(block, 'updated')).trim()
    const parsed = pub ? new Date(pub) : null
    const publishedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
    const link = decodeEntities((block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)?.[1] || attrOf(block, 'link', 'href')).trim())
    const videoId = plainText(innerTag(block, 'yt:videoId')) || plainText(innerTag(block, 'id'))
    const notes = plainText(innerTag(block, 'media:description'))
    const identity = videoId || link || `${title}|${publishedAt}`
    out.push({
      id: `live-${podcastId}-${hashKey(identity)}`,
      podcastId,
      title,
      publishedAt,
      durationSec: 0,
      status: 'detected',
      signal: 'normal',
      blurb: truncate(notes, 200) || 'New video — open the source to watch.',
      sourceUrl: link || undefined,
      notes: notes ? notes.slice(0, 2500) : undefined,
      entities: { people: [], companies: [], themes: [] },
    })
  }
  return out
}

// Overlay summaries already in the shared store: an episode processed by ANY
// user flips to READY with its summary attached. Summary only — the bulky
// transcript is lazy-loaded on the detail page from the same store (a store hit
// there costs no LLM/transcription), keeping list responses lean.
async function overlaySummaries(episodes: Episode[], store?: SummaryStore): Promise<Episode[]> {
  if (!store) return episodes
  await Promise.all(
    episodes.map(async (e) => {
      const hit = await store.get(sharedSummaryKey(e.id)).catch(() => null)
      if (hit?.summary) {
        e.status = 'ready'
        e.summary = hit.summary
      }
    }),
  )
  return episodes
}

// Recent episodes for a SINGLE feed URL — the dynamic path used by user-added
// podcasts (and reused by the seed shows below). Validates the URL against the
// SSRF guard, picks the parser by sniffing RSS (<item>) vs Atom (<entry>), and
// returns the parsed episodes or []. NEVER falls back to mock data: a user feed
// that errors must show an empty list, not someone else's seeded content.
// Pass the shared summary store to overlay already-processed episodes as READY;
// the seed path (episodesForSource) deliberately does NOT pass it — seeds are
// overlaid once, in getLiveEpisodes, never twice.
export async function episodesForFeed(feedUrl: string, podcastId: string, store?: SummaryStore): Promise<Episode[]> {
  if (!isPublicHttpUrl(feedUrl)) return []
  const xml = await fetchFeedHead(feedUrl)
  if (!xml) return []
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml)
  const episodes = isAtom ? parseAtomEntries(xml, podcastId) : parseEpisodes(xml, podcastId)
  return store ? overlaySummaries(episodes, store) : episodes
}

async function episodesForSource(src: Source): Promise<Episode[]> {
  // No public feed → locked show. Never serve its seed episodes: a fabricated
  // summary/transcript must not reach users. The UI renders it as a locked show.
  if (!src.feedUrl) return []
  const episodes = await episodesForFeed(src.feedUrl, src.id)
  // Seed shows may fall back to their seeded episodes if a live fetch comes back
  // empty (transient feed error) — this is the ONLY place that fallback lives.
  return episodes.length ? episodes : mockFor(src.id)
}

// All shows' recent episodes, newest first. Never throws — each source degrades
// to its seeded episodes independently. When a shared summary store is provided,
// episodes already processed by ANY user are overlaid as READY (with their tone),
// so the dashboard reflects shared state for everyone.
export async function getLiveEpisodes(store?: SummaryStore): Promise<Episode[]> {
  const settled = await Promise.allSettled(SOURCES.map(episodesForSource))
  const episodes = settled.flatMap((r, i) => (r.status === 'fulfilled' ? r.value : mockFor(SOURCES[i].id)))
  await overlaySummaries(episodes, store)
  return episodes.sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
}
