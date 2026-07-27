// ─────────────────────────────────────────────────────────────────────────────
// Transcription — a provider chain, tried in order, first hit wins:
//
//   1. feed transcript  — free, instant, accurate (publisher's own SRT/VTT)
//   2. paid Whisper     — PRIMARY once a key is supplied   (seam below)
//   3. free-tier Whisper— BACKUP (Groq / Cloudflare Workers AI)  (seam below)
//
// Runtime-agnostic (Vite dev middleware + Cloudflare Pages Function). Returns
// null when no provider can produce a transcript → caller falls back to show-notes.
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscribeInput {
  title?: string
  transcriptUrl?: string // publisher SRT/VTT from the feed
  audioUrl?: string // episode audio, for Whisper
}

export interface TranscribeConfig {
  deepgramKey?: string // URL-based, handles any length (used for long, non-feed episodes)
  deepgramModel?: string // defaults to nova-3
  groqKey?: string // free-tier Whisper for short episodes (within the size limit)
}

/** A raw, ungrouped transcript segment straight from a provider. */
export interface RawSegment {
  start: number // seconds into the episode
  text: string
  speaker?: number // diarization index (Deepgram), when available
}

export interface TranscriptResult {
  text: string // timestamped flat text — the LLM summary source
  source: 'feed' | 'groq' | 'deepgram'
  segments: RawSegment[] // structured segments — the Transcript-tab source
}

// Strip SRT/VTT cue numbers, timestamps, and tags down to plain spoken text.
export function captionsToText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => {
      const l = line.trim()
      if (!l) return false
      if (/^WEBVTT/i.test(l)) return false
      if (/^NOTE\b/i.test(l)) return false
      if (/^\d+$/.test(l)) return false // cue index
      if (l.includes('-->')) return false // timestamp line
      return true
    })
    .map((l) => l.replace(/<[^>]+>/g, '').trim()) // strip inline tags (e.g. <c>, <v Speaker>)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Parse an SRT/VTT timestamp ("HH:MM:SS,mmm" / "MM:SS.mmm") to seconds.
function parseTimestamp(ts: string): number {
  // Milliseconds optional: standard SRT/VTT carry them, but a cue without ("00:01:02")
  // must still parse to its real second rather than collapsing every segment to 0:00.
  const m = ts.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?/)
  if (!m) return 0
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])
}

// SRT/VTT → cue segments [{ start, text }].
function captionsToSegments(raw: string): Array<{ start: number; text: string }> {
  const segs: Array<{ start: number; text: string }> = []
  for (const block of raw.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    const cue = lines.find((l) => l.includes('-->'))
    if (!cue) continue
    const text = lines
      .filter((l) => l !== cue && !/^\d+$/.test(l) && !/^WEBVTT/i.test(l) && !/^NOTE\b/i.test(l))
      .map((l) => l.replace(/<[^>]+>/g, ''))
      .join(' ')
      .trim()
    if (text) segs.push({ start: parseTimestamp(cue.split('-->')[0]), text })
  }
  return segs
}

// Join segments into plain text with a [m:ss] marker ~every minute, so the LLM
// can cite REAL timestamps for the interesting moments instead of guessing.
function segmentsToTimestampedText(segments: Array<{ start: number; text: string }>): string {
  let out = ''
  let nextMark = 0
  for (const s of segments) {
    if (s.start >= nextMark) {
      out += ` [${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}] `
      nextMark = s.start + 60
    }
    out += `${s.text} `
  }
  return out.replace(/\s+/g, ' ').trim()
}

async function fetchCaptions(url: string, maxBytes = 1_500_000, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'MunshotPodcasts/1.0' } })
    if (!res.ok || !res.body) return ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let text = ''
    let received = 0
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
    return text
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

// Free-tier limits: Groq caps audio uploads (~25MB). Skip oversized files rather
// than send a truncated/garbled clip — those fall back to show-notes for now
// (long-episode chunking comes with the background-job upgrade).
const MAX_AUDIO_BYTES = 24 * 1024 * 1024

