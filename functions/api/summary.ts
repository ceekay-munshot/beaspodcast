import { providerChain, summarizeEpisode, synthesizeWeekly, type SynthesizeWeeklyInput } from '../../server/summarize'
import { llmConfigFromEnv, type LlmEnv } from '../../server/llmConfig'
import { kvSummaryStore, type KVNamespace } from '../../server/summaryStore'

// Cloudflare Pages Function → POST /api/summary (production).
// Reads its secrets from the `env` BINDING (Workers → Settings → Variables and
// Secrets) — never process.env, which does not exist on the Workers runtime.
// SUMMARIES (a KV namespace binding) is the shared, persistent summary cache:
// when bound, a processed episode is reused across all users instead of recomputed.
//
// LLM provider: Claude via Amazon Bedrock is PRIMARY whenever BEDROCK_API_KEY is
// bound, with OpenAI/Anthropic behind it as automatic fallbacks. Set LLM_PROVIDER
// to "openai" to flip the order back. AWS_BEDROCK_REGION / AWS_BEDROCK_MODEL_ID
// override the region and pin a model. See server/llmConfig.ts.
export const onRequestPost = async (context: {
  request: Request
  env: LlmEnv & {
    GROQ_API_KEY?: string
    DEEPGRAM_API_KEY?: string
    DEEPGRAM_MODEL?: string
    SUMMARIES?: KVNamespace
  }
}): Promise<Response> => {
  const config = {
    ...llmConfigFromEnv(context.env),
    deepgramKey: context.env?.DEEPGRAM_API_KEY, // transcription for long episodes
    deepgramModel: context.env?.DEEPGRAM_MODEL || undefined,
    groqKey: context.env?.GROQ_API_KEY, // free-tier Whisper (short episodes)
    // Shared cache — absent binding degrades gracefully to per-request compute.
    store: context.env?.SUMMARIES ? kvSummaryStore(context.env.SUMMARIES) : undefined,
  }
  const headers = { 'content-type': 'application/json' }

  if (!providerChain(config).length) {
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
