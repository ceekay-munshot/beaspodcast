import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callBedrockClaude, BEDROCK_MODEL_CHAIN } from './bedrockClaude'
import { parseLlmProvider, probeLlm, providerChain } from './summarize'
import { llmConfigFromEnv, llmCredentialsPresent, redactSecrets } from './llmConfig'

// These tests pin the parts of the Bedrock transport that are easy to get wrong
// and expensive to discover in production: the auth header, the absence of
// sampling params, the 403 model-access fallback chain, and the structured-output
// fallback when a deployment rejects `output_config`.
//
// NOTE: discovery results are pinned per REGION inside bedrockClaude.ts, so each
// test uses its own region to get a clean pin slot.

const SCHEMA = { type: 'object', additionalProperties: false, properties: { status: { type: 'string' } }, required: ['status'] }
const PROMPT = { system: 'sys', user: 'usr' }
const PAYLOAD = { status: 'ok' }

/** Build a mock streamed Response: SSE frames handed out as byte chunks via
 *  getReader(), exactly as the Workers runtime delivers them. */
function sseResponse(frames: string[], chunkSplitter?: (all: string) => string[]) {
  const all = frames.join('')
  const chunks = chunkSplitter ? chunkSplitter(all) : [all]
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
      }),
    },
    text: async () => '',
  }
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** Forced-tool-use stream: the payload arrives as input_json_delta fragments. */
const toolFrames = (payload: unknown = PAYLOAD) => {
  const json = JSON.stringify(payload)
  const mid = Math.ceil(json.length / 2)
  return [
    frame({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'emit_summary' } }),
    frame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) } }),
    frame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: json.slice(mid) } }),
    frame({ type: 'content_block_stop' }),
    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  ]
}

/** Native structured-output stream: the payload arrives as text_delta fragments. */
const jsonSchemaFrames = (payload: unknown = PAYLOAD) => [
  frame({ type: 'content_block_start', content_block: { type: 'text' } }),
  frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(payload) } }),
  frame({ type: 'content_block_stop' }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
]

const toolOk = () => sseResponse(toolFrames())
const jsonSchemaOk = () => sseResponse(jsonSchemaFrames())

const err = (status: number, body: string) => ({ ok: false, status, json: async () => ({}), text: async () => body })

/** The exact 400 a deployment without native structured outputs returns. */
const OUTPUT_CONFIG_REJECTED = err(400, '{"message":"output_config.format: Extra inputs are not permitted"}')

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string)
const initOf = (call: number) => fetchMock.mock.calls[call][1] as { headers: Record<string, string> }

describe('callBedrockClaude — endpoint and auth', () => {
  it('hits the mantle endpoint with the key in x-api-key (never Authorization)', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'sk-secret', region: 'eu-west-1' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages')
    const { headers } = initOf(0)
    expect(headers['x-api-key']).toBe('sk-secret')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    // A bearer token in Authorization is the wrong header for this endpoint.
    expect(headers.authorization).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
  })

  it('defaults to us-east-1 when no region is configured', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k' })
    expect(fetchMock.mock.calls[0][0]).toContain('bedrock-mantle.us-east-1.api.aws')
    expect(out.region).toBe('us-east-1')
  })

  it('never sends temperature/top_p/top_k (rejected with 400 on Opus 5/4.8/4.7)', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'us-west-2' })
    const body = bodyOf(0)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('top_k')
  })

  it('uses anthropic.-prefixed model ids', () => {
    for (const model of BEDROCK_MODEL_CHAIN) expect(model.startsWith('anthropic.')).toBe(true)
  })
})

