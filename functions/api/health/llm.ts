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
// The API key is read from the `env` BINDING (env.BEDROCK_API_KEY) — never
// process.env, and never at module top level, neither of which exists on Workers.
// The key never appears in the response: only booleans for which credentials are
// bound, plus a redaction pass over any error detail.

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export const onRequestGet = async (context: { env: LlmEnv }): Promise<Response> => {
  const config = llmConfigFromEnv(context.env)
  const configured = llmCredentialsPresent(config)
  const region = config.bedrockRegion || DEFAULT_BEDROCK_REGION

  if (!configured.bedrock && !configured.openai && !configured.anthropic) {
    return json(503, { ok: false, error: 'no_api_key', detail: 'No LLM credential is bound to this deployment.', configured })
  }

  try {
    const probe = await probeLlm(config)
    return json(200, {
      ok: true,
      provider: probe.provider,
      model: probe.model,
      ...(probe.provider === 'bedrock' ? { region } : {}),
      chain: probe.chain,
      configured,
      ms: probe.ms,
    })
  } catch (e) {
    return json(502, {
      ok: false,
      error: 'llm_unreachable',
      detail: redactSecrets(String(e), config).slice(0, 500),
      chain: [],
      configured,
      ...(configured.bedrock ? { region } : {}),
    })
  }
}
