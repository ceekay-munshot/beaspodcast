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
// STREAMING. Requests are streamed and the SSE is parsed with
// `res.body.getReader()` — `for await (const chunk of res.body)` is Node-only and
// throws on the Workers runtime. Frames split mid-line across chunks, so the
// reader buffers and only consumes complete lines. Tool payloads arrive as
// `input_json_delta` (NOT `text_delta`) and are concatenated into the tool input.
//
// Streaming is not optional here. Claude Opus 5 has thinking ON by default, and
// `max_tokens` bounds thinking PLUS the response, so a large structured summary
// over a full podcast transcript runs long enough that a non-streaming request
// stalls until the connection is dropped — which surfaces to the user as a
// request that hangs forever rather than as an error.
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

// Room for adaptive thinking AND a full transcript-grade summary. On Opus 5 the
// two share this budget, so the old 16000 (sized for a non-thinking model writing
// the answer alone) truncates once a real transcript is in play. Safe to raise
// only because the request is streamed.
const DEFAULT_MAX_TOKENS = 32000

/** Opus 5's own default is `high`. On a transcript-sized summarization that
 *  thinks for minutes; `low` is markedly faster and, on this model, still strong.
 *  Raise via BEDROCK_EFFORT when latency is not the binding constraint. */
const DEFAULT_EFFORT = 'low'

/** Fail loudly rather than hang. Chosen to land inside the edge's own request
 *  budget so the caller sees a timeout instead of a dropped connection. */
const DEFAULT_TIMEOUT_MS = 100_000

export interface BedrockCallOptions {
  /** The Bedrock API key. Read from the Worker `env` binding by the caller —
   *  never from module scope or process.env, neither of which exists on Workers. */
  apiKey: string
  region?: string
  /** Explicit model override (AWS_BEDROCK_MODEL_ID). Skips the chain's ordering
   *  but still falls back if that model is not granted to this account. */
  model?: string
  maxTokens?: number
  /** Thinking depth: low | medium | high | xhigh | max. Opus 5 defaults to HIGH,
   *  which on a full transcript thinks long enough to stall the request — this is
   *  the main latency lever. Rides in `output_config`, so it is dropped
   *  automatically on deployments that reject that field. */
  effort?: string
  /** Hard ceiling on one attempt. Without it a slow generation hangs until the
   *  connection is dropped, which reads as "the page never loads" rather than an
   *  error anyone can act on. */
  timeoutMs?: number
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

type Pin = { model?: string; structuredMode?: StructuredMode; outputConfigOk?: boolean }
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

function buildBody(
  prompt: { system: string; user: string },
  model: string,
  schema: object,
  mode: StructuredMode,
  maxTokens: number,
  effort?: string,
): Record<string, unknown> {
  const base = {
    model,
    max_tokens: maxTokens,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    // Streamed so a long thinking+output run can't stall the connection.
    stream: true,
    // NO `temperature` / `top_p` / `top_k`. Sampling parameters were removed on
    // Opus 5 / 4.8 / 4.7 and Sonnet 5 — sending any of them is a hard 400.
  }
  if (mode === 'json_schema') {
    return { ...base, output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema } } }
  }
  return {
    ...base,
    // `effort` is the only reason a tool-mode request carries output_config at
    // all; omitted entirely when unsupported or unset.
    ...(effort ? { output_config: { effort } } : {}),
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: schema }],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  }
}

/** One thing to try: a structured-output form, with or without output_config. */
type Attempt = { mode: StructuredMode; effort?: string }

/** Ordered attempts for a model. A deployment that rejects output_config loses
 *  BOTH native structured output and the effort knob, so the last attempt always
 *  carries neither and is guaranteed to be a shape every deployment accepts. */
function attemptsFor(pin: Pin, effort?: string): Attempt[] {
  const out: Attempt[] = []
  const outputConfigUsable = pin.outputConfigOk !== false
  if (pin.structuredMode !== 'tool' && outputConfigUsable) out.push({ mode: 'json_schema', effort })
  if (outputConfigUsable && effort) out.push({ mode: 'tool', effort })
  out.push({ mode: 'tool' })
  return out
}

/**
 * Read a streamed Messages-API response and return the structured payload.
 *
 * Uses `res.body.getReader()` — the async-iterator form of a response body is a
 * Node-only extension and throws on Workers. Chunk boundaries do not respect SSE
 * frame boundaries, so `buffer` holds the trailing partial line until the rest of
 * it arrives.
 */
