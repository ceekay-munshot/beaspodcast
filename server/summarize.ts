import type { EpisodeInsight, EpisodeTone, Highlight, Idea, InsightParty, QAItem, QuantPoint, Summary, TranscriptSegment, WeeklyAi, WeeklyEpisodeReadout, WeeklySource, WeeklyTheme } from '../src/lib/types'
import { stableHash } from '../src/lib/hash'
import { transcribeEpisode } from './transcribe'
import { SUMMARY_REVISION, sharedSummaryKey, type SummaryStore } from './summaryStore'

// ─────────────────────────────────────────────────────────────────────────────
// AI summarization — runtime-agnostic (Vite dev middleware + Cloudflare Pages
// Function). Builds the app's structured Summary from the best available source:
// a real transcript (via the transcription provider chain) when one exists, else
// the publisher's show-notes. Provider-agnostic for the LLM: OpenAI if an OpenAI
// key is supplied, else Anthropic. Forced tool/function calling guarantees valid
// structured JSON. Keys are passed in by the caller (from env) — never hardcoded.
// ─────────────────────────────────────────────────────────────────────────────

export interface SummarizeInput {
  /** Stable episode id — the shared cache key. When present, the result is reused
   *  across all users; when absent (e.g. the weekly roundup) the work is not shared. */
  id?: string
  title: string
  show: string
  notes?: string
  transcriptUrl?: string
  audioUrl?: string
  /** Skip the cache READS (shared store + in-process) and recompute from scratch,
   *  still writing the fresh result back. Powers the "Refresh" button so a shipped
   *  format/prompt change can replace a stale cached summary. */
  force?: boolean
}

export interface SummarizeConfig {
  openaiKey?: string
  anthropicKey?: string
  /** Optional model override; otherwise a sensible per-provider default is used. */
  model?: string
  // Transcription providers (threaded to the transcribe chain):
  deepgramKey?: string // URL-based, handles long episodes
  deepgramModel?: string
  groqKey?: string // free-tier Whisper (short episodes)
  /** Shared, persistent summary store (KV in prod, filesystem in dev). When set,
   *  a processed summary is reused across all users instead of recomputed. */
  store?: SummaryStore
}

/** What /api/summary returns: the one-page summary PLUS the full transcript it was
 *  built from (so the Transcript tab can render the real thing), when one exists. */