describe('callBedrockClaude — streaming (Workers runtime)', () => {
  // A fresh region has no pin, so json_schema is attempted first. Tool-mode tests
  // therefore prime the deployment's output_config rejection, making the SECOND
  // fetch the forced-tool-use call under test (hence bodyOf(1)).
  const primeToolMode = (streamed: unknown) => {
    fetchMock.mockResolvedValueOnce(OUTPUT_CONFIG_REJECTED).mockResolvedValueOnce(streamed)
  }

  it('streams the request so a long thinking+output run cannot stall the connection', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'us-east-2' })
    expect(bodyOf(0).stream).toBe(true)
  })

  it('reads the body via getReader(), never the Node-only async iterator', async () => {
    let usedGetReader = false
    const res = jsonSchemaOk()
    const realGetReader = res.body.getReader
    res.body.getReader = () => {
      usedGetReader = true
      return realGetReader()
    }
    // A Workers ReadableStream has no Symbol.asyncIterator — if the code reached
    // for one, this would throw rather than silently pass.
    Object.defineProperty(res.body, Symbol.asyncIterator, {
      get() {
        throw new Error('async iteration is Node-only and throws on Workers')
      },
    })
    fetchMock.mockResolvedValueOnce(res)
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'us-west-1' })
    expect(usedGetReader).toBe(true)
    expect(out.raw).toEqual(PAYLOAD)
  })

  it('reassembles SSE frames that split mid-line across chunk boundaries', async () => {
    // Chop the stream into 7-byte chunks so nearly every frame — and the JSON
    // inside it — is torn across reads.
    primeToolMode(sseResponse(toolFrames(), (all) => all.match(/[\s\S]{1,7}/g) ?? [all]))
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ap-southeast-1' })
    expect(out.raw).toEqual(PAYLOAD)
  })

  it('concatenates input_json_delta fragments (tool payloads are not text_delta)', async () => {
    const big = { status: 'ok', note: 'x'.repeat(300) }
    primeToolMode(sseResponse(toolFrames(big), (all) => all.match(/[\s\S]{1,13}/g) ?? [all]))
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ap-northeast-3' })
    expect(out.raw).toEqual(big)
  })

  it('ignores deltas from a content block that is not the forced tool', async () => {
    primeToolMode(
      sseResponse([
        frame({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'some_other_tool' } }),
        frame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"junk":1}' } }),
        frame({ type: 'content_block_stop' }),
        ...toolFrames(),
      ]),
    )
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'eu-west-2' })
    expect(out.raw).toEqual(PAYLOAD)
  })

  it('reports a truncated response instead of a confusing JSON parse error', async () => {
    primeToolMode(
      sseResponse([
        frame({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'emit_summary' } }),
        frame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"status":' } }),
        frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      ]),
    )
    await expect(callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'eu-south-1' })).rejects.toThrow(/max_tokens/)
  })

  it('surfaces an error frame delivered mid-stream', async () => {
    primeToolMode(
      sseResponse([
        frame({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'emit_summary' } }),
        frame({ type: 'error', error: { message: 'upstream exploded' } }),
      ]),
    )
    await expect(callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ca-west-1' })).rejects.toThrow(/upstream exploded/)
  })

  it('leaves room for thinking plus a transcript-grade summary', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'me-south-1' })
    // Opus 5 spends this budget on thinking AND the answer — 16000 truncated once
    // a real transcript was in play.
    expect(bodyOf(0).max_tokens).toBeGreaterThanOrEqual(32000)
  })
})

describe('callBedrockClaude — model access fallback chain', () => {
  it('falls through a 403 on Opus 5 to the next model in the chain', async () => {
    fetchMock
      .mockResolvedValueOnce(err(403, 'not authorized to invoke this model')) // opus-5
      .mockResolvedValueOnce(jsonSchemaOk()) // opus-4-8
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ap-south-1' })

    expect(bodyOf(0).model).toBe('anthropic.claude-opus-5')
    expect(bodyOf(1).model).toBe('anthropic.claude-opus-4-8')
    expect(out.model).toBe('anthropic.claude-opus-4-8')
    expect(out.raw).toEqual(PAYLOAD)
  })

  it('pins the granted model so later calls skip the 403 probe', async () => {
    fetchMock
      .mockResolvedValueOnce(err(403, 'denied'))
      .mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'sa-east-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    const second = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'sa-east-1' })
    expect(fetchMock).toHaveBeenCalledTimes(3) // one call, straight to the pinned model
    expect(bodyOf(2).model).toBe('anthropic.claude-opus-4-8')
    expect(second.model).toBe('anthropic.claude-opus-4-8')
  })

  it('throws when no model in the chain is reachable', async () => {
    fetchMock.mockResolvedValue(err(403, 'denied'))
    await expect(callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'me-central-1' })).rejects.toThrow(/bedrock 403/)
  })

  it('surfaces a non-access error instead of burning the whole chain', async () => {
    fetchMock.mockResolvedValue(err(500, 'internal'))
    await expect(callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ca-central-1' })).rejects.toThrow(/bedrock 500/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // stopped at the first model
  })
})

