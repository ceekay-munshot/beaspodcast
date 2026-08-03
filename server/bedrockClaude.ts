// ─────────────────────────────────────────────────────────────────────────────
// Claude via Amazon Bedrock — the Messages-API ("Mantle") endpoint.
//
// TRANSPORT ONLY. This module speaks HTTP to Bedrock and returns the RAW parsed
// structured object — the same shape viaOpenAI/viaAnthropic return in
// summarize.ts — so the caller's normalize() step, and therefore every
// client-visible response shape, is identical whichever provider answered.
// Prompts and schemas are owned by summarize.ts and passed through untouched.
//
//   Endpoint  https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages
//   Auth      the Bedrock API key as a bearer token in the `x-api-key` header
//             (NOT `Authorization`), plus `anthropic-version: 2023-06-01`.
//   Signing   none. No AWS SDK, no SigV4 — which is exactly what lets this run
//             on the Cloudflare Workers runtime.
//   Models    carry an `anthropic.` provider prefix (anthropic.claude-opus-5).
//
// Docs: https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
//
// NOTE: this is deliberately a non-streaming request. max_tokens is 16000, well
// under the threshold where a non-streaming call risks an HTTP timeout, and the
// callers need the whole structured object before they can do anything with it.
// If this ever becomes streaming, parse the SSE with `res.body.getReader()` and
// buffer across chunks — `for await (const chunk of res.body)` is Node-only and
// throws on Workers, and SSE frames split mid-line. Tool payloads also stream as
// `input_json_delta`, not `text_delta`.
// ─────────────────────────────────────────────────────────────────────────────

/** Region is a Worker variable (AWS_BEDROCK_REGION); this is the fallback. */
export const DEFAULT_BEDROCK_REGION = 'us-east-1'

/** Tried in order — the first model that answers is pinned for the isolate's life.
 *  Bedrock grants model access per ACCOUNT, so Opus 5 commonly returns 403 while
 *  Opus 4.8 and Sonnet 5 are open to all Bedrock customers. Hence a chain rather
 *  than a single id: a 403 is an expected, recoverable outcome here, not an error. */
export const BEDROCK_MODEL_CHAIN = [
  'anthropic.claude-opus-5',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-sonnet-5',
] as const

/** How the structured JSON is requested. `json_schema` is the native structured-
 *  output parameter; `tool` is forced single-tool use, which every Bedrock
 *  deployment supports. Some deployments reject `output_config` outright
 *  ("output_config.format: Extra inputs are not permitted"), so we try the native
 *  form first and pin whichever one actually works. */
export type StructuredMode = 'json_schema' | 'tool'
const STRUCTURED_MODES: readonly StructuredMode[] = ['json_schema', 'tool']

const TOOL_NAME = 'emit_summary'
const TOOL_DESCRIPTION = 'Emit the structured summary.'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 16000

export interface BedrockCallOptions {
  /** The Bedrock API key. Read from the Worker `env` binding by the caller —
   *  never from module scope or process.env, neither of which exists on Workers. */
  apiKey: string
  region?: string
  /** Explicit model override (AWS_BEDROCK_MODEL_ID). Skips the chain's ordering
   *  but still falls back if that model is not granted to this account. */
  model?: string
  maxTokens?: number
}

export interface BedrockCallResult {
  /** The raw structured object, exactly as the model produced it. */
  raw: unknown
  /** Which model actually answered — surfaced by /api/health/llm. */
  model: string
  /** Which structured-output form actually worked. */
  structuredMode: StructuredMode
  region: string
}

// ── Discovery pinning ────────────────────────────────────────────────────────
// Finding the granted model and the working structured-output form costs one or
// two extra round trips. Remember the answer per (region, model-override) so
// only the first call in a warm isolate pays for it. A pinned value is tried
// FIRST but is never the only candidate — access can be revoked, so the rest of
// the chain stays available as fallback.

type Pin = { model?: string; structuredMode?: StructuredMode }
const pins = new Map<string, Pin>()
const pinKey = (region: string, modelOverride?: string): string => `${region}|${modelOverride ?? ''}`

/** Order candidates so a previously-successful value is tried first, without
 *  dropping the others. */
function preferPinned<T>(pinned: T | undefined, all: readonly T[]): T[] {
  if (!pinned) return [...all]
  return [pinned, ...all.filter((c) => c !== pinned)]
}

/** The model label to use for cache keys before a call has been made. Stable
 *  within an isolate once discovery has run. */
export function plannedBedrockModel(region: string | undefined, modelOverride?: string): string {
  if (modelOverride) return modelOverride
  return pins.get(pinKey(region || DEFAULT_BEDROCK_REGION, modelOverride))?.model ?? 'auto'
}

// ── Error classification ─────────────────────────────────────────────────────

/** 403 = model not granted to this account; 404 = unknown model in this region.
 *  Both mean "try the next model in the chain", not "fail the request". */