export interface SummarizeResult {
  summary: Summary
  transcript: TranscriptSegment[]
  transcriptSource?: 'feed' | 'groq' | 'deepgram'
  /** Present only for weekly-synthesis results (synthesizeWeekly), so the shared
   *  store can cache the cross-episode narrative under the `weekly:<hash>` id and
   *  reuse it across users — the episode `summary` field is then just a stub. */
  weekly?: WeeklyAi
}

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    synthesis: {
      type: 'array',
      items: { type: 'string' },
      description: '3-4 substantive plain-text paragraphs that go beyond the headline. Lead with the central argument, then develop it with the SPECIFICS that make it credible — the concrete claims, real numbers, named companies/people, and the actual mechanism or causal chain behind each point. Capture the genuine tension or disagreement where speakers diverge (the bull case vs the bear case, what is contested, what is uncertain), and surface the non-obvious, second-order insight a sharp listener takes away — not the obvious summary anyone could write from the title. Avoid generic filler ("the market is maturing", "X is seeing significant growth"); every sentence must carry specific, episode-grounded content. Emphasise at most ~3 SHORT key phrases (2-5 words each) by wrapping each in matched **double asterisks** — never bold whole sentences or clauses, and always pair every ** you open with a closing **.',
    },
    qa: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] },
      description:
        'COMPREHENSIVE coverage of the substantive questions this episode raises and answers — capture EVERY distinct one, not a fixed number. A dense 40-60 minute episode typically yields 6-12; include as many as the material genuinely supports, roughly in the order the episode addresses them, and never drop a real question to hit a target. Exclude only trivial banter, logistics, and ad reads. Phrase each question as a complete, self-contained sentence that names its specific subject — someone who never heard the episode should understand exactly what is being asked (avoid vague stems like "What is the main focus?"). Each answer is a dense, self-explanatory paragraph of 2-4 full sentences that completely answers the question using the concrete specifics from the material — names, numbers, mechanisms, and the reasoning behind them — so it stands on its own without the audio. Draw every detail from the source; never pad or speculate to fill space.',
    },
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          idea: {
            type: 'string',
            description:
              'The specific, actionable call in a few words, naming the concrete instrument/company/action — e.g. "Long Uber (UBER)", "Short commercial real estate", "Buy 2-year Treasuries", "Fed cuts twice in 2026". Always name the ticker/company/asset when stated.',
          },
          proponent: { type: 'string', description: 'Who pitched/made the call (speaker name). Use "—" only if genuinely unattributed.' },
          thesis: {
            type: 'array',
            items: { type: 'string' },
            description: 'The 2-4 KEY supporting points actually given for the call — each a concrete, specific clause (the reason, the catalyst, the number), not a restatement of the idea.',
          },
          kind: { type: 'string', enum: ['stock', 'trade', 'macro', 'prediction'], description: 'Coarse category: a single-name equity pick (stock), a non-equity trade (trade), a macro/rates/economy call (macro), or a bold dated forecast (prediction).' },
        },
        required: ['idea', 'proponent', 'thesis'],
      },
      description:
        'Every CONCRETE, ACTIONABLE idea pitched in the episode — investment/stock picks (with ticker/company), trades, macro calls, or bold specific predictions — each with who pitched it and its key thesis. Capture EACH distinct call, not a summary of them; shows with an explicit pitch segment (e.g. All-In stock picks) must yield one entry per pick. Return an EMPTY array when the episode makes no specific, actionable call — do NOT lower the bar to fill it with vague opinions ("AI is overhyped") or generic observations. Never invent a pitch that was not actually made.',
    },
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          timestamp: { type: 'string', description: 'mm:ss if known, otherwise "—"' },
          detail: { type: 'string' },
          key: { type: 'boolean', description: 'true ONLY for the 4-6 most important items — the headline takeaways of the episode.' },
        },
        required: ['title', 'timestamp', 'detail', 'key'],
      },
      description: 'COMPREHENSIVE coverage of the episode\'s highlights — the beats a sharp listener would revisit: bold claims, specific predictions or numbers, sharp disagreements, surprising data, memorable anecdotes, or pivotal turns in the conversation. Capture EVERY such beat, not a fixed number; a dense 40-60 minute episode typically yields 7-12, spread across the whole episode (early, middle, AND late) rather than clustered at the opening. Each title names the specific beat; each detail is 1-2 concrete sentences stating what was actually said (the specific claim, number, or exchange, naming who said it when notable) and why it matters — never generic filler like "this highlights a key shift". Then set key=true on ONLY the 4-6 most important, non-obvious items — the headline takeaways a busy reader must not miss — and key=false on the rest.',
    },
    insight: {
      type: 'object',
      additionalProperties: false,
      description:
        'The INVESTABLE read of the episode — the five-part lens a sharp analyst applies. Ground every field strictly in the material; never invent a party, a mechanism, or a shift that was not actually expressed.',
      properties: {
        whatChanged: {
          type: 'string',
          description:
            'The single most important NEW development or shift versus the prior state of the world — the concrete fact (the number, the company, the move, the data point), NOT the topic. If the episode is purely evergreen with no real shift, state its central claim instead of inventing a "change". One or two sentences.',
        },
        whyItMatters: {
          type: 'string',
          description:
            'The second-order, investable consequence — the mechanism and who/what it moves. Causal and specific (the transmission from the development to a price, a market, a decision); never generic filler like "this is significant for the industry".',
        },
        beneficiaries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'The specific company / person / asset / cohort that benefits — include the ticker when stated.' },
              why: { type: 'string', description: 'The SPECIFIC mechanism by which they benefit, drawn from the material.' },
            },
            required: ['name', 'why'],
          },
          description: 'Who stands to BENEFIT, each a named party with the concrete mechanism. Return an EMPTY array when the episode names no clear winner — never invent or pad with "the broader market".',
        },
        atRisk: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'The specific company / person / asset / cohort at risk — include the ticker when stated.' },
              why: { type: 'string', description: 'The SPECIFIC mechanism by which they are threatened, drawn from the material.' },
            },
            required: ['name', 'why'],
          },
          description: 'Who is AT RISK, each a named party with the concrete mechanism. Return an EMPTY array when the episode names no clear loser — never invent or pad.',
        },
        diligenceQuestions: {
          type: 'array',
          items: { type: 'string' },
          description:
            '2-5 FORWARD-LOOKING, checkable research questions whose answers would confirm or kill the thesis — the things a diligent investor would now go verify. NOT a restatement of the episode\'s own Q&A, and not vague ("is this a good investment?"). Each names its specific subject. EMPTY only when the episode genuinely raises none.',
        },
      },
      required: ['whatChanged', 'whyItMatters', 'beneficiaries', 'atRisk', 'diligenceQuestions'],
    },
    quantData: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          metric: { type: 'string', description: 'What the number measures, e.g. "Amazon DSP spend", "Truckload pricing", "Prime Day discount".' },
          value: { type: 'string', description: 'The value EXACTLY as stated, keeping the unit/qualifier, e.g. "$50M in first 5 months of 2026", "up 20-30%", "close to 200".' },
          context: { type: 'string', description: 'The source / comparison / period that makes the number meaningful, e.g. "vs $11.5M in the same period a year prior".' },
        },
        required: ['metric', 'value', 'context'],
      },
      description:
        'Every HARD NUMBER actually stated in the episode — dollar figures, percentages, multiples, counts, dates, growth rates — the data points that feed the Quantitative Summary table. If the material contains ANY numbers, this MUST be non-empty (one row per figure). Quote each value EXACTLY as spoken (never round-to-invent, never infer a figure that was not said). Only return an empty array for an episode with genuinely no figures.',
    },
    tone: {
      type: 'object',
      additionalProperties: false,
      properties: {
        overall: {
          type: 'string',
          enum: ['positive', 'cautious', 'mixed', 'neutral'],
          description: 'The NET tone of the episode, judged from what is actually said: positive (the conversation leans optimistic/bullish), cautious (it leans wary/bearish/concerned), mixed (real sentiment on both sides with no clear net lean), neutral (largely descriptive, little evaluative charge).',
        },
        rationale: {
          type: 'string',
          description: 'ONE sentence (~140-220 chars) explaining the net read, grounded in specifics the episode actually discusses — not a generic gloss.',
        },
        aspects: {
          type: 'array',
          minItems: 3,
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              subject: { type: 'string', description: 'A real company / person / topic the episode genuinely discusses, as a short display name of ~1-4 words (e.g. "SpaceX", "secondary markets", "retail investors").' },
              sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'], description: 'The sentiment the episode expresses TOWARD this subject.' },
              note: { type: 'string', description: 'One short clause/sentence giving the specific reason for that sentiment, drawn from the material.' },
            },
            required: ['subject', 'sentiment', 'note'],
          },
          description: '3-6 entries naming the specific subjects the episode is positive/negative/neutral ABOUT — the "about what" behind the net read. Subjects must be things the episode genuinely discusses; never invent sentiment that was not expressed.',
        },
      },
      required: ['overall', 'rationale', 'aspects'],
    },
  },
  required: ['synthesis', 'qa', 'ideas', 'insight', 'quantData', 'highlights', 'tone'],
}