describe('callBedrockClaude — structured output fallback', () => {
  it('falls back to forced tool use when the deployment rejects output_config', async () => {
    fetchMock
      .mockResolvedValueOnce(OUTPUT_CONFIG_REJECTED)
      .mockResolvedValueOnce(toolOk())
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'eu-central-1' })

    // First attempt asks for native structured output...
    expect(bodyOf(0)).toHaveProperty('output_config.format.type', 'json_schema')
    // ...the retry uses ONE forced tool whose input_schema is the schema verbatim.
    const retry = bodyOf(1)
    expect(retry).not.toHaveProperty('output_config')
    expect(retry.tools).toHaveLength(1)
    expect(retry.tools[0].name).toBe('emit_summary')
    expect(retry.tools[0].input_schema).toEqual(SCHEMA)
    expect(retry.tool_choice).toEqual({ type: 'tool', name: 'emit_summary' })

    expect(out.structuredMode).toBe('tool')
    expect(out.raw).toEqual(PAYLOAD)
  })

  it('pins the working structured mode so later calls skip the rejected one', async () => {
    fetchMock.mockResolvedValueOnce(OUTPUT_CONFIG_REJECTED).mockResolvedValueOnce(toolOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'eu-north-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(toolOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'eu-north-1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodyOf(2)).not.toHaveProperty('output_config') // went straight to tool use
  })

  it('reports a refusal rather than failing to parse empty content', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([frame({ type: 'message_delta', delta: { stop_reason: 'refusal' } })]))
    await expect(callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'il-central-1' })).rejects.toThrow(/refusal/)
  })
})

describe('callBedrockClaude — effort and timeout', () => {
  it('asks for low effort by default — Opus 5 would otherwise think at high', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'us-gov-west-1' })
    expect(bodyOf(0).output_config.effort).toBe('low')
  })

  it('honours an explicit effort override', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ap-east-1', effort: 'high' })
    expect(bodyOf(0).output_config.effort).toBe('high')
  })

  it('drops effort entirely once the deployment rejects output_config', async () => {
    // json_schema+effort rejected → the effort-bearing tool attempt is skipped
    // rather than wasted → the plain tool call carries no output_config at all.
    fetchMock.mockResolvedValueOnce(OUTPUT_CONFIG_REJECTED).mockResolvedValueOnce(toolOk())
    const out = await callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'eu-central-2' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1)).not.toHaveProperty('output_config')
    expect(out.raw).toEqual(PAYLOAD)
  })

  it('reports a stalled generation as a timeout instead of hanging forever', async () => {
    // A request that never settles is exactly what made the page spin: without a
    // ceiling there is no error to show, only a dead connection.
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      }),
    )
    await expect(
      callBedrockClaude(PROMPT, SCHEMA, { apiKey: 'k', region: 'ap-south-2', timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after/)
  })
})

