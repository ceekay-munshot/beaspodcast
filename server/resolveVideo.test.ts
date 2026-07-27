import { describe, it, expect } from 'vitest'
import { extractFirstVideoId } from './resolveVideo'

// The results-page parser behind /api/resolve-video. The page is a huge script
// blob; the contract is just: first ORGANIC result wins, ads never match, and
// an unrecognisable page yields null (the UI then falls back to a search link).

describe('extractFirstVideoId', () => {
  it('returns the first organic videoRenderer id', () => {
    const html = '… "videoRenderer":{"videoId":"dQw4w9WgXcQ","thumbnail":{} … "videoRenderer":{"videoId":"abc123DEF45"'
    expect(extractFirstVideoId(html)).toBe('dQw4w9WgXcQ')
  })

  it('skips promoted (ad) slots', () => {
    const html = '"promotedVideoRenderer":{"videoId":"AAAAAAAAAAA"} … "videoRenderer":{"videoId":"realVideo01"}'
    expect(extractFirstVideoId(html)).toBe('realVideo01')
  })

  it('returns null when the page has no results (bot-wall, consent page)', () => {
    expect(extractFirstVideoId('<html>Before you continue to YouTube</html>')).toBeNull()
  })
})