// The investable-insight rules, kept in a template literal (real newlines, no
// escaping) and appended to SYSTEM_BASE so the giant single-quoted string above
// stays untouched.
const INSIGHT_RULES = `
- insight: this is the INVESTABLE read — what busy investors care most about. whatChanged = the single most important NEW development or shift (the concrete fact: the number, the company, the move), not the topic; if the episode is purely evergreen, state its central claim instead. whyItMatters = the second-order consequence and the mechanism (the transmission to a price/market/decision), never generic filler like "this is significant for the industry". beneficiaries / atRisk = the NAMED winners and losers (include tickers when stated), each with the specific mechanism — return an EMPTY array when none is named, never pad with "the broader market". diligenceQuestions = 2-5 forward-looking, checkable questions a diligent investor would now go verify (NOT a restatement of the episode's own Q&A) — empty only when the episode genuinely raises none.
- quantData: extract every HARD NUMBER actually stated — dollar figures, percentages, multiples, counts, dates, growth rates. If the material contains ANY numbers, quantData MUST be non-empty (one row per figure). Quote each value EXACTLY as spoken (keep the unit/qualifier) with the comparison/period that makes it meaningful. NEVER invent, round-to-invent, or infer a figure that was not said. Only an episode with genuinely no figures may return an empty array. These feed the Quantitative Summary table.`

const SYSTEM_BASE =
  'You are Munshot, an AI that writes sharp one-page intelligence summaries of podcast episodes for busy operators and investors. Produce the summary by calling the emit_summary tool/function. Rules:\n- Base everything ONLY on the provided material. Do NOT invent facts, quotes, names, or numbers.\n- synthesis: go deeper than the headline. Lead with the central argument, then develop it with the specifics that make it credible — concrete claims, real numbers, named companies/people, and the mechanism or causal chain behind each point. Capture the genuine tension or disagreement between speakers (the bull case vs the bear case, what is contested, what is still uncertain), and surface the non-obvious, second-order insight a sharp listener takes away — not a generic recap anyone could write from the title. Every sentence must carry specific, episode-grounded content; cut filler like "the market is maturing" or "X is seeing significant growth". Emphasise only a FEW short key phrases (2-5 words each, at most ~3 per summary) by wrapping each in matched **double asterisks** — never bold whole sentences or clauses, and always close every ** you open.\n- qa: be EXHAUSTIVE — capture every substantive question the episode actually raises and answers, in the order it addresses them, not a curated handful. Exclude only trivial banter, logistics, and ad reads. Make every question specific and self-contained (it should read clearly on its own), and every answer thorough, concrete, and fully understandable without the audio — 2-4 real sentences that explain the "why" and the specifics, never one terse line, but never padded or invented either.\n- ideas: capture every CONCRETE, ACTIONABLE call the episode makes — investment/stock picks (name the ticker/company), trades, macro calls, or bold specific predictions — as a discrete item with who pitched it and the 2-4 key thesis points behind it. Shows with a dedicated pitch segment (e.g. All-In stock picks) must yield one entry per pick. Return an EMPTY list when nothing specific is pitched — never lower the bar to fill it with vague opinions or generic observations, and never invent a call that was not made.\n- highlights: be thorough — surface every genuinely interesting beat the episode delivers (bold claims, specific predictions or numbers, sharp disagreements, surprising data, memorable anecdotes), not just one or two, with each detail concrete about what was actually said — never a generic gloss. Then flag the 4-6 most important, non-obvious ones with key=true — the headline takeaways; a reader who only sees those must walk away with the episode\'s core. Never flag more than half the list.\n- tone: read the episode\'s sentiment from what is ACTUALLY said — never invent a feeling that was not expressed. Set "overall" to the net lean, write "rationale" as ONE grounded sentence, and list 3-6 "aspects": the specific companies/people/topics the episode is positive, negative, or neutral ABOUT, each with a short subject (1-4 words) and a one-clause "note" giving the real reason. Only include subjects the episode genuinely discusses.' + INSIGHT_RULES

const SYSTEM_TRANSCRIPT = `${SYSTEM_BASE}\n- You have the FULL transcript, annotated with [mm:ss] markers. Ground everything in what was actually said.\n- For "highlights", draw them from DIFFERENT parts of the episode — early, middle, and late, not all from the opening — and set each timestamp to the real [mm:ss] of the nearest marker. Never use 0:00.`
const SYSTEM_NOTES = `${SYSTEM_BASE}\n- You only have the publisher's show-notes (not the audio). If they are thin or promotional, keep the summary brief and high-level rather than fabricating. Use "—" for highlight timestamps.\n- With show-notes only, base insight strictly on what the notes assert, and leave beneficiaries, atRisk, and quantData EMPTY rather than guessing.`

function buildPrompt(input: SummarizeInput, transcript: string | null): { system: string; user: string } {
  if (transcript) {
    // ~120k chars ≈ 30k tokens — covers ~2 hr in full; trivial cost on gpt-4o-mini.
    return { system: SYSTEM_TRANSCRIPT, user: `Show: ${input.show}\nEpisode: ${input.title}\n\nTranscript:\n${transcript.slice(0, 120000)}` }
  }
  return { system: SYSTEM_NOTES, user: `Show: ${input.show}\nEpisode: ${input.title}\n\nShow notes:\n${input.notes || '(no show-notes provided)'}` }
}

// server/ is NOT type-checked by `npm run build` (tsconfig includes only src/), and
// the LLM output is untrusted, so validate tone at runtime: drop the whole object if
// the shape is off, and silently discard any malformed aspect rather than crashing.
const TONE_OVERALLS = new Set(['positive', 'cautious', 'mixed', 'neutral'])
const TONE_SENTIMENTS = new Set(['positive', 'negative', 'neutral'])

// What an emit_summary call returns before normalization (no ids yet, loose fields).
type RawSummary = {
  synthesis?: string[]
  qa?: QAItem[]
  ideas?: unknown
  insight?: unknown
  quantData?: unknown
  highlights?: Array<{ title: string; timestamp: string; detail: string; key?: boolean }>
  tone?: unknown
}

