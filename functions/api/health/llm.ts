import { probeLlm } from '../../../server/summarize'
import { llmConfigFromEnv, llmCredentialsPresent, redactSecrets, type LlmEnv } from '../../../server/llmConfig'
import { DEFAULT_BEDROCK_REGION } from '../../../server/bedrockClaude'

// Cloudflare Pages Function → GET /api/health/llm
//
// Confirms in ten seconds that the LLM wiring actually works, without kicking off
// any real summarization. Makes ONE deliberately tiny structured call through the
// same provider chain /api/summary uses, and reports which provider and model
// answered. A 200 here means the credential, the endpoint, the model grant and
// the structured-output form are all genuinely good.
//
// It ALSO reports whether the transcription keys are visible to the Worker. Those
// are not exercised (that would mean downloading and transcribing real audio), but
// presence alone answers the question that actually blocks people: "did the secret
// I just added in the dashboard reach the deployed app?" A key added without a
// redeploy, or added to the wrong environment, shows up here as false.
//
// The API key is read from the `env` BINDING (env.BEDROCK_API_KEY) — never
// process.env, and never at module top level, neither of which exists on Workers.
// No key ever appears in the response: only booleans for which credentials are
// bound, plus a redaction pass over any error detail.

type HealthEnv = LlmEnv & { DEEPGRAM_API_KEY?: string; GROQ_API_KEY?: string }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export const onRequestGet = async (context: { env: HealthEnv }): Promise<Response> => {
  const config = llmConfigFromEnv(context.env)
  const configured = llmCredentialsPresent(config)
  const region = config.bedrockRegion || DEFAULT_BEDROCK_REGION

  // Booleans only — never the value.
  const transcription = {
    deepgram: !!context.env?.DEEPGRAM_API_KEY,
    groq: !!context.env?.GROQ_API_KEY,
  }
  // Without one of these, an episode whose feed carries no transcript can only be
  // summarised from show-notes, and the Transcript tab stays empty by design.
  const transcriptsPossible = transcription.deepgram || transcription.groq

  if (!configured.bedrock && !configured.openai && !configured.anthropic) {
    return json(503, {
      ok: false,
      error: 'no_api_key',
      detail: 'No LLM credential is bound to this deployment.',
      configured,
      transcription,
      transcriptsPossible,
    })
  }

  try {
    const probe = await probeLlm(config)
    return json(200, {
      ok: true,
      provider: probe.provider,
      model: probe.model,
      ...(probe.structuredMode ? { structuredMode: probe.structuredMode } : {}),
      ...(probe.provider === 'bedrock' ? { region } : {}),
      chain: probe.chain,
      configured,
      transcription,
      transcriptsPossible,
      ms: probe.ms,
    })
  } catch (e) {
    return json(502, {
      ok: false,
      error: 'llm_unreachable',
      detail: redactSecrets(String(e), config).slice(0, 500),
      chain: [],
      configured,
      transcription,
      transcriptsPossible,
      ...(configured.bedrock ? { region } : {}),
    })
  }
}
