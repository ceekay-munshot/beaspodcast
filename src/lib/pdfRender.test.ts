import { describe, it, expect } from 'vitest'
import { jsPDF } from 'jspdf'
import { weeklyBlocks, episodeBlocks, renderBlocks, runs, Painter, type Block } from './pdfRender'
import { SAMPLE_EPISODES as EPISODES, SAMPLE_PODCASTS as PODCASTS, SAMPLE_WEEKLY as WEEKLY } from './sample-content'

const episodeById = (id: string) => EPISODES.find((e) => e.id === id)
const podcastById = (id: string) => PODCASTS.find((p) => p.id === id)

const titles = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { k: 'section' }> => b.k === 'section').map((b) => b.title)
const ideas = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { k: 'idea' }> => b.k === 'idea')

// Render to real PDF bytes (no DOM in the node test runner → the cover falls back
// to a solid fill, the logo is skipped). This exercises every renderer end to end
// and asserts a valid, non-trivial PDF comes out — i.e. nothing throws while drawing.
function toPdfBytes(blocks: Block[]): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true })
  renderBlocks(new Painter(doc), blocks)
  return new Uint8Array(doc.output('arraybuffer'))
}

describe('runs — **bold** parsing', () => {
  it('splits into word tokens and flags bold spans', () => {
    const t = runs('Plain **bold words** end')
    expect(t.map((x) => x.w)).toEqual(['Plain', 'bold', 'words', 'end'])
    expect(t.map((x) => x.b)).toEqual([false, true, true, false])
  })
})

describe('weeklyBlocks — Guidepoint house style', () => {
  const blocks = weeklyBlocks(WEEKLY, episodeById, podcastById)

  it('opens with the cover + table of contents, then the synthesised sections in order', () => {
    expect(blocks[0]).toMatchObject({ k: 'cover', title: 'Weekly Summary', dateRange: WEEKLY.rangeLabel })
    expect(blocks[1].k).toBe('toc')
    expect(titles(blocks)).toEqual(['Overview', 'Key Points', 'Quantitative Summary', 'Investment Readout', 'Ideas Pitched', 'Sources'])
  })

  it('carries the TOC, the quant tables + the Investment Readout, and the pitched ideas', () => {
    // The TOC lists exactly the emitted sections.
    const toc = blocks.find((b): b is Extract<Block, { k: 'toc' }> => b.k === 'toc')!
    expect(toc.rows.map((r) => r.title)).toEqual(titles(blocks))
    // The Quantitative Summary is split per source episode (one table each).
    const tables = blocks.filter((b): b is Extract<Block, { k: 'table' }> => b.k === 'table')
    const quantTables = tables.filter((t) => t.cols[0]?.header === 'Metric')
    expect(quantTables.length).toBeGreaterThan(1) // grouped by episode, not one big table
    expect(quantTables.reduce((n, t) => n + t.rows.length, 0)).toBeGreaterThan(0)
    // Investment Readout: a landscape summary table + one card per source episode.
    const readoutTable = blocks.filter((b): b is Extract<Block, { k: 'readoutTable' }> => b.k === 'readoutTable')
    const readoutCards = blocks.filter((b): b is Extract<Block, { k: 'readoutCard' }> => b.k === 'readoutCard')
    expect(readoutTable).toHaveLength(1)
    expect(readoutTable[0].cols[0]?.header).toBe('Episode')
    expect(readoutCards.length).toBe((WEEKLY.episodeReadouts ?? []).length)
    expect(readoutCards.length).toBeGreaterThan(0)
    // Pitched ideas flattened across shows.
    const idea = ideas(blocks).find((i) => i.title === 'Long Nvidia (NVDA) into the capex supercycle')
    expect(idea?.who).toBe('David Sacks')
    expect(blocks.some((b) => b.k === 'sources' && b.rows.length > 0)).toBe(true)
  })

  it('generates a valid, non-trivial PDF (two-pass render, no throws)', () => {
    const bytes = toPdfBytes(blocks)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(3000)
  })

  it('falls back to the By-Show body when there are no synthesised key themes', () => {
    const noThemes = weeklyBlocks({ ...WEEKLY, keyThemes: [], quantTable: [], comparison: [] }, episodeById, podcastById)
    expect(titles(noThemes)).toContain('By Show')
    expect(titles(noThemes)).not.toContain('Key Points')
  })
})

describe('episodeBlocks — episode', () => {
  it('builds the cover, TOC, and all sections incl. the investable insight + key numbers', () => {
    const allin = EPISODES.find((e) => e.id === 'ep-allin-e184')!
    const blocks = episodeBlocks(allin, podcastById(allin.podcastId))
    expect(blocks[0]).toMatchObject({ k: 'cover', title: allin.title })
    expect(blocks[1].k).toBe('toc')
    expect(titles(blocks)).toEqual(['AI Summary', 'Investable Insight', 'Key Numbers', 'Ideas Pitched', 'Highlights', 'Q&A'])
    expect(blocks.some((b) => b.k === 'insight')).toBe(true)
    const bytes = toPdfBytes(blocks)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })

  it('omits the Ideas + Insight sections when an episode pitched nothing', () => {
    const acquired = EPISODES.find((e) => e.id === 'ep-acquired-tsmc')!
    const blocks = episodeBlocks(acquired, podcastById(acquired.podcastId))
    expect(titles(blocks)).not.toContain('Ideas Pitched')
    expect(titles(blocks)).not.toContain('Investable Insight')
  })
})

describe('runs — inline [n] citations', () => {
  it('splits citation markers into their own gold tokens', () => {
    const t = runs('Budgets shift to OTT [1] [3].')
    const cites = t.filter((x) => x.cite).map((x) => x.w)
    expect(cites).toEqual(['[1]', '[3]'])
    // an attached marker still separates from its word
    expect(runs('share[4]').map((x) => x.w)).toEqual(['share', '[4]'])
  })
})

describe('runs — punctuation glue (no stray space before trailing marks)', () => {
  it('glues a colon that trails a **bold** span to it (renders "debate:" not "debate :")', () => {
    const t = runs('**The debate**: at a 6-year life')
    expect(t.find((x) => x.w === ':')?.glue).toBe(true)
    expect(t.find((x) => x.w === 'at')?.glue).toBeFalsy()
  })
  it('glues a period that trails a [n] citation (renders "[3]." not "[3] .")', () => {
    const t = runs('the reported margin is fiction [3].')
    const last = t[t.length - 1]
    expect(last.w).toBe('.')
    expect(last.glue).toBe(true)
    expect(t.find((x) => x.w === '[3]')?.cite).toBe(true)
  })
  it('does NOT glue an em-dash — spaced dashes keep their spaces', () => {
    expect(runs('Europe — Latin America').find((x) => x.w === '—')?.glue).toBeFalsy()
  })
})

describe('PDF hyperlinks — every "Munshot" affordance links to the dashboard', () => {
  it('embeds clickable /Link annotations pointing at chat.muns.io/dashboards', () => {
    const blocks = weeklyBlocks(WEEKLY, episodeById, podcastById)
    const pdf = new TextDecoder('latin1').decode(toPdfBytes(blocks))
    expect(pdf).toContain('/Link')
    expect(pdf).toContain('chat.muns.io/dashboards')
  })
})