async function fetchAudioCapped(url: string, maxBytes: number, timeoutMs = 25_000): Promise<Uint8Array<ArrayBuffer> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'MunshotPodcasts/1.0' } })
    if (!res.ok || !res.body) return null
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared && declared > maxBytes) return null // too big for the free tier
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null // exceeded mid-stream — bail rather than upload a truncated file
      }
      chunks.push(value)
    }
    const out: Uint8Array<ArrayBuffer> = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      out.set(c, offset)
      offset += c.byteLength
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Groq Whisper (OpenAI-compatible /audio/transcriptions). Returns '' on any
// failure — including 429 rate-limits — so the caller falls back to show-notes.
async function transcribeViaGroq(audioUrl: string, apiKey: string): Promise<{ text: string; segments: RawSegment[] }> {
  const empty = { text: '', segments: [] as RawSegment[] }
  const audio = await fetchAudioCapped(audioUrl, MAX_AUDIO_BYTES)
  if (!audio) return empty
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'episode.mp3')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'verbose_json') // includes segment timestamps
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) return empty // 429 / 413 / etc. → graceful fall back
    const data = (await res.json()) as { text?: string; segments?: Array<{ start: number; text: string }> }
    const segments: RawSegment[] = (data.segments ?? []).map((s) => ({ start: s.start, text: (s.text ?? '').trim() }))
    const text = segments.length ? segmentsToTimestampedText(segments) : (data.text ?? '')
    return { text, segments: segments.length ? segments : text ? [{ start: 0, text }] : [] }
  } catch {
    return empty
  } finally {
    clearTimeout(timer)
  }
}

// Deepgram pre-recorded (URL-based) — handles any length; Deepgram fetches the
// audio itself, so no download/chunking on our side. Returns '' on failure.
async function transcribeViaDeepgram(audioUrl: string, apiKey: string, model: string): Promise<{ text: string; segments: RawSegment[] }> {
  const empty = { text: '', segments: [] as RawSegment[] }
  // diarize → per-speaker turns, so the Transcript tab can label "Speaker 1/2".
  const params = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true', utterances: 'true', diarize: 'true', language: 'en' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 280_000)
  try {
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: audioUrl }),
      signal: controller.signal,
    })
    if (!res.ok) return empty
    const data = (await res.json()) as {
      results?: {
        utterances?: Array<{ start: number; transcript: string; speaker?: number }>
        channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>
      }
    }
    const utts = data.results?.utterances
    if (utts?.length) {
      const segments: RawSegment[] = utts.map((u) => ({ start: u.start, text: (u.transcript ?? '').trim(), speaker: u.speaker }))
      return { text: segmentsToTimestampedText(segments), segments }
    }
    const flat = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
    return { text: flat, segments: flat ? [{ start: 0, text: flat }] : [] }
  } catch {
    return empty
  } finally {
    clearTimeout(timer)
  }
}

export async function transcribeEpisode(input: TranscribeInput, config: TranscribeConfig = {}): Promise<TranscriptResult | null> {
  // 1) FREE: publisher-provided transcript in the feed (Odd Lots, Acquired, …)
  if (input.transcriptUrl) {
    const raw = await fetchCaptions(input.transcriptUrl)
    const segs = captionsToSegments(raw)
    if (segs.length) {
      const text = segmentsToTimestampedText(segs)
      if (text.length > 200) return { text, source: 'feed', segments: segs }
    }
    const flat = captionsToText(raw)
    if (flat.length > 200) return { text: flat, source: 'feed', segments: [{ start: 0, text: flat }] }
  }

  // 2) FREE: Groq Whisper for episodes within its size limit (short ones). Oversized
  //    or rate-limited (429) episodes fall through to Deepgram below.
  if (config.groqKey && input.audioUrl) {
    const r = await transcribeViaGroq(input.audioUrl, config.groqKey)
    if (r.text.length > 200) return { text: r.text, source: 'groq', segments: r.segments }
  }

  // 3) PAID: Deepgram (URL-based) handles ANY length — the catch-all for the long,
  //    non-feed episodes nothing free could cover. Credit is only spent if we reach here.
  if (config.deepgramKey && input.audioUrl) {
    const r = await transcribeViaDeepgram(input.audioUrl, config.deepgramKey, config.deepgramModel || 'nova-3')
    if (r.text.length > 200) return { text: r.text, source: 'deepgram', segments: r.segments }
  }

  return null
}