const IDEA_KINDS = new Set(['stock', 'trade', 'macro', 'prediction'])

// Validate the LLM's `ideas` at runtime (same untrusted-output discipline as tone):
// drop any entry without a usable headline, coerce a missing proponent to "—", keep
// only string thesis points (max 4), and accept `kind` only from the known set.
function normalizeIdeas(raw: RawSummary | undefined): Idea[] {
  const list = raw?.ideas
  if (!Array.isArray(list)) return []
  const out: Idea[] = []
  for (const it of list as Array<{ idea?: unknown; proponent?: unknown; thesis?: unknown; kind?: unknown }>) {
    if (!it || typeof it !== 'object') continue
    const idea = typeof it.idea === 'string' ? it.idea.trim() : ''
    if (!idea) continue // an idea with no headline is unusable
    const thesis = Array.isArray(it.thesis)
      ? (it.thesis.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()).slice(0, 4))
      : []
    const proponent = typeof it.proponent === 'string' && it.proponent.trim() ? it.proponent.trim() : '—'
    const kind = typeof it.kind === 'string' && IDEA_KINDS.has(it.kind) ? (it.kind as Idea['kind']) : undefined
    out.push({ idea, proponent, thesis, ...(kind ? { kind } : {}) })
  }
  return out
}

// Validate the LLM's named-party lists (beneficiaries / atRisk). Drop any entry
// missing a name or a why; trim; cap so one runaway field can't bloat the doc.
function normalizeParties(v: unknown): InsightParty[] {
  if (!Array.isArray(v)) return []
  const out: InsightParty[] = []
  for (const it of v as Array<{ name?: unknown; why?: unknown }>) {
    if (!it || typeof it !== 'object') continue
    const name = typeof it.name === 'string' ? it.name.trim() : ''
    const why = typeof it.why === 'string' ? it.why.trim() : ''
    if (!name || !why) continue
    out.push({ name, why })
  }
  return out.slice(0, 6)
}

// Validate the LLM's `insight` (same untrusted-output discipline as tone/ideas).
// Returns undefined unless there's a real what-changed or why-it-matters — an
// insight with neither is empty noise, so drop the whole object.
function normalizeInsight(raw: RawSummary | undefined): EpisodeInsight | undefined {
  const i = raw?.insight as { whatChanged?: unknown; whyItMatters?: unknown; beneficiaries?: unknown; atRisk?: unknown; diligenceQuestions?: unknown } | undefined
  if (!i || typeof i !== 'object') return undefined
  const whatChanged = typeof i.whatChanged === 'string' ? i.whatChanged.trim() : ''
  const whyItMatters = typeof i.whyItMatters === 'string' ? i.whyItMatters.trim() : ''
  if (!whatChanged && !whyItMatters) return undefined
  const diligenceQuestions = Array.isArray(i.diligenceQuestions)
    ? (i.diligenceQuestions.filter((q): q is string => typeof q === 'string' && !!q.trim()).map((q) => q.trim()).slice(0, 6))
    : []
  return {
    whatChanged,
    whyItMatters,
    beneficiaries: normalizeParties(i.beneficiaries),
    atRisk: normalizeParties(i.atRisk),
    diligenceQuestions,
  }
}

// Validate the LLM's `quantData`. Drop rows missing a metric or value; coerce a
// missing context to ""; cap so the quant table stays scannable.
function normalizeQuant(raw: RawSummary | undefined): QuantPoint[] {
  const list = raw?.quantData
  if (!Array.isArray(list)) return []
  const out: QuantPoint[] = []
  for (const it of list as Array<{ metric?: unknown; value?: unknown; context?: unknown }>) {
    if (!it || typeof it !== 'object') continue
    const metric = typeof it.metric === 'string' ? it.metric.trim() : ''
    const value = typeof it.value === 'string' ? it.value.trim() : ''
    if (!metric || !value) continue
    const context = typeof it.context === 'string' ? it.context.trim() : ''
    out.push({ metric, value, context })
  }
  return out.slice(0, 20)
}

function normalizeTone(raw: RawSummary | undefined): EpisodeTone | undefined {
  const t = raw?.tone as unknown as { overall?: unknown; rationale?: unknown; aspects?: unknown } | undefined
  if (!t || typeof t !== 'object') return undefined
  if (typeof t.overall !== 'string' || !TONE_OVERALLS.has(t.overall)) return undefined
  if (typeof t.rationale !== 'string' || !Array.isArray(t.aspects)) return undefined
  const aspects = (t.aspects as Array<{ subject?: unknown; sentiment?: unknown; note?: unknown }>)
    .filter((a) => a && typeof a.subject === 'string' && typeof a.sentiment === 'string' && TONE_SENTIMENTS.has(a.sentiment) && typeof a.note === 'string')
    .slice(0, 6)
    .map((a) => ({ subject: a.subject as string, sentiment: a.sentiment as EpisodeTone['aspects'][number]['sentiment'], note: a.note as string }))
  return { overall: t.overall as EpisodeTone['overall'], rationale: t.rationale, aspects }
}

