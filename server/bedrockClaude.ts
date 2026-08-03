// ─────────────────────────────────────────────────────────────────────────────
// Claude via AWS Bedrock — an additive, self-contained provider path. Only used
// when LLM_PROVIDER=claude AND a Bedrock key is configured (see the `llmProvider`
// / `bedrockKey` wiring in summarize.ts); otherwise the existing OpenAI /
// Anthropic-direct paths behave exactly as before. Deleting this file and its
// wiring in summarize.ts fully removes the Claude/Bedrock path.
//
// Talks to the Bedrock Runtime Converse API with forced tool use, and returns
// the RAW parsed tool-input object — the same shape viaOpenAI/viaAnthropic
// return in summarize.ts — so the caller's normalize() step (and therefore every
// client-visible response shape) is identical regardless of which provider
// produced it.
// ─────────────────────────────────────────────────────────────────────────────

// ASSUMPTION (flag for review): no AWS region/model was already configured
// elsewhere in this repo, so these defaults were picked per the task brief.
// Verify against the actual AWS account and override via env if different
// (AWS_BEDROCK_REGION / AWS_BEDROCK_MODEL_ID — see functions/api/summary.ts).
export const DEFAULT_BEDROCK_REGION = 'us-east-1'
export const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'

interface BedrockConverseResponse {
  output?: {
    message?: {
      content?: Array<{ toolUse?: { name?: string; input?: unknown } }>
    }
  }
}

// Bedrock Converse API (forced tool use). Returns the RAW parsed tool input —
// caller (summarize.ts) normalizes it exactly like the OpenAI/Anthropic-direct paths.
export async function viaBedrockClaude(
  prompt: { system: string; user: string },
  apiKey: string,
  model: string,
  schema: object,
  region: string = DEFAULT_BEDROCK_REGION,
): Promise<unknown> {
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      system: [{ text: prompt.system }],
      messages: [{ role: 'user', content: [{ text: prompt.user }] }],
      toolConfig: {
        tools: [{ toolSpec: { name: 'emit_summary', description: 'Emit the structured summary.', inputSchema: { json: schema } } }],
        toolChoice: { tool: { name: 'emit_summary' } },
      },
      // Mirrors the 16000-token ceiling used by the OpenAI/Anthropic-direct paths.
      inferenceConfig: { maxTokens: 16000 },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`bedrock-claude ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as BedrockConverseResponse
  const toolUse = (data.output?.message?.content ?? []).find((b) => b.toolUse?.name === 'emit_summary')?.toolUse
  if (!toolUse || toolUse.input === undefined) throw new Error('bedrock-claude: no emit_summary tool use in response')
  return toolUse.input
}

/** Whether the Claude/Bedrock path is selected for this config — the single
 *  toggle check shared by summarize.ts and weeklyDigest.ts. */
export function isBedrockClaudeSelected(config: { llmProvider?: string; bedrockKey?: string } | undefined): boolean {
  return !!config && config.llmProvider === 'claude' && !!config.bedrockKey
}