const isModelAccessError = (status: number): boolean => status === 403 || status === 404

/** Deployments without native structured outputs reject the parameter itself.
 *  That is a signal to switch to forced tool use, not a reason to fail. */
function isOutputConfigRejected(status: number, body: string): boolean {
  if (status !== 400) return false
  const b = body.toLowerCase()
  return b.includes('output_config') || (b.includes('extra inputs') && b.includes('not permitted'))
}

// ── Request / response ───────────────────────────────────────────────────────

interface BedrockContentBlock {
  type: string
  text?: string
  name?: string
  input?: unknown
}
interface BedrockMessageResponse {
  content?: BedrockContentBlock[]
  stop_reason?: string
  model?: string
}

function buildBody(
  prompt: { system: string; user: string },
  model: string,
  schema: object,
  mode: StructuredMode,
  maxTokens: number,
): Record<string, unknown> {
  const base = {
    model,
    max_tokens: maxTokens,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    // NO `temperature` / `top_p` / `top_k`. Sampling parameters were removed on
    // Opus 5 / 4.8 / 4.7 and Sonnet 5 — sending any of them is a hard 400.
  }
  if (mode === 'json_schema') {
    return { ...base, output_config: { format: { type: 'json_schema', schema } } }
  }
  return {
    ...base,
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: schema }],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  }
}

function extractStructured(data: BedrockMessageResponse, mode: StructuredMode): unknown {
  // Check the stop reason first: a refusal or a truncated response yields content
  // that fails to parse in confusing ways. Naming the real cause lets the caller's
  // provider fallback log something actionable.
  if (data.stop_reason === 'refusal') throw new Error('bedrock: request was declined by safety classifiers (stop_reason=refusal)')
  if (data.stop_reason === 'max_tokens') throw new Error('bedrock: response hit max_tokens before the structured output was complete')

  const content = data.content ?? []
  if (mode === 'tool') {
    const toolUse = content.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME)
    if (!toolUse || toolUse.input === undefined) throw new Error(`bedrock: no ${TOOL_NAME} tool_use in response`)
    return toolUse.input
  }
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
  if (!text) throw new Error('bedrock: empty json_schema response')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('bedrock: json_schema response was not valid JSON')
  }
}

/**
 * Call Claude on Bedrock and return the raw structured object.
 *
 * Walks the model chain (403/404 ⇒ next model) and, per model, the structured-
 * output forms (output_config rejected ⇒ forced tool use). Any other non-OK
 * status throws so the caller's provider chain can fall back to OpenAI.
 */
export async function callBedrockClaude(
  prompt: { system: string; user: string },
  schema: object,
  opts: BedrockCallOptions,
): Promise<BedrockCallResult> {
  const region = opts.region || DEFAULT_BEDROCK_REGION
  const url = `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const key = pinKey(region, opts.model)
  const pin = pins.get(key) ?? {}

  // An explicit model override still gets the access-fallback chain behind it,
  // so a mis-set AWS_BEDROCK_MODEL_ID degrades instead of hard-failing.
  const models = opts.model
    ? [opts.model, ...BEDROCK_MODEL_CHAIN.filter((m) => m !== opts.model)]
    : preferPinned(pin.model, BEDROCK_MODEL_CHAIN)
  const modes = preferPinned(pin.structuredMode, STRUCTURED_MODES)

  let lastError: Error | null = null

  for (const model of models) {
    for (const mode of modes) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Bearer token goes in x-api-key, NOT Authorization.
          'x-api-key': opts.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildBody(prompt, model, schema, mode, maxTokens)),
      })

      if (res.ok) {
        const data = (await res.json()) as BedrockMessageResponse
        const raw = extractStructured(data, mode)
        pins.set(key, { model, structuredMode: mode })
        return { raw, model, structuredMode: mode, region }
      }

      const body = await res.text().catch(() => '')
      const detail = `bedrock ${res.status} (${model}/${mode}): ${body.slice(0, 200)}`

      // This deployment does not accept output_config — retry the same model with
      // forced tool use.
      if (isOutputConfigRejected(res.status, body)) {
        lastError = new Error(detail)
        continue
      }
      // This account has no access to this model — move to the next one. A pinned
      // model that starts failing this way is dropped so discovery re-runs.
      if (isModelAccessError(res.status)) {
        lastError = new Error(detail)
        if (pin.model === model) pins.set(key, { ...pin, model: undefined })
        break
      }
      // Anything else (429, 5xx, malformed request) is a real failure: throw so
      // the caller falls back to the next PROVIDER rather than silently burning
      // quota against every model in the chain.
      throw new Error(detail)
    }
  }

  throw lastError ?? new Error('bedrock: no model in the fallback chain was reachable')
}

/** Whether a Bedrock key is configured — the presence check that makes Bedrock
 *  the primary provider. */
export function isBedrockConfigured(config: { bedrockKey?: string } | undefined): boolean {
  return !!config?.bedrockKey
}
