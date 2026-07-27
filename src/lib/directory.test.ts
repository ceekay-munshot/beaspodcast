import { describe, expect, it } from 'vitest'
import { isPublicHttpUrl } from '../../server/safeUrl'
import { parseAtomEntries } from '../../server/feeds'
import { youtubePlaylistId } from '../../server/search'

// The SSRF guard is the security boundary for every user-supplied URL we fetch
// server-side (search input + /api/episodes?feed=). These are the cases the
// product requirements call out explicitly.
describe('isPublicHttpUrl', () => {
  it('allows ordinary public http(s) URLs', () => {
    for (const url of [
      'https://feeds.megaphone.fm/CLS2859450455',
      'http://feeds.transistor.fm/acquired',
      'https://podcasts.apple.com/us/podcast/foo/id123456',
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc',
      'https://example.com:8443/feed.rss',
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(true)
    }
  })

  it('rejects non-http(s) protocols', () => {
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'gopher://x']) {
      expect(isPublicHttpUrl(url), url).toBe(false)
    }
  })

  it('rejects loopback and localhost', () => {
    for (const url of ['http://localhost/x', 'http://foo.localhost/x', 'http://127.0.0.1/x', 'https://127.255.1.2/x', 'http://[::1]/x']) {
      expect(isPublicHttpUrl(url), url).toBe(false)
    }
  })

  it('rejects private, link-local, CGNAT and unspecified ranges', () => {
    for (const url of [
      'http://0.0.0.0/x', // 0.0.0.0/8
      'http://10.0.0.5/x', // RFC1918
      'http://172.16.0.1/x', // RFC1918
      'http://172.31.255.255/x', // RFC1918
      'http://192.168.1.1/x', // RFC1918
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://169.254.1.1/x', // link-local
      'http://100.64.0.1/x', // CGNAT
      'http://100.127.255.255/x', // CGNAT
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(false)
    }
  })

  it('allows public IPs adjacent to private ranges', () => {
    for (const url of ['http://172.15.0.1/x', 'http://172.32.0.1/x', 'http://100.63.0.1/x', 'http://100.128.0.1/x', 'http://8.8.8.8/x']) {
      expect(isPublicHttpUrl(url), url).toBe(true)
    }
  })

  it('rejects IPv6 loopback/unique-local/link-local and IPv4-mapped privates', () => {
    for (const url of ['http://[::]/x', 'http://[::1]/x', 'http://[fc00::1]/x', 'http://[fd12:3456::1]/x', 'http://[fe80::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:10.0.0.1]/x']) {
      expect(isPublicHttpUrl(url), url).toBe(false)
    }
  })

  it('rejects malformed input without throwing', () => {
    for (const url of ['', 'not a url', 'http://', '//evil.com', '   ']) {
      expect(isPublicHttpUrl(url), url).toBe(false)
    }
  })
})

// YouTube channel feeds are Atom, not RSS — this verifies the new parser maps an
// <entry> to a valid Episode (the shape the rest of the app relies on).
describe('parseAtomEntries (YouTube)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
    <title>Test Channel</title>
    <author><name>Test Channel</name></author>
    <entry>
      <id>yt:video:ABC123</id>
      <yt:videoId>ABC123</yt:videoId>
      <title>First Video &amp; More</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=ABC123"/>
      <published>2026-05-01T12:00:00+00:00</published>
      <media:group><media:description>Hello world description.</media:description></media:group>
    </entry>
    <entry>
      <id>yt:video:DEF456</id>
      <yt:videoId>DEF456</yt:videoId>
      <title>Second Video</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=DEF456"/>
      <published>2026-04-01T08:30:00+00:00</published>
      <media:group><media:description>Another description.</media:description></media:group>
    </entry>
  </feed>`

  it('maps entries to Episodes with the required fields', () => {
    const eps = parseAtomEntries(xml, 'yt-test')
    expect(eps).toHaveLength(2)
    const [first] = eps
    expect(first.podcastId).toBe('yt-test')
    expect(first.id.startsWith('live-yt-test-')).toBe(true)
    expect(first.title).toBe('First Video & More') // entities decoded
    expect(first.sourceUrl).toBe('https://www.youtube.com/watch?v=ABC123')
    expect(first.publishedAt).toBe('2026-05-01T12:00:00.000Z')
    expect(first.notes).toContain('Hello world')
    expect(first.durationSec).toBe(0)
    expect(first.signal).toBe('normal')
    expect(first.status).toBe('detected')
    expect(first.entities).toEqual({ people: [], companies: [], themes: [] })
    expect(first.audioUrl).toBeUndefined()
    expect(first.transcriptUrl).toBeUndefined()
  })

  it('gives distinct stable ids per video', () => {
    const eps = parseAtomEntries(xml, 'yt-test')
    expect(eps[0].id).not.toBe(eps[1].id)
    // stable across re-parses
    expect(parseAtomEntries(xml, 'yt-test')[0].id).toBe(eps[0].id)
  })

  it('returns [] for a feed with no entries', () => {
    expect(parseAtomEntries('<feed><title>Empty</title></feed>', 'yt-x')).toEqual([])
  })
})

// A podcast on YouTube is usually a playlist (a series on a bigger channel), and
// the Share button hands out playlist URLs — these must resolve to the playlist
// id so Discover tracks the show, not the whole channel.
describe('youtubePlaylistId', () => {
  const PL = 'PLVPkbpccdn996PFFnil1ZETF6RSs7KsLg'

  it('reads the id from a /playlist URL (ignoring tracking params)', () => {
    expect(youtubePlaylistId(`https://youtube.com/playlist?list=${PL}&si=2GX-jJkln2jcwCHY`)).toBe(PL)
    expect(youtubePlaylistId(`https://www.youtube.com/playlist?list=${PL}`)).toBe(PL)
  })

  it('reads the id from watch and short links inside a playlist', () => {
    expect(youtubePlaylistId(`https://www.youtube.com/watch?v=ABC123&list=${PL}&index=4`)).toBe(PL)
    expect(youtubePlaylistId(`https://youtu.be/ABC123?list=${PL}`)).toBe(PL)
  })

  it('rejects session mixes, non-YouTube hosts, and URLs with no list', () => {
    expect(youtubePlaylistId('https://www.youtube.com/watch?v=ABC123&list=RDABC123')).toBeNull()
    expect(youtubePlaylistId(`https://example.com/playlist?list=${PL}`)).toBeNull()
    expect(youtubePlaylistId('https://www.youtube.com/watch?v=ABC123')).toBeNull()
    expect(youtubePlaylistId('https://www.youtube.com/playlist?list=short')).toBeNull()
    expect(youtubePlaylistId('not a url')).toBeNull()
  })
})