function normalize(raw: RawSummary | undefined): Summary {
  const r = raw ?? {}
  const tone = normalizeTone(raw)
  const ideas = normalizeIdeas(raw)
  const insight = normalizeInsight(raw)
  const quantData = normalizeQuant(raw)
  // Normalize each highlight timestamp to a clean "m:ss" (the model sometimes copies
  // the bracketed transcript marker, e.g. "[12:34]"), sort chronologically (it can
  // emit them out of order), then assign stable ids in display order. Clean timestamps
  // are what lets buildTranscript anchor each highlight to its transcript row.
  // `highlights` is array-guarded: the schema asks for an array, but without strict
  // mode some models emit a single object or omit it — never let a non-array reach
  // the `.map` chains in the UI / PDF.
  const rawHl = Array.isArray(r.highlights) ? r.highlights : []
  const highlights: Highlight[] = rawHl
    .filter((h): h is NonNullable<typeof h> => !!h && typeof h === 'object')
    .map((h) => ({ title: String(h.title ?? ''), detail: String(h.detail ?? ''), timestamp: cleanClock(String(h.timestamp ?? '—')), key: !!h.key }))
    .sort((a, b) => (parseClock(a.timestamp) ?? Number.POSITIVE_INFINITY) - (parseClock(b.timestamp) ?? Number.POSITIVE_INFINITY))
    .map((h, i) => ({ ...h, id: `gen-${i}` }))
  return {
    synthesis: toParagraphs(r.synthesis),
    highlights,
    qa: normalizeQa(r.qa),
    ...(ideas.length ? { ideas } : {}),
    ...(insight ? { insight } : {}),
    ...(quantData.length ? { quantData } : {}),
    ...(tone ? { tone } : {}),
  }
}

// Coerce `synthesis` to a clean string[] regardless of how the model returned it.
// Forced tool-calling isn't strict, so a model may return ONE string instead of the
// array the schema asks for (gpt-4.1 family does this often) — split it into
// paragraphs so the UI/PDF `.map` over paragraphs always works.
function toParagraphs(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim())
  if (typeof v === 'string' && v.trim()) return v.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)
  return []
}

// Keep only well-formed { q, a } pairs (array-guarded, same reason as highlights).
function normalizeQa(v: unknown): QAItem[] {
  if (!Array.isArray(v)) return []
  const out: QAItem[] = []
  for (const it of v as Array<{ q?: unknown; a?: unknown }>) {
    if (!it || typeof it !== 'object') continue
    const q = typeof it.q === 'string' ? it.q.trim() : ''
    const a = typeof it.a === 'string' ? it.a.trim() : ''
    if (q && a) out.push({ q, a })
  }
  return out
}

// Clean a highlight timestamp to a display-ready "m:ss" / "h:mm:ss", or "—" if unparseable.
function cleanClock(ts: string): string {
  const sec = parseClock(ts)
  return sec == null ? '—' : mmss(sec)
}

// ── Transcript display: group raw provider segments into readable rows, and
//    wire each highlight to the nearest row for the Highlights ↔ jump UX ──────

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// Parse a clock string the LLM cites for a highlight ("mm:ss", "h:mm:ss", and even
// bracketed forms like "[12:34]") to seconds. Strips any non-digit/colon noise first
// so a stray marker bracket can't break chronological sorting or transcript anchoring.
function parseClock(ts: string): number | null {
  const parts = (ts || '').replace(/[^\d:]/g, '').split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  return parts.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1]
}

type RawSeg = { start: number; text: string; speaker?: number }

// Some feeds embed speaker labels inline ("Speaker 1: … Speaker 2: …") instead of
// as diarization metadata. Split those into one piece per turn with the speaker
// extracted, so the transcript reads as clean dialogue rather than run-on blocks.
// (Deepgram/Groq text has no such labels, so those pass through untouched.)
function expandInlineSpeakers(raw: RawSeg[]): RawSeg[] {
  const out: RawSeg[] = []
  for (const s of raw) {
    const parts = s.text.split(/\bSpeakers?\s+(\d+):\s*/i) // [lead, num, text, num, text, …]
    if (parts.length === 1) {
      out.push(s)
      continue
    }
    if (parts[0].trim()) out.push({ start: s.start, text: parts[0].trim(), speaker: s.speaker })
    for (let i = 1; i < parts.length; i += 2) {
      const num = Number(parts[i])
      const text = (parts[i + 1] ?? '').trim()
      if (text) out.push({ start: s.start, text, speaker: Number.isFinite(num) ? num - 1 : s.speaker })
    }
  }
  return out
}

// Merge raw cues/utterances into paragraph-sized rows: break on speaker change,
// otherwise accumulate up to ~maxChars so the transcript reads in natural blocks.
function groupSegments(raw: RawSeg[], maxChars = 650): RawSeg[] {
  const out: RawSeg[] = []
  for (const s of raw) {
    const text = s.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && last.speaker === s.speaker && last.text.length + text.length + 1 <= maxChars) {
      last.text = `${last.text} ${text}`
    } else {
      out.push({ start: s.start, text, speaker: s.speaker })
    }
  }
  return out
}

function buildTranscript(raw: RawSeg[], highlights: Highlight[]): { segments: TranscriptSegment[]; highlights: Highlight[] } {
  const grouped = groupSegments(expandInlineSpeakers(raw))
  const segments: TranscriptSegment[] = grouped.map((g, i) => ({
    id: `t${i}`,
    speaker: g.speaker != null ? `Speaker ${g.speaker + 1}` : '',
    role: (g.speaker ?? 0) === 0 ? 'host' : 'guest',
    timestamp: mmss(g.start),
    text: g.text,
  }))

  // Anchor each highlight to the row whose start time is closest to its timestamp,
  // so clicking one jumps to the right place and the row glows.
  const linked = highlights.map((h) => {
    const sec = parseClock(h.timestamp)
    if (sec == null || !grouped.length) return h
    let best = 0
    let bestDelta = Infinity
    grouped.forEach((g, i) => {
      const d = Math.abs(g.start - sec)
      if (d < bestDelta) {
        bestDelta = d
        best = i
      }
    })
    segments[best].highlight = { refId: h.id, quote: '', label: h.title }
    return { ...h, segmentId: segments[best].id }
  })

  return { segments, highlights: linked }
}

// In-memory L1 cache: a within-process fast path (warm worker / dev server). The
// shared store below is the cross-user, cross-instance L2. SUMMARY_REVISION lives
// in summaryStore.ts now (it keys both caches).
const cache = new Map<string, SummarizeResult>()

