import { getLiveEpisodes } from '../../../server/feeds'
import { transcribeEpisode } from '../../../server/transcribe'
import { providerChain, summarizeEpisode } from '../../../server/summarize'
import { llmConfigFromEnv, redactSecrets, type LlmEnv } from '../../../server/llmConfig'
import { kvSummaryStore, type KVNamespace } from '../../../server/summaryStore'

// Cloudflare Pages Function → GET /api/health/summarize
//
// Runs the REAL end-to-end pipeline for one episode — transcribe, then the LLM —
// and reports where it fails and how long each stage took.
//
// Why this exists: a forced Refresh that fails is invisible in the UI. The client
// only calls setStatus('failed') when `needsSummary` is true, so a refresh of an
// episode that ALREADY has a summary swallows the error and leaves the previous
// summary on screen. From the outside that is indistinguishable from "nothing
// happened". This route runs the same code path and returns the exception.
//
// Defaults to the newest episode that has audio, so it needs no parameters.
// ?id=<episode id> targets a specific one. Nothing is written to the shared
// cache — this is a probe, not a re-processing run.

interface SummarizeHealthEnv extends LlmEnv {
  DEEPGRAM_API_KEY?: string
  DEEPGRAM_MODEL?: string
  GROQ_API_KEY?: string
  SUMMARIES?: KVNamespace
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export const onRequestGet = async (context: { request: Request; env: SummarizeHealthEnv }): Promise<Response> => {
  const env = context.env ?? {}
  const wantedId = new URL(context.request.url).searchParams.get('id')
  const llm = llmConfigFromEnv(env)
  const config = {
    ...llm,
    deepgramKey: env.DEEPGRAM_API_KEY,
    deepgramModel: env.DEEPGRAM_MODEL || undefined,
    groqKey: env.GROQ_API_KEY,
    // No `store`: never let a probe overwrite the shared cache.
  }

  if (!providerChain(config).length) return json(503, { ok: false, stage: 'config', error: 'no_api_key' })

  // ── Pick the episode ───────────────────────────────────────────────────────
  let episode
  try {
    const episodes = await getLiveEpisodes()
    episode = wantedId ? episodes.find((e) => e.id === wantedId) : episodes.find((e) => e.audioUrl || e.transcriptUrl)
    if (!episode) return json(404, { ok: false, stage: 'episode', error: wantedId ? 'episode_not_found' : 'no_episode_with_audio' })
  } catch (e) {
    return json(502, { ok: false, stage: 'feed', detail: String(e).slice(0, 300) })
  }

  const meta = {
    id: episode.id,
    title: episode.title,
    hasAudio: !!episode.audioUrl,
    hasFeedTranscript: !!episode.transcriptUrl,
    notesChars: episode.notes?.length ?? 0,
  }

  // ── Stage 1: transcription ─────────────────────────────────────────────────
  let transcriptChars = 0
  let transcriptSource: string | null = null
  let transcribeMs = 0
  try {
    const t0 = Date.now()
    const t = await transcribeEpisode(
      { title: episode.title, transcriptUrl: episode.transcriptUrl, audioUrl: episode.audioUrl },
      { deepgramKey: config.deepgramKey, deepgramModel: config.deepgramModel, groqKey: config.groqKey },
    )
    transcribeMs = Date.now() - t0
    transcriptChars = t?.text.length ?? 0
    transcriptSource = t?.source ?? null
  } catch (e) {
    return json(502, { ok: false, stage: 'transcribe', episode: meta, detail: redactSecrets(String(e), llm).slice(0, 400) })
  }

  // ── Stage 2: the LLM call, on the real transcript ──────────────────────────
  // This is the stage a big transcript changes most: the input grows and the
  // structured output gets much larger, so a timeout or a truncated response
  // shows up here and nowhere else.
  const t1 = Date.now()
  try {
    const result = await summarizeEpisode(
      {
        id: episode.id,
        title: episode.title,
        show: episode.podcastId,
        notes: episode.notes,
        transcriptUrl: episode.transcriptUrl,
        audioUrl: episode.audioUrl,
        force: true, // exactly what the Refresh button does
      },
      config,
    )
    const summarizeMs = Date.now() - t1
    return json(200, {
      ok: true,
      episode: meta,
      transcribe: { ms: transcribeMs, source: transcriptSource, chars: transcriptChars },
      summarize: {
        ms: summarizeMs,
        synthesisParagraphs: result.summary.synthesis.length,
        qa: result.summary.qa.length,
        highlights: result.summary.highlights.length,
        quantRows: result.summary.quantData?.length ?? 0,
        transcriptSegments: result.transcript.length,
      },
      totalMs: transcribeMs + summarizeMs,
    })
  } catch (e) {
    return json(502, {
      ok: false,
      stage: 'summarize',
      episode: meta,
      transcribe: { ms: transcribeMs, source: transcriptSource, chars: transcriptChars },
      summarizeMs: Date.now() - t1,
      // The exception the Refresh button throws away.
      detail: redactSecrets(String(e), llm).slice(0, 600),
    })
  }
}
