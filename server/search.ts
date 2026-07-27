import type { SourceKind } from '../src/lib/types'
import { isPublicHttpUrl, safeFetch } from './safeUrl'
import { attrOf, decodeEntities, fetchFeedHead, hashKey, innerTag, plainText, unwrapCdata } from './feeds'

// ─────────────────────────────────────────────────────────────────────────────
// Keyless podcast directory search. Runtime-agnostic (Vite dev middleware AND
// Cloudflare Pages Function), never throws — returns [] on any failure.
//
//   plain text  → Apple/iTunes Search API (free, no key); when Apple fails or
//                 returns nothing — its WAF blocks datacenter IPs, so Workers
//                 egress is often refused — fyyd.de answers instead
//   apple URL   → iTunes lookup by collection id (…/id123456)
//   youtube URL → playlist URLs resolve to the playlist's videos.xml feed
//                 (shows published as playlists); otherwise the channel's
//   rss URL     → accept the feed and read its channel metadata
//
// Every user-supplied URL (and the feedUrl a result carries) is validated by the
// SSRF guard before we fetch or return it. Fixed Apple hosts aren't user-
// controlled, so those calls use plain fetch.
// ─────────────────────────────────────────────────────────────────────────────

export interface PodcastSearchResult {
  id: string // itunes-<collectionId> | feed-<hashKey(feedUrl)> | yt-<channelId>
  title: string
  author: string
  category: string
  description: string
  artworkUrl?: string
  feedUrl: string // canonical RSS / YouTube videos.xml
  source: SourceKind
}

const UA = 'MunshotPodcasts/1.0 (+https://munshot.io)'
const LIMIT = 12
const LIMIT_MAX = 50

// Server-local — do NOT import the UI helper from src/lib/source.ts.
function isYouTubeHost(hostname: string): boolean {
  const h = hostname.replace(/^www\./, '').toLowerCase()
  return h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')
}

// ── iTunes ───────────────────────────────────────────────────────────────────

interface ItunesPodcast {
  collectionId?: number
  collectionName?: string
  artistName?: string
  feedUrl?: string
  artworkUrl600?: string
  primaryGenreName?: string
}

function mapItunes(r: ItunesPodcast): PodcastSearchResult | null {
  const feedUrl = (r.feedUrl || '').trim()
  const title = (r.collectionName || '').trim()
  // Drop entries with no feed (can't ingest) or an unsafe feed URL.
  if (!title || !feedUrl || !isPublicHttpUrl(feedUrl)) return null
  return {
    id: `itunes-${r.collectionId ?? hashKey(feedUrl)}`,
    title,
    author: (r.artistName || '').trim(),
    category: (r.primaryGenreName || 'Podcast').trim(),
    description: '', // the Search/lookup API carries none — the card line-clamps an empty string fine
    artworkUrl: r.artworkUrl600 || undefined,
    feedUrl,
    source: 'podcast',
  }
}