export async function summarizeEpisode(input: SummarizeInput, config: SummarizeConfig): Promise<SummarizeResult> {
  const provider = config.openaiKey ? 'openai' : config.anthropicKey ? 'anthropic' : null
  if (!provider) throw new Error('no_api_key')
  const model = config.model || (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL)

  // Shared, persistent cache (KV in prod, filesystem in dev), keyed by the stable
  // episode id: the FIRST user to open an episode pays the transcription + LLM
  // cost, and every user after — across browsers and worker instances — reuses
  // it. Checked before transcription so a hit skips that cost too. Only engaged
  // when an id is supplied; the weekly roundup posts no id and is never shared.
  const sharedKey = input.id ? sharedSummaryKey(input.id) : null
  if (!input.force && sharedKey && config.store) {
    const shared = await config.store.get(sharedKey)
    if (shared) return shared
  }

  // Best available source: real transcript (provider chain) > show-notes.
  const transcript = await transcribeEpisode(
    { title: input.title, transcriptUrl: input.transcriptUrl, audioUrl: input.audioUrl },
    { deepgramKey: config.deepgramKey, deepgramModel: config.deepgramModel, groqKey: config.groqKey },
  )
  const prompt = buildPrompt(input, transcript?.text ?? null)

  // Key the in-process L1 cache by the STABLE id (globally unique), not the title:
  // two different episodes that share a title ("Mailbag", "2024 Predictions", and
  // across shows generally) would otherwise collide here and serve each other's
  // summary — and since L1 is checked after the per-id L2 store, an L1 collision
  // shadows the correct L2 entry. The weekly roundup passes a content-derived
  // `weekly:<hash>` id (so it's shared like episodes); any truly id-less call falls
  // back to a hash of its show+notes so distinct inputs still get distinct slots.
  const idPart = input.id ?? `n:${stableHash(`${input.show} ${input.notes ?? ''}`)}`
  const cacheKey = `${provider}:${model}:${transcript ? 't' : 'n'}:r${SUMMARY_REVISION}::${idPart}`
  const hit = input.force ? undefined : cache.get(cacheKey)
  if (hit) return hit

  const raw =
    provider === 'openai'
      ? await viaOpenAI(prompt, config.openaiKey as string, model, SCHEMA)
      : await viaAnthropic(prompt, config.anthropicKey as string, model, SCHEMA)
  const summary = normalize(raw as RawSummary)

  // Bundle the real transcript (the same one the summary was built from) so the
  // Transcript tab renders it — no second transcription, no extra cost.
  let result: SummarizeResult
  if (transcript && transcript.segments.length) {
    const built = buildTranscript(transcript.segments, summary.highlights)
    result = { summary: { ...summary, highlights: built.highlights }, transcript: built.segments, transcriptSource: transcript.source }
  } else {
    result = { summary, transcript: [] }
  }

  if (cache.size > 300) cache.clear()
  cache.set(cacheKey, result)
  // Persist to the shared store so other users / worker instances reuse this work
  // instead of paying for it again (best-effort; never blocks the response).
  if (sharedKey && config.store) await config.store.put(sharedKey, result)
  return result
}

// ── OpenAI (Chat Completions + forced function call) ─────────────────────────
// Returns the RAW parsed tool-call args (caller normalizes). `schema` lets the
// same transport drive both the episode summary and the weekly synthesis.
async function viaOpenAI(prompt: { system: string; user: string }, apiKey: string, model: string, schema: object): Promise<unknown> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      // 16000 leaves room for the richer schema (synthesis + comprehensive Q&A +
      // the investable insight + quant table + the per-episode investment readouts).
      // Keep it under ~16K: this is a non-streaming raw fetch, and larger outputs
      // risk HTTP timeouts.
      max_completion_tokens: 16000,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      tools: [{ type: 'function', function: { name: 'emit_summary', description: 'Emit the structured summary.', parameters: schema } }],
      tool_choice: { type: 'function', function: { name: 'emit_summary' } },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`)
  }
  const data: { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> } = await res.json()
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  if (!args) throw new Error('openai: no function call in response')
  return JSON.parse(args)
}

// ── Anthropic (Messages API + forced tool use) ───────────────────────────────
// Returns the RAW tool-use input (caller normalizes).
async function viaAnthropic(prompt: { system: string; user: string }, apiKey: string, model: string, schema: object): Promise<unknown> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      // Room for the richer schema (comprehensive Q&A + insight + quant + per-episode
      // investment readouts); <~16K keeps this non-streaming request under HTTP timeouts.
      max_tokens: 16000,
      system: prompt.system,
      tools: [{ name: 'emit_summary', description: 'Emit the structured summary.', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'emit_summary' },
      messages: [{ role: 'user', content: prompt.user }],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`)
  }
  const data: { content?: Array<{ type: string; name?: string; input?: unknown }> } = await res.json()
  const toolUse = (data.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'emit_summary')
  if (!toolUse?.input) throw new Error('anthropic: no emit_summary tool_use in response')
  return toolUse.input
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY cross-episode synthesis — the Guidepoint layer. Reuses the same forced-
// tool transport (viaOpenAI/viaAnthropic) with a different schema. Synthesises a
// set of per-episode insights into ONE institutional-style edition: a narrative
// overview, thematic claim-first Key Points, an aggregated quantitative table, a
// comparison-across-sources table, and open questions — all cited [n] against the
// numbered source order the caller passes in (so markers line up with the
// deterministic citation registry). Cached in the shared store under the
// weekly:<hash> id so one episode-set is run through the model once, for everyone.
// ─────────────────────────────────────────────────────────────────────────────

const WEEKLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    overview: {
      type: 'array',
      items: { type: 'string' },
      description:
        '2-3 synthesized paragraphs that LEAD with the most important concrete developments of the week — name the real numbers, companies, and people. State the genuine CONSENSUS across sources AND explicitly call out the OUTLIERS / disagreements. Attach inline citations like [1] [2] to the sources each claim draws on (use the source numbers given in the input). Never write generic filler ("the market is maturing", "AI keeps growing").',
    },
    keyThemes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          heading: { type: 'string', description: 'A specific theme cutting ACROSS episodes (e.g. "Ad budgets shifting to closed-loop measurement"), not a show name.' },
          points: {
            type: 'array',
            items: { type: 'string' },
            description: 'Claim-first bullets: lead with the conclusion in **double asterisks**, then the specifics (numbers, names, mechanism) and a citation [n]. e.g. "**Amazon DSP is taking share**: first-five-month spend rose to $50M from $11.5M as budgets move to OTT [1] [3]".',
          },
        },
        required: ['heading', 'points'],
      },
      description: 'The Key Points — 2-5 themes that synthesise the week ACROSS sources (never one cluster per show). Group related claims from different episodes under one theme.',
    },
    quantTable: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          metric: { type: 'string' },
          value: { type: 'string', description: 'The value EXACTLY as stated in the material.' },
          context: { type: 'string', description: 'The source/comparison/period — append the citation [n].' },
        },
        required: ['metric', 'value', 'context'],
      },
      description: 'The Quantitative Summary — the hard numbers from across the week. Use ONLY figures that appear in the input material; never invent, round-to-invent, or infer. EMPTY when the week states no figures.',
    },
    episodeReadouts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', description: 'The SOURCE NUMBER this readout is about (matches the [n] in the input).' },
          episode: { type: 'string', description: 'A SHORT recognizable label for the episode, e.g. "Holcim CEO", "GameStop / eBay", "AI data centers" — the subject, not the full show title.' },
          theme: { type: 'string', description: 'The single INVESTABLE theme this episode surfaces — specific (e.g. "Low-carbon cement + housing shortage"), never a show name.' },
          evidence: {
            type: 'string',
            description:
              'PODCAST EVIDENCE — ONLY facts, numbers, and direct claims this source ACTUALLY stated. Quote figures EXACTLY as given. Do NOT add any company, number, date, or event not present in THIS source\'s input, and never round-to-invent. If the source gives little hard evidence, say so plainly rather than inventing.',
          },
          interpretation: {
            type: 'string',
            description:
              'INVESTMENT INTERPRETATION — your INFERENCE from the evidence, explicitly framed as a hypothesis ("This suggests…", "If accurate, this implies…"). Never present interpretation as a stated fact.',
          },
          namesSectors: { type: 'string', description: 'Named companies/tickers + sectors implicated, comma-separated (drawn from the source). "—" if none named.' },
          confidence: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'How well the podcast evidence supports the interpretation: High = direct, quantified claims; Medium = clear but partly inferred; Low = thin or speculative.' },
          action: { type: 'string', description: 'What an investor should CHECK next — evidence PLUS explicitly-stated assumptions (e.g. "Verify EBITDA impact of CHF200m; assumes eco-products carry premium pricing").' },
          questionsToVerify: {
            type: 'array',
            items: { type: 'string' },
            description: '2-4 forward-looking EXTERNAL checks that would confirm or kill the interpretation — verifiable OUTSIDE the podcast, not a restatement of the episode\'s own Q&A. EMPTY only if none apply.',
          },
        },
        required: ['index', 'episode', 'theme', 'evidence', 'interpretation', 'namesSectors', 'confidence', 'action', 'questionsToVerify'],
      },
      description:
        'Investment Readout — ONE entry PER source episode, in the input order. Each STRICTLY separates what the podcast ACTUALLY SAID (evidence) from what you INFER (interpretation), with a confidence grade and concrete external checks. This is the centerpiece of the brief.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'The sharpest OPEN questions the week raises — forward-looking and checkable, each naming its subject. EMPTY when none stand out.',
    },
  },
  required: ['overview', 'keyThemes', 'quantTable', 'episodeReadouts', 'questions'],
}

const WEEKLY_SYSTEM =
  'You are Munshot, an AI that writes institutional-grade weekly intelligence briefs for investors, in the style of a sell-side cross-call synthesis. You are given several podcast episodes, each already distilled to its investable insight, as NUMBERED sources. Produce the brief by calling the emit_summary tool/function. Rules:\n' +
  '- SYNTHESISE ACROSS the sources — do NOT restate each one in turn. Find the through-lines: where sources agree, where they disagree, and what the week as a whole means.\n' +
  '- Lead with substance: name the real numbers, companies, people, and calls. Cut generic filler ("the market is maturing", "AI keeps growing").\n' +
  '- CITE everything with [n] markers using the source numbers given — every non-obvious claim, every number, every comparison row points back to its source(s).\n' +
  '- overview: 2-3 paragraphs stating the consensus AND explicitly naming the outliers/disagreements.\n' +
  '- keyThemes: 2-5 themes that cut across episodes (never one per show); each a list of claim-first bullets (the conclusion in **double asterisks**, then specifics + [n]).\n' +
  '- quantTable: only numbers actually present in the material — never invent, round-to-invent, or infer. Append the [n] in context. EMPTY when there are none.\n' +
  '- episodeReadouts: produce ONE readout per source. STRICT EVIDENCE RULE — the "evidence" field may contain ONLY facts, numbers, quotes, and claims that appear in THAT source\'s input; never introduce a company, figure, date, or event the source did not state, and never round-to-invent. Keep evidence and interpretation strictly SEPARATE: "evidence" = what the podcast said; "interpretation" = your inference, always framed as a hypothesis ("this suggests", "if accurate"). Grade "confidence" honestly against the strength of the evidence (High only for direct, quantified claims). "questionsToVerify" and "action" are the EXTERNAL checks a diligent investor would run next — not a restatement of the episode\'s own Q&A. If a source is thin, say so and grade Low rather than fabricating.\n' +
  '- Base EVERYTHING only on the provided sources. Never fabricate a number, a citation, or a disagreement that is not supported by the material.'

