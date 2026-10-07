// ============================================================================
// CALL-LLM — the one door every AI call goes through
// ============================================================================
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// Your agents (enrich-thought, weekly-digest, anything you build later) never
// talk to an AI company directly. They send this function a prompt, and this
// function decides which AI answers it. So the choice of AI lives in exactly
// one place: two secrets.
//
//   LLM_PROVIDER   'anthropic' (default) or 'openai'
//   LLM_MODEL      the model name, e.g. a small cheap one for tagging
//
// 'openai' also covers any service that copies OpenAI's format — set
// OPENAI_BASE_URL to point at it (Google Gemini, OpenRouter, a local Ollama).
//
// Request:  POST { prompt, systemPrompt?, model?, maxTokens?, userId?, source? }
// Response: { text }
//
// WHO MAY CALL THIS: only your own other functions. It is deployed with
// --no-verify-jwt, and the first thing it does is check that the caller sent
// your service role key — the master key that only your Supabase functions
// have. Without that check, anyone who found this address could spend your AI
// credit.
//
// THE RECEIPT: after every successful call, one row goes into llm_usage with
// what it cost. That write is never waited on and can never fail the call —
// the AI already answered.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   LLM_PROVIDER, LLM_MODEL
//   ANTHROPIC_API_KEY             when LLM_PROVIDER is 'anthropic'
//   OPENAI_API_KEY                when LLM_PROVIDER is 'openai'
//   OPENAI_BASE_URL               optional, for OpenAI-compatible services
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.131.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

const env = (name: string) => Deno.env.get(name) ?? ''

// Published prices, in US dollars per 1 million tokens. A model missing from
// this list still works — its calls are just logged as costing $0, so add it
// here when you start using it.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type LlmResult = { text: string; model: string; promptTokens: number; completionTokens: number }

async function callAnthropic(model: string, prompt: string, systemPrompt: string | undefined, maxTokens: number): Promise<LlmResult> {
  const apiKey = env('ANTHROPIC_API_KEY')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Supabase secrets')

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
  })

  let text = ''
  for (const block of response.content) {
    if (block.type === 'text') text += block.text
  }
  return {
    text,
    model: response.model,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
  }
}

async function callOpenAI(model: string, prompt: string, systemPrompt: string | undefined, maxTokens: number): Promise<LlmResult> {
  const apiKey = env('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in Supabase secrets')
  const baseUrl = (env('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, '')

  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(60_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`OpenAI-style API returned ${res.status}: ${data?.error?.message ?? 'no details'}`)

  return {
    text: data?.choices?.[0]?.message?.content ?? '',
    model: data?.model ?? model,
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  }
}

// Write the receipt. Swallows every error, on purpose.
async function logUsage(row: { userId: string; source: string | null; result: LlmResult; costModel: string }) {
  try {
    const price = PRICES[row.costModel]
    const cost = price
      ? (row.result.promptTokens * price.input + row.result.completionTokens * price.output) / 1_000_000
      : 0
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const { error } = await admin.from('llm_usage').insert({
      user_id: row.userId,
      kind: 'chat',
      model: row.result.model,
      source: row.source,
      prompt_tokens: row.result.promptTokens,
      completion_tokens: row.result.completionTokens,
      cost_usd: cost,
    })
    if (error) throw error
  } catch (e) {
    console.warn('AI call worked, but its cost was not logged:', e instanceof Error ? e.message : e)
  }
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  // Only your own functions hold the service role key.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token || token !== env('SUPABASE_SERVICE_ROLE_KEY')) {
    return json({ error: 'Not allowed' }, 401)
  }

  const body = await req.json().catch(() => null)
  const prompt = body?.prompt
  if (!prompt || typeof prompt !== 'string') return json({ error: 'prompt is required' }, 400)

  const provider = (env('LLM_PROVIDER') || 'anthropic').toLowerCase()
  const model = (typeof body.model === 'string' && body.model) || env('LLM_MODEL')
  if (!model) return json({ error: 'LLM_MODEL is not set in Supabase secrets' }, 500)
  const maxTokens = Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? body.maxTokens : 1024
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined

  let result: LlmResult
  try {
    if (provider === 'anthropic') {
      result = await callAnthropic(model, prompt, systemPrompt, maxTokens)
    } else if (provider === 'openai') {
      result = await callOpenAI(model, prompt, systemPrompt, maxTokens)
    } else {
      return json({ error: `Unknown LLM_PROVIDER '${provider}' — use 'anthropic' or 'openai'` }, 500)
    }
  } catch (e) {
    // 502 = "the service behind me failed", kept separate from this function's
    // own 401 so a bad AI key never looks like a bad caller.
    const detail = e instanceof Anthropic.APIError ? `${e.status ?? 'network'} ${e.message}` : e instanceof Error ? e.message : String(e)
    console.error(`${provider} call failed:`, detail)
    return json({ error: `${provider} call failed: ${detail}` }, 502)
  }

  // Fire off the receipt without waiting for it. waitUntil keeps the function
  // alive long enough to finish the write after the answer has gone back.
  if (typeof body.userId === 'string' && body.userId) {
    const pending = logUsage({
      userId: body.userId,
      source: typeof body.source === 'string' ? body.source : null,
      result,
      costModel: model,
    })
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(pending)
  }

  return json({ text: result.text })
})