describe('providerChain — Bedrock primary, OpenAI automatic fallback', () => {
  it('puts Bedrock first whenever a Bedrock key is bound', () => {
    expect(providerChain({ bedrockKey: 'b', openaiKey: 'o' })).toEqual(['bedrock', 'openai'])
  })

  it('falls back to OpenAI alone when no Bedrock key is set', () => {
    expect(providerChain({ openaiKey: 'o' })).toEqual(['openai'])
  })

  it('LLM_PROVIDER=openai flips the order back without dropping Bedrock', () => {
    expect(providerChain({ bedrockKey: 'b', openaiKey: 'o', llmProvider: 'openai' })).toEqual(['openai', 'bedrock'])
  })

  it('ignores a forced provider whose credential is absent', () => {
    expect(providerChain({ openaiKey: 'o', llmProvider: 'bedrock' })).toEqual(['openai'])
  })

  it('is empty when nothing is configured', () => {
    expect(providerChain({})).toEqual([])
  })

  it('accepts "claude" as a legacy alias for bedrock', () => {
    expect(parseLlmProvider('claude')).toBe('bedrock')
    expect(parseLlmProvider('OpenAI')).toBe('openai')
    expect(parseLlmProvider('nonsense')).toBeUndefined()
    expect(parseLlmProvider(undefined)).toBeUndefined()
  })
})

describe('probeLlm — health check', () => {
  it('reports which provider and model answered', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    const out = await probeLlm({ bedrockKey: 'k', bedrockRegion: 'af-south-1' })
    expect(out.provider).toBe('bedrock')
    expect(out.model).toBe('anthropic.claude-opus-5')
    expect(out.chain).toEqual(['bedrock'])
  })

  it('keeps the probe cheap — a tiny max_tokens, never real work', async () => {
    fetchMock.mockResolvedValueOnce(jsonSchemaOk())
    await probeLlm({ bedrockKey: 'k', bedrockRegion: 'ap-northeast-1' })
    expect(bodyOf(0).max_tokens).toBe(64)
  })

  it('falls back to OpenAI when Bedrock is unreachable', async () => {
    const openaiOk = {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(PAYLOAD) } }] } }] }),
      text: async () => '',
    }
    fetchMock.mockResolvedValueOnce(err(500, 'bedrock down')).mockResolvedValueOnce(openaiOk)

    const out = await probeLlm({ bedrockKey: 'k', bedrockRegion: 'ap-southeast-2', openaiKey: 'o' })
    expect(out.provider).toBe('openai')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('names every provider that failed when the whole chain is down', async () => {
    fetchMock.mockResolvedValue(err(500, 'down'))
    await expect(probeLlm({ bedrockKey: 'k', bedrockRegion: 'ap-northeast-2', openaiKey: 'o' })).rejects.toThrow(/all_llm_providers_failed/)
  })

  it('rejects with no_api_key when nothing is configured', async () => {
    await expect(probeLlm({})).rejects.toThrow(/no_api_key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('llmConfig — env wiring and secret hygiene', () => {
  it('reads BEDROCK_API_KEY from the env record', () => {
    const cfg = llmConfigFromEnv({ BEDROCK_API_KEY: 'sk-bedrock', AWS_BEDROCK_REGION: 'us-west-2' })
    expect(cfg.bedrockKey).toBe('sk-bedrock')
    expect(cfg.bedrockRegion).toBe('us-west-2')
    expect(providerChain(cfg)).toEqual(['bedrock'])
  })

  it('still honours the legacy temp_claude_token name', () => {
    expect(llmConfigFromEnv({ temp_claude_token: 'legacy' }).bedrockKey).toBe('legacy')
    // The documented name wins when both are set.
    expect(llmConfigFromEnv({ BEDROCK_API_KEY: 'new', temp_claude_token: 'legacy' }).bedrockKey).toBe('new')
  })

  it('reports credential presence as booleans only — never the value', () => {
    const present = llmCredentialsPresent(llmConfigFromEnv({ BEDROCK_API_KEY: 'sk-secret-value' }))
    expect(present).toEqual({ bedrock: true, openai: false, anthropic: false })
    expect(JSON.stringify(present)).not.toContain('sk-secret')
  })

  it('scrubs a key that somehow reaches an error string', () => {
    const cfg = llmConfigFromEnv({ BEDROCK_API_KEY: 'sk-super-secret-key' })
    expect(redactSecrets('boom: sk-super-secret-key leaked', cfg)).toBe('boom: [redacted] leaked')
  })
})