async function readStructuredStream(res: Response, mode: StructuredMode): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('bedrock: streamed response had no readable body')

  const decoder = new TextDecoder()
  let buffer = ''
  let toolJson = '' // concatenated input_json_delta fragments (tool mode)
  let text = '' // concatenated text_delta fragments (json_schema mode)
  let stopReason: string | null = null
  let inTargetTool = false

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Consume only COMPLETE lines; whatever trails stays buffered for the next chunk.
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue // skip `event:` lines and keep-alives
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      let ev: {
        type?: string
        content_block?: { type?: string; name?: string }
        delta?: { type?: string; partial_json?: string; text?: string; stop_reason?: string }
        error?: { message?: string }
      }
      try {
        ev = JSON.parse(payload)
      } catch {
        continue // a malformed frame is not worth failing the whole response over
      }

      switch (ev.type) {
        case 'content_block_start':
          // Only accumulate the forced tool's input — never another block's.
          inTargetTool = ev.content_block?.type === 'tool_use' && ev.content_block?.name === TOOL_NAME
          break
        case 'content_block_delta':
          if (ev.delta?.type === 'input_json_delta' && inTargetTool) toolJson += ev.delta.partial_json ?? ''
          else if (ev.delta?.type === 'text_delta') text += ev.delta.text ?? ''
          break
        case 'content_block_stop':
          inTargetTool = false
          break
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
          break
        case 'error':
          throw new Error(`bedrock stream error: ${ev.error?.message ?? 'unknown'}`)
      }
    }
  }

  if (stopReason === 'refusal') throw new Error('bedrock: request was declined by safety classifiers (stop_reason=refusal)')
  if (stopReason === 'max_tokens') {
    throw new Error('bedrock: hit max_tokens before the structured output was complete — raise max_tokens or lower effort')
  }

  const raw = mode === 'tool' ? toolJson : text
  if (!raw.trim()) throw new Error(`bedrock: streamed response carried no ${mode === 'tool' ? TOOL_NAME + ' tool input' : 'json_schema text'}`)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`bedrock: streamed ${mode} payload was not valid JSON`)
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
  const effort = opts.effort ?? DEFAULT_EFFORT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const key = pinKey(region, opts.model)

  // An explicit model override still gets the access-fallback chain behind it,
  // so a mis-set AWS_BEDROCK_MODEL_ID degrades instead of hard-failing.
  const models = opts.model
    ? [opts.model, ...BEDROCK_MODEL_CHAIN.filter((m) => m !== opts.model)]
    : preferPinned(pins.get(key)?.model, BEDROCK_MODEL_CHAIN)

  let lastError: Error | null = null

  for (const model of models) {
    // Re-read the pin each round: an earlier attempt may have just learned that
    // this deployment rejects output_config.
    for (const attempt of attemptsFor(pins.get(key) ?? {}, effort)) {
      // The plan above was made before this round; an earlier attempt may have
      // just proven output_config unusable, so re-check before spending a call.
      if (pins.get(key)?.outputConfigOk === false && (attempt.effort || attempt.mode === 'json_schema')) continue

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Bearer token goes in x-api-key, NOT Authorization.
            'x-api-key': opts.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(buildBody(prompt, model, schema, attempt.mode, maxTokens, attempt.effort)),
          signal: controller.signal,
        })
      } catch (e) {
        clearTimeout(timer)
        // An abort here is the timeout firing. Name it, so a slow model reads as
        // a timeout rather than a mystery network error.
        const aborted = (e as { name?: string })?.name === 'AbortError'
        throw new Error(
          aborted
            ? `bedrock: timed out after ${Math.round(timeoutMs / 1000)}s (${model}/${attempt.mode}) — lower BEDROCK_EFFORT or use a faster model`
            : `bedrock: request failed (${model}/${attempt.mode}): ${String(e).slice(0, 200)}`,
        )
      }

      if (res.ok) {
        try {
          const raw = await readStructuredStream(res, attempt.mode)
          pins.set(key, {
            // Merge, don't replace: a preceding attempt may have already proven
            // output_config unusable, and that verdict must survive the success.
            ...(pins.get(key) ?? {}),
            model,
            structuredMode: attempt.mode,
            // Only a successful output_config request proves the field is usable.
            ...(attempt.effort ? { outputConfigOk: true } : {}),
          })
          return { raw, model, structuredMode: attempt.mode, region }
        } finally {
          clearTimeout(timer)
        }
      }

      clearTimeout(timer)
      const body = await res.text().catch(() => '')
      const detail = `bedrock ${res.status} (${model}/${attempt.mode}${attempt.effort ? '+effort' : ''}): ${body.slice(0, 200)}`

      // This deployment does not accept output_config, which costs BOTH native
      // structured output and the effort knob. Record it so attemptsFor drops
      // every output_config-bearing shape from here on, then fall to the next.
      if (isOutputConfigRejected(res.status, body)) {
        lastError = new Error(detail)
        pins.set(key, { ...(pins.get(key) ?? {}), outputConfigOk: false })
        continue
      }
      // This account has no access to this model — move to the next one. A pinned
      // model that starts failing this way is dropped so discovery re-runs.
      if (isModelAccessError(res.status)) {
        lastError = new Error(detail)
        const cur = pins.get(key) ?? {}
        if (cur.model === model) pins.set(key, { ...cur, model: undefined })
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