/** Render the numbered sources into the LLM user message. Kept here so both the
 *  HTTP path and the cron build the prompt identically. */
function buildWeeklyUser(range: string, sources: WeeklySource[]): string {
  const blocks = sources.map((s) => {
    const lines = [`[${s.index}] ${s.show} — "${s.title}" (${s.date})${s.speaker && s.speaker !== '—' ? `, lead voice: ${s.speaker}` : ''}`]
    if (s.whatChanged) lines.push(`  What changed: ${s.whatChanged}`)
    if (s.whyItMatters) lines.push(`  Why it matters: ${s.whyItMatters}`)
    if (s.beneficiaries) lines.push(`  Beneficiaries: ${s.beneficiaries}`)
    if (s.atRisk) lines.push(`  At risk: ${s.atRisk}`)
    if (s.quant) lines.push(`  Numbers: ${s.quant}`)
    if (s.keyPoints) lines.push(`  Key points: ${s.keyPoints}`)
    if (s.synthesis) lines.push(`  Central argument: ${s.synthesis}`)
    if (s.diligence) lines.push(`  Open diligence: ${s.diligence}`)
    return lines.join('\n')
  })
  return `Weekly cross-source synthesis across ${sources.length} podcast episode${sources.length === 1 ? '' : 's'} from ${range}.\n\nSources:\n${blocks.join('\n\n')}`
}

const strArr = (v: unknown, cap = 12): string[] =>
  Array.isArray(v) ? (v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, cap)) : []

const READOUT_CONFIDENCE = new Set(['Low', 'Medium', 'High'])

// Validate the LLM's weekly output (untrusted — same discipline as normalize()).
function normalizeWeeklyAi(raw: unknown): WeeklyAi {
  const r = (raw ?? {}) as { overview?: unknown; keyThemes?: unknown; quantTable?: unknown; episodeReadouts?: unknown; questions?: unknown }
  const keyThemes: WeeklyTheme[] = Array.isArray(r.keyThemes)
    ? (r.keyThemes as Array<{ heading?: unknown; points?: unknown }>)
        .map((t) => ({ heading: typeof t?.heading === 'string' ? t.heading.trim() : '', points: strArr(t?.points, 10) }))
        .filter((t) => t.heading && t.points.length)
        .slice(0, 8)
    : []
  const quantTable: QuantPoint[] = Array.isArray(r.quantTable)
    ? (r.quantTable as Array<{ metric?: unknown; value?: unknown; context?: unknown }>)
        .map((q) => ({ metric: typeof q?.metric === 'string' ? q.metric.trim() : '', value: typeof q?.value === 'string' ? q.value.trim() : '', context: typeof q?.context === 'string' ? q.context.trim() : '' }))
        .filter((q) => q.metric && q.value)
        .slice(0, 24)
    : []
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const episodeReadouts: WeeklyEpisodeReadout[] = Array.isArray(r.episodeReadouts)
    ? (r.episodeReadouts as Array<Record<string, unknown>>)
        .map((c) => ({
          index: typeof c?.index === 'number' && Number.isFinite(c.index) ? (c.index as number) : 0,
          episode: str(c?.episode),
          theme: str(c?.theme),
          evidence: str(c?.evidence),
          interpretation: str(c?.interpretation),
          namesSectors: str(c?.namesSectors) || '—',
          confidence: (typeof c?.confidence === 'string' && READOUT_CONFIDENCE.has(c.confidence) ? c.confidence : 'Medium') as 'Low' | 'Medium' | 'High',
          action: str(c?.action),
          questionsToVerify: strArr(c?.questionsToVerify, 6),
        }))
        .filter((c) => c.theme && (c.evidence || c.interpretation))
        .slice(0, 30)
    : []
  return { overview: toParagraphs(r.overview).slice(0, 6), keyThemes, quantTable, episodeReadouts, questions: strArr(r.questions, 10) }
}

export interface SynthesizeWeeklyInput {
  /** Content-derived id (`weekly:<hash>`) → shared-store cache key. */
  id?: string
  range: string
  sources: WeeklySource[]
  /** Skip the cache read and regenerate (Refresh). */
  force?: boolean
}

/** Run the weekly cross-episode synthesis. Returns the AI narrative, or null when
 *  no LLM key is configured (callers fall back to the deterministic base). */
export async function synthesizeWeekly(input: SynthesizeWeeklyInput, config: SummarizeConfig): Promise<WeeklyAi | null> {
  const provider = config.openaiKey ? 'openai' : config.anthropicKey ? 'anthropic' : null
  if (!provider) return null
  if (!input.sources.length) return null
  const model = config.model || (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL)

  // Shared-store reuse: the SAME episode-set (same id) is synthesised once total —
  // a browser visit and the Monday cron reuse each other's result.
  const sharedKey = input.id ? sharedSummaryKey(input.id) : null
  if (!input.force && sharedKey && config.store) {
    const cached = await config.store.get(sharedKey)
    if (cached?.weekly) return cached.weekly
  }

  const prompt = { system: WEEKLY_SYSTEM, user: buildWeeklyUser(input.range, input.sources) }
  const raw =
    provider === 'openai'
      ? await viaOpenAI(prompt, config.openaiKey as string, model, WEEKLY_SCHEMA)
      : await viaAnthropic(prompt, config.anthropicKey as string, model, WEEKLY_SCHEMA)
  const ai = normalizeWeeklyAi(raw)

  // Cache under the weekly id (stub `summary` — only `weekly` is read back for this key).
  if (sharedKey && config.store) {
    await config.store.put(sharedKey, { summary: { synthesis: [], highlights: [], qa: [] }, transcript: [], weekly: ai })
  }
  return ai
}