async function itunesResults(url: string): Promise<PodcastSearchResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA } })
    if (!res.ok) return []
    const data = (await res.json()) as { results?: ItunesPodcast[] }
    const rows = Array.isArray(data.results) ? data.results : []
    const seen = new Set<string>()
    const out: PodcastSearchResult[] = []
    for (const row of rows) {
      const mapped = mapItunes(row)
      if (!mapped || seen.has(mapped.id)) continue
      seen.add(mapped.id)
      out.push(mapped)
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

const searchItunes = (term: string, limit = LIMIT) =>
  itunesResults(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${limit}&term=${encodeURIComponent(term)}`)

const resolveAppleId = (id: string) =>
  itunesResults(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=podcast`)

// ── fyyd.de — keyless fallback directory ─────────────────────────────────────
// Apple's WAF refuses requests from datacenter IPs, so from Workers egress the
// iTunes call above usually comes back 403/empty. fyyd is an open directory
// with no such block; smaller catalog, but results beat an empty screen.

interface FyydPodcast {
  title?: string
  author?: string
  xmlURL?: string
  imgURL?: string
  smallImageURL?: string
  description?: string
  subtitle?: string
}

async function searchFyyd(term: string, limit = LIMIT): Promise<PodcastSearchResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch(`https://api.fyyd.de/0.2/search/podcast?title=${encodeURIComponent(term)}&count=${limit}`, {
      signal: controller.signal,
      headers: { 'user-agent': UA },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: FyydPodcast[] }
    const rows = Array.isArray(data.data) ? data.data : []
    const seen = new Set<string>()
    const out: PodcastSearchResult[] = []
    for (const row of rows) {
      const feedUrl = (row.xmlURL || '').trim()
      const title = (row.title || '').trim()
      if (!title || !feedUrl || !isPublicHttpUrl(feedUrl)) continue
      // feed-<hash> — the same id the raw-RSS resolver derives, so the same show
      // found by either path dedupes in the UI.
      const id = `feed-${hashKey(feedUrl)}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        title,
        author: (row.author || '').trim(),
        category: 'Podcast', // fyyd categories are numeric ids — not worth a second request
        description: plainText(row.description || row.subtitle || '').slice(0, 300),
        artworkUrl: row.smallImageURL || row.imgURL || undefined,
        feedUrl,
        source: 'podcast',
      })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Plain-text directory search: Apple first, fyyd when Apple yields nothing. */
async function searchDirectory(term: string, limit = LIMIT): Promise<PodcastSearchResult[]> {
  const itunes = await searchItunes(term, limit)
  return itunes.length ? itunes : searchFyyd(term, limit)
}

// ── Raw RSS feed URL ──────────────────────────────────────────────────────────

// The channel-level <title> etc. — read AFTER stripping <item> blocks so an
// episode's title isn't mistaken for the show title.
async function resolveRssFeed(url: string): Promise<PodcastSearchResult[]> {
  if (!isPublicHttpUrl(url)) return []
  const xml = await fetchFeedHead(url, 200_000)
  if (!xml) return []
  const head = xml.replace(/<item\b[\s\S]*?<\/item>/gi, '')
  const title = decodeEntities(unwrapCdata(innerTag(head, 'title'))).trim()
  if (!title) return []
  const author =
    decodeEntities(unwrapCdata(innerTag(head, 'itunes:author'))).trim() ||
    decodeEntities(unwrapCdata(innerTag(head, 'managingEditor'))).trim()
  const category = attrOf(head, 'itunes:category', 'text').trim() || decodeEntities(unwrapCdata(innerTag(head, 'category'))).trim()
  const artworkUrl = attrOf(head, 'itunes:image', 'href').trim() || plainText(innerTag(innerTag(head, 'image'), 'url')).trim()
  return [
    {
      id: `feed-${hashKey(url)}`,
      title,
      author,
      category: category || 'Podcast',
      description: plainText(innerTag(head, 'description')).slice(0, 300),
      artworkUrl: artworkUrl || undefined,
      feedUrl: url,
      source: 'podcast',
    },
  ]
}

// ── YouTube playlist / channel URL → videos.xml RSS ───────────────────────────

/** The playlist id carried by a YouTube URL (`/playlist?list=…`, or a watch /
 *  share link inside the playlist carrying `?list=…`). Null for session mixes
 *  (RD… ids — YouTube serves no feed for those) and anything malformed. */
export function youtubePlaylistId(rawUrl: string): string | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (!isYouTubeHost(u.hostname)) return null
  const list = (u.searchParams.get('list') || '').trim()
  if (!/^[A-Za-z0-9_-]{12,48}$/.test(list) || list.startsWith('RD')) return null
  return list
}

// A podcast published on YouTube is usually a PLAYLIST on a bigger channel
// (e.g. one series among many shows), so a playlist URL resolves to the
// playlist's own feed — exactly its episodes — never the whole channel.
async function resolveYouTubePlaylist(rawUrl: string): Promise<PodcastSearchResult[]> {
  const listId = youtubePlaylistId(rawUrl)
  if (!listId) return []
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${listId}`
  const xml = await fetchFeedHead(feedUrl, 200_000)
  if (!xml) return []
  const head = xml.replace(/<entry\b[\s\S]*?<\/entry>/gi, '') // playlist-level fields only
  const title = decodeEntities(unwrapCdata(innerTag(head, 'title'))).trim()
  if (!title) return [] // private / deleted playlist → let the channel path try
  const author = decodeEntities(unwrapCdata(innerTag(innerTag(head, 'author'), 'name'))).trim() || title
  return [{ id: `yt-pl-${listId}`, title, author, category: 'YouTube', description: '', feedUrl, source: 'youtube' }]
}

function youtubeHandleName(u: URL): string {
  const seg = u.pathname.split('/').filter(Boolean)
  const first = seg[0] || ''
  if (first.startsWith('@')) return first.slice(1)
  if ((first === 'c' || first === 'user') && seg[1]) return seg[1]
  return 'YouTube channel'
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (received >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    /* return whatever we managed to read */
  }
  return text
}

async function resolveYouTubeChannelId(rawUrl: string): Promise<string | null> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  const direct = u.pathname.match(/\/channel\/(UC[\w-]+)/i)
  if (direct) return direct[1]
  const param = u.searchParams.get('channel_id')
  if (param && /^UC[\w-]+$/.test(param)) return param
  // /@handle, /c/Name, /user/Name → scrape the channel page for the id. The
  // consent cookies matter: without them YouTube often serves a consent
  // interstitial (especially to datacenter IPs) that carries no channelId.
  const res = await safeFetch(rawUrl, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'en', cookie: 'CONSENT=YES+1; SOCS=CAI' },
  })
  if (!res || !res.ok) return null
  const html = await readCapped(res, 300_000)
  const m =
    html.match(/"channelId":"(UC[\w-]+)"/) ||
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/channel\/(UC[\w-]+)/i) ||
    html.match(/\/channel\/(UC[\w-]+)/)
  return m ? m[1] : null
}

