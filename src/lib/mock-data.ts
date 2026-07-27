import type { Episode, Podcast, WeeklySummary } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Roster + fallback data for the Beas Capital dashboard.
//
// PODCASTS is the tracked show lineup. Real episodes are pulled LIVE from each
// show's feed (server/feeds.ts) — the EPISODES array below is only a neutral
// fallback for when no live data is available, and is intentionally empty so no
// stale/sample episodes ever surface. Cover art, author, and genre are the real
// values from the iTunes Search API. The list is kept in sync with the feed
// SOURCES in server/feeds.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const PODCASTS: Podcast[] = [
  {
    id: 'iltb',
    title: "Invest Like the Best with Patrick O'Shaughnessy",
    author: 'Colossus | Investing & Business Podcasts',
    category: 'Investing',
    description: `Conversations with the best investors and operators in the world, exploring markets, ideas, and the craft of capital allocation.`,
    cadence: 'Weekly',
    episodeCount: 589,
    source: 'youtube',
    color: '#1c7d52',
    monogram: 'IB',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/61/ae/be/61aebe7a-06e8-7390-3ae5-f2fc5889e36c/mza_10827489189939068066.jpg/600x600bb.jpg',
    feedUrl: 'https://feeds.megaphone.fm/CLS2859450455',
    tracked: true,
  },
  {
    id: 'acquired',
    title: 'Acquired',
    author: 'Ben Gilbert and David Rosenthal',
    category: 'Technology',
    description: `Every company has a story. Ben and David tell the ones worth knowing — the great acquisitions and IPOs, in deep detail.`,
    cadence: 'Bi-weekly',
    episodeCount: 215,
    source: 'youtube',
    color: '#2f6f4f',
    monogram: 'AQ',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/a8/e1/de/a8e1deff-9f88-4e55-a541-b0dc793c0cdc/mza_11539673419613154037.jpg/600x600bb.jpg',
    feedUrl: 'https://feeds.transistor.fm/acquired',
    tracked: true,
  },
  {
    id: 'founders',
    title: 'Founders (David Senra)',
    author: 'David Senra',
    category: 'Entrepreneurship',
    description: `David Senra studies history's greatest entrepreneurs and shares what he learns from their biographies — one founder at a time.`,
    cadence: 'Weekly',
    episodeCount: 451,
    source: 'youtube',
    color: '#a23b2e',
    monogram: 'FO',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/ed/71/4f/ed714f67-f095-a4ef-f38e-d8c02300666a/mza_11432355988627368701.jpg/600x600bb.jpg',
    feedUrl: 'https://feeds.megaphone.fm/DSLLC6297708582',
    tracked: true,
  },
  {
    id: 'thecorereport',
    title: 'The Core Report',
    author: 'The Core',
    category: 'Business News',
    description: `A daily business and markets briefing on India and the world — the numbers, the moves, and what they mean, from The Core.`,
    cadence: 'Daily',
    episodeCount: 944,
    source: 'podcast',
    color: '#c8102e',
    monogram: 'CR',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/1b/c0/67/1bc067c0-a0c3-5e7d-c609-29916785adc0/mza_11754483019496274731.jpg/600x600bb.jpg',
    feedUrl: 'https://anchor.fm/s/faf1e050/podcast/rss',
    tracked: true,
  },
  {
    id: 'indiaeconomy',
    title: "How India's Economy Works",
    author: 'The Core',
    category: 'Business News',
    description: `A clear-eyed look at the forces shaping India's economy — growth, policy, markets, and the long-run structural story.`,
    cadence: 'Weekly',
    episodeCount: 63,
    source: 'podcast',
    color: '#0a6e6e',
    monogram: 'IE',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/1d/9c/a4/1d9ca458-e70d-9272-f837-ff4bf9001c23/mza_12754567876020938709.jpg/600x600bb.jpg',
    feedUrl: 'https://anchor.fm/s/fb4a3980/podcast/rss',
    tracked: true,
  },
  {
    id: 'signalbrief',
    title: 'The Signal Brief',
    author: 'The Core',
    category: 'Business News',
    description: `Short, sharp briefings that cut through the noise to the signals actually moving markets and business.`,
    cadence: 'Daily',
    episodeCount: 755,
    source: 'podcast',
    color: '#1f3a8a',
    monogram: 'SB',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/9f/fd/11/9ffd112e-c9ad-adf4-a7da-6e2596e6f967/mza_3399886165526887595.jpg/600x600bb.jpg',
    feedUrl: 'https://anchor.fm/s/fb4a64dc/podcast/rss',
    tracked: true,
  },
  {
    id: 'mediaroom',
    title: 'The Media Room',
    author: 'The Core',
    category: 'Business News',
    description: `Conversations on media, technology, and the business of attention — how the story gets made and who profits from it.`,
    cadence: 'Weekly',
    episodeCount: 39,
    source: 'podcast',
    color: '#5b3fa8',
    monogram: 'MR',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/a6/40/92/a640923f-5478-e338-8fd3-c1cd389962dc/mza_10047688826475476216.jpg/600x600bb.jpg',
    feedUrl: 'https://anchor.fm/s/ffe806e8/podcast/rss',
    tracked: true,
  },
]

// Neutral fallback. Real episodes load live from each show's feed
// (server/feeds.ts); this array stays empty so no sample/stale episodes ever
// surface. Kept as a typed export because api.ts falls back to it when a live
// fetch returns nothing.
export const EPISODES: Episode[] = []

// Neutral fallback weekly edition. The real weekly digest is generated from live
// episodes; this placeholder renders cleanly until the first edition exists.
export const WEEKLY: WeeklySummary = {
  id: 'wk-pending',
  rangeLabel: 'This week',
  episodeCount: 0,
  readMinutes: 0,
  overview: [
    `No episodes have been summarised yet this week. As your tracked shows publish, their weekly investment digest will appear here automatically.`,
  ],
  keyThemes: [],
  quantTable: [],
  episodeReadouts: [],
  citations: [],
  shows: [],
  topThemes: [],
  interesting: { title: '', quote: '', speaker: '', role: '', episodeId: '' },
  takeaways: [],
  contradictions: [],
  mentions: { people: [], companies: [] },
  questions: [],
  sourceEpisodeIds: [],
}
