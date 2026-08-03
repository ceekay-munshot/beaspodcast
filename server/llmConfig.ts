// ─────────────────────────────────────────────────────────────────────────────
// One place that turns an environment record into the LLM half of a
// SummarizeConfig. Every entry point uses it — /api/summary, the weekly-digest
// cron, /api/health/llm, and the Vite dev middleware — so the health check
// exercises exactly the configuration the real work runs on. Drift here would
// make a green health check meaningless.
//
// On Cloudflare Workers these values arrive on the `env` BINDING passed to each
// Function, never `process.env` (which does not exist there) and never at module
// top level (bindings are not available at import time). Callers pass `env` in.
// ─────────────────────────────────────────────────────────────────────────────

import { parseLlmProvider, type SummarizeConfig } from './summarize'

/** The env vars/secrets that select and configure the LLM provider. */
export interface LlmEnv {
  /** The Bedrock API key (Workers → Settings → Variables and Secrets). Its
   *  presence alone makes Claude via Bedrock the PRIMARY provider. */
  BEDROCK_API_KEY?: string
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  SUMMARY_MODEL?: string
  /** 'bedrock' | 'openai' | 'anthropic' ('claude' accepted as a legacy alias for
   *  'bedrock'). Promotes one provider to the front of the chain; the others stay
   *  behind it as automatic fallbacks. This is the switch back to OpenAI. */
  LLM_PROVIDER?: string
  /** Bedrock region. Defaults to us-east-1 (see bedrockClaude.ts). */
  AWS_BEDROCK_REGION?: string
  /** Pins one Bedrock model instead of walking the built-in fallback chain. */
  AWS_BEDROCK_MODEL_ID?: string
  /** Thinking depth: low | medium | high | xhigh | max. Defaults to `low`, which
   *  is what keeps a transcript-sized summary inside the request budget. Raise it
   *  for more thorough summaries at the cost of latency. */
  BEDROCK_EFFORT?: string
  /** Legacy name the Bedrock key was first deployed under — still honoured so an
   *  existing deployment keeps working after this rename. Prefer BEDROCK_API_KEY. */
  temp_claude_token?: string
}

export type LlmConfig = Pick<
  SummarizeConfig,
  'openaiKey' | 'anthropicKey' | 'model' | 'llmProvider' | 'bedrockKey' | 'bedrockRegion' | 'bedrockModel' | 'bedrockEffort'
>

export function llmConfigFromEnv(env: LlmEnv | undefined): LlmConfig {
  const e = env ?? {}
  return {
    openaiKey: e.OPENAI_API_KEY || undefined,
    anthropicKey: e.ANTHROPIC_API_KEY || undefined,
    model: e.SUMMARY_MODEL || undefined,
    llmProvider: parseLlmProvider(e.LLM_PROVIDER),
    bedrockKey: e.BEDROCK_API_KEY || e.temp_claude_token || undefined,
    bedrockRegion: e.AWS_BEDROCK_REGION || undefined,
    bedrockModel: e.AWS_BEDROCK_MODEL_ID || undefined,
    bedrockEffort: e.BEDROCK_EFFORT || undefined,
  }
}

/** Which credentials are bound — booleans ONLY. Never returns a key or any part
 *  of one; this is safe to serialise into an HTTP response. */
export function llmCredentialsPresent(config: LlmConfig): { bedrock: boolean; openai: boolean; anthropic: boolean } {
  return { bedrock: !!config.bedrockKey, openai: !!config.openaiKey, anthropic: !!config.anthropicKey }
}

/** Belt-and-braces scrub for anything echoed back to a client: replaces any
 *  configured secret value found in `text` with a placeholder. Upstream errors
 *  should never contain the key, but a health endpoint that returns error detail
 *  is exactly where that assumption must not be load-bearing. */
export function redactSecrets(text: string, config: LlmConfig): string {
  let out = text
  for (const secret of [config.bedrockKey, config.openaiKey, config.anthropicKey]) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  return out
}
