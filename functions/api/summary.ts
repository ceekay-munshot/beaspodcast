import { summarizeEpisode, synthesizeWeekly, type SynthesizeWeeklyInput } from '../../server/summarize'
import { kvSummaryStore, type KVNamespace } from '../../server/summaryStore'

// Cloudflare Pages Function → POST /api/summary (production).
// Reads the API key from the Pages project env (Settings → Variables → add
// OPENAI_API_KEY or ANTHROPIC_API_KEY as an encrypted secret). Provider is
// auto-detected by which key is present. Mirrors the Vite dev middleware.
// SUMMARIES (a KV namespace binding) is the shared, persistent summary cache:
// when bound, a processed episode is reused across all users instead of recomputed.
//
// LLM_PROVIDER (optional, defaults to "openai") — set to "claude" to route
// through AWS Bedrock instead, using the `temp_claude_token` secret as the
// Bedrock bearer key (see server/bedrockClaude.ts). AWS_BEDROCK_REGION /
// AWS_BEDROCK_MODEL_ID optionally override the region/model defaults.
export const onRequestPost = async (context: {
  request: Request
  env: {
    OPENAI_API_KEY?: string
    ANTHROPIC_API_KEY?: string
    SUMMARY_MODEL?: string
    GROQ_API_KEY?: string
    DEEPGRAM_API_KEY?: string
    DEEPGRAM_MODEL?: string
    SUMMARIES?: KVNamespace
    LLM_PROVIDER?: string
    temp_claude_token?: string
    AWS_BEDROCK_REGION?: string
    AWS_BEDROCK_MODEL_ID?: string
  }
}): Promise<Response> => {
  const config = {
    openaiKey: context.env?.OPENAI_API_KEY,
    anthropicKey: context.env?.ANTHROPIC_API_KEY,
    model: context.env?.SUMMARY_MODEL || undefined,
    deepgramKey: context.env?.DEEPGRAM_API_KEY, // transcription for long episodes
    deepgramModel: context.env?.DEEPGRAM_MODEL || undefined,
    groqKey: context.env?.GROQ_API_KEY, // free-tier Whisper (short episodes)
    // Shared cache — absent binding degrades gracefully to per-request compute.
    store: context.env?.SUMMARIES ? kvSummaryStore(context.env.SUMMARIES) : undefined,
    // Claude/Bedrock toggle — defaults to "openai" so existing deployments are unaffected.
    llmProvider: context.env?.LLM_PROVIDER === 'claude' ? ('claude' as const) : ('openai' as const),
    bedrockKey: context.env?.temp_claude_token,
    bedrockRegion: context.env?.AWS_BEDROCK_REGION || undefined,
    bedrockModel: context.env?.AWS_BEDROCK_MODEL_ID || undefined,
  }
  const headers = { 'content-type': 'application/json' }

  if (!config.openaiKey && !config.anthropicKey && !(config.llmProvider === 'claude' && config.bedrockKey)) {
    return new Response(JSON.stringify({ error: 'no_api_key' }), { status: 503, headers })
  }

  try {
    const input = (await context.request.json()) as ({ mode?: 'episode' | 'weekly' } & Record<string, unknown>)
    // Weekly cross-episode synthesis (the Guidepoint layer) shares this endpoint —
    // it just drives a different schema/prompt and returns { weekly: WeeklyAi }.
    if (input.mode === 'weekly') {
      const weekly = await synthesizeWeekly(input as unknown as SynthesizeWeeklyInput, config)
      return new Response(JSON.stringify({ weekly }), { headers })
    }
    const result = await summarizeEpisode(input as unknown as { title: string; show: string; notes: string }, config) // { summary, transcript, transcriptSource }
    return new Response(JSON.stringify(result), { headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'summarize_failed', detail: String(e).slice(0, 200) }), { status: 502, headers })
  }
}
