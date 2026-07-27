import { describe, it, expect } from 'vitest'
import {
  weeklyReportTitle,
  weeklyReportBaseName,
  weeklyReportFilename,
  withReportDownloadName,
  contentDispositionInline,
  REPORT_DL_PARAM,
} from './reportName'

// The weekly PDF's download identity: the emailed + in-app file must save as
// "Munshot AI Podcasts — <week>.pdf", not a generic slug. These pin the brand
// stem, the date stamp, the `?dl=` round-trip, and a header that names the file
// on both modern (filename*) and legacy (ASCII filename) clients.

describe('weeklyReportTitle', () => {
  it('is the shared brand line used by the email subject and document titles', () => {
    expect(weeklyReportTitle('Jun 22 – 28, 2026')).toBe('Munshot AI Podcasts — Jun 22 – 28, 2026')
    expect(weeklyReportTitle('')).toBe('Munshot AI Podcasts')
  })
})

describe('weeklyReportBaseName / weeklyReportFilename', () => {
  it('brands the file and stamps the week', () => {
    expect(weeklyReportBaseName('Jun 22 – 28, 2026')).toBe('Munshot AI Podcasts — Jun 22 – 28, 2026')
    expect(weeklyReportFilename('Jun 22 – 28, 2026')).toBe('Munshot AI Podcasts — Jun 22 – 28, 2026.pdf')
  })

  it('keeps spaces, dashes and commas but strips filesystem-illegal chars', () => {
    expect(weeklyReportFilename('May 19 – May 25, 2026')).toBe('Munshot AI Podcasts — May 19 – May 25, 2026.pdf')
    expect(weeklyReportFilename('a/b:c*?"<>|')).toBe('Munshot AI Podcasts — abc.pdf')
  })

  it('falls back to the bare brand when there is no range', () => {
    expect(weeklyReportFilename('')).toBe('Munshot AI Podcasts.pdf')
    // @ts-expect-error — defends against an undefined label at runtime
    expect(weeklyReportFilename(undefined)).toBe('Munshot AI Podcasts.pdf')
  })
})

describe('withReportDownloadName', () => {
  it('appends an encoded ?dl= that the endpoint can read back verbatim', () => {
    const name = weeklyReportFilename('Jun 22 – 28, 2026')
    const url = withReportDownloadName('https://x.dev/api/report/abc', name)
    expect(url.startsWith(`https://x.dev/api/report/abc?${REPORT_DL_PARAM}=`)).toBe(true)
    expect(new URL(url).searchParams.get(REPORT_DL_PARAM)).toBe(name)
  })

  it('uses & when the URL already has a query, and no-ops on an empty name', () => {
    expect(withReportDownloadName('https://x.dev/r?a=1', 'f.pdf')).toBe(`https://x.dev/r?a=1&${REPORT_DL_PARAM}=f.pdf`)
    expect(withReportDownloadName('https://x.dev/r', '')).toBe('https://x.dev/r')
  })
})

describe('contentDispositionInline', () => {
  it('emits a UTF-8 filename* plus an ASCII fallback with dashes transliterated', () => {
    const cd = contentDispositionInline('Munshot AI Podcasts — Jun 22 – 28, 2026.pdf')
    // ASCII fallback: em/en dashes become '-', no Unicode left in the quoted part.
    expect(cd).toContain('filename="Munshot AI Podcasts - Jun 22 - 28, 2026.pdf"')
    // Modern clients get the exact name via RFC 5987 UTF-8.
    expect(cd).toContain("filename*=UTF-8''")
    expect(cd).toContain(encodeURIComponent('Munshot AI Podcasts — Jun 22 – 28, 2026.pdf'))
    expect(cd.startsWith('inline; ')).toBe(true)
  })

  it('defaults to the brand name when no filename is supplied', () => {
    expect(contentDispositionInline(null)).toContain('filename="Munshot AI Podcasts.pdf"')
    expect(contentDispositionInline(undefined)).toContain('filename="Munshot AI Podcasts.pdf"')
  })

  it('never lets a quote escape the quoted filename token', () => {
    expect(contentDispositionInline('a"b\\c.pdf')).toContain('filename="abc.pdf"')
  })
})