async function resolveYouTubeFeed(rawUrl: string): Promise<PodcastSearchResult[]> {
  if (!isPublicHttpUrl(rawUrl)) return []
  // A URL carrying a playlist id is the playlist (the show); the channel is the
  // fallback for plain channel/handle/watch URLs — and for dead playlists.
  const playlist = await resolveYouTubePlaylist(rawUrl)
  if (playlist.length) return playlist
  const channelId = await resolveYouTubeChannelId(rawUrl)
  if (!channelId) return []
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  const xml = await fetchFeedHead(feedUrl, 200_000)
  const head = xml.replace(/<entry\b[\s\S]*?<\/entry>/gi, '') // channel-level fields only
  let fallback = 'YouTube channel'
  try {
    fallback = youtubeHandleName(new URL(rawUrl))
  } catch {
    /* keep default */
  }
  const title = decodeEntities(unwrapCdata(innerTag(head, 'title'))).trim() || fallback
  const author = decodeEntities(unwrapCdata(innerTag(innerTag(head, 'author'), 'name'))).trim() || title
  return [{ id: `yt-${channelId}`, title, author, category: 'YouTube', description: '', feedUrl, source: 'youtube' }]
}

// ── Entry point ────────────────────────────────────────────────────────────────

// The searchable text hiding in a YouTube channel URL ("/@nikhil.kamath" →
// "nikhil kamath") — the directory-search fallback when the channel itself
// can't be resolved (consent/bot wall on the channel page).
function youtubeHandleQuery(u: URL): string {
  const seg = u.pathname.split('/').filter(Boolean)
  const first = decodeURIComponent(seg[0] || '')
  const name = first.startsWith('@') ? first.slice(1) : (first === 'c' || first === 'user') && seg[1] ? decodeURIComponent(seg[1]) : ''
  return name.replace(/[._-]+/g, ' ').trim()
}

export async function searchPodcasts(rawQuery: string, limit = LIMIT): Promise<PodcastSearchResult[]> {
  const q = (rawQuery || '').trim()
  const cap = Math.min(Math.max(1, Math.floor(limit) || LIMIT), LIMIT_MAX)
  if (!q) return []
  if (/^https?:\/\//i.test(q)) {
    if (!isPublicHttpUrl(q)) return []
    let u: URL
    try {
      u = new URL(q)
    } catch {
      return []
    }
    const host = u.hostname.toLowerCase()
    if (host === 'apple.com' || host.endsWith('.apple.com')) {
      const id = u.pathname.match(/\/id(\d+)/)?.[1]
      return id ? resolveAppleId(id) : []
    }
    if (isYouTubeHost(host)) {
      const yt = await resolveYouTubeFeed(q)
      if (yt.length) return yt
      // Channel page unreachable (bot wall) → most YouTube podcasts also live in
      // the directory, so search the handle text rather than returning nothing.
      const handle = youtubeHandleQuery(u)
      return handle ? searchDirectory(handle, cap) : []
    }
    return resolveRssFeed(q)
  }
  return searchDirectory(q, cap)
}
