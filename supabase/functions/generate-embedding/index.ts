// ============================================================================
// GENERATE-EMBEDDING — turns text into its meaning, as 1,536 numbers
// ============================================================================
// To switch embedding providers, change the model string. The vector
// dimension must stay 1536 or you need a new migration.
//
// The model string lives in one secret, EMBEDDING_MODEL (default below).
// OpenRouter routes to any embedding provider through one API, so switching
// from OpenAI's model to another company's is a change to that secret only.
//
// Request:  POST { text, userId?, source? }
// Response: { embedding: number[] }   — or { embedding: null, error } on failure
//
// Failure never comes back as a crash: callers (enrich-thought, the backfill)
// get { embedding: null } and carry on. A thought without an embedding is
// still saved and can be backfilled later.
//
// WHO MAY CALL THIS: only your own other functions — the same rule as
// call-llm. It is deployed with --no-verify-jwt and checks for your service
// role key itself. Without that check, anyone who found this address could
// spend your OpenRouter credit.
//
// THE RECEIPT: like call-llm, every successful call writes one row into
// llm_usage (kind 'embedding'), never waited on, never able to fail the call.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   OPENROUTER_API_KEY            required
//   EMBEDDING_MODEL               optional, default 'openai/text-embedding-3-small'
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const env = (name: string) => Deno.env.get(name) ?? ''

const DEFAULT_MODEL = 'openai/text-embedding-3-small'
const DIMENSIONS = 1536

// The model reads at most ~8,000 tokens. Longer text is cut here rather than
// rejected — one embedding of a long transcript mostly captures its overall
// gist anyway (Level 7 fixes that by embedding long captures in pieces).
const MAX_CHARS = 24_000

// Published prices, in US dollars per 1 million tokens.
const PRICES: Record<string, number> = {
  'openai/text-embedding-3-small': 0.02,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Write the receipt. Swallows every error, on purpose.
async function logUsage(row: { userId: string; source: string | null; model: string; tokens: number }) {
  try {
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const { error } = await admin.from('llm_usage').insert({
      user_id: row.userId,
      kind: 'embedding',
      model: row.model,
      source: row.source,
      prompt_tokens: row.tokens,
      completion_tokens: 0,
      cost_usd: (row.tokens * (PRICES[row.model] ?? 0)) / 1_000_000,
    })
    if (error) throw error
  } catch (e) {
    console.warn('Embedding worked, but its cost was not logged:', e instanceof Error ? e.message : e)
  }
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ embedding: null, error: 'Use POST' }, 405)

  // Only your own functions hold the service role key.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token || token !== env('SUPABASE_SERVICE_ROLE_KEY')) {
    return json({ embedding: null, error: 'Not allowed' }, 401)
  }

  const body = await req.json().catch(() => null)
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_CHARS) : ''
  if (!text) return json({ embedding: null, error: 'text is required' }, 400)

  const apiKey = env('OPENROUTER_API_KEY')
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set in Supabase secrets')
    return json({ embedding: null, error: 'OPENROUTER_API_KEY is not set in Supabase secrets' })
  }
  const model = env('EMBEDDING_MODEL') || DEFAULT_MODEL

  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: text, dimensions: DIMENSIONS }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`OpenRouter returned ${res.status}: ${data?.error?.message ?? 'no details'}`)

    const embedding = data?.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS) {
      throw new Error(`Expected ${DIMENSIONS} numbers, got ${Array.isArray(embedding) ? embedding.length : 'none'}`)
    }

    // Fire off the receipt without waiting for it.
    if (typeof body.userId === 'string' && body.userId) {
      const pending = logUsage({
        userId: body.userId,
        source: typeof body.source === 'string' ? body.source : null,
        model,
        tokens: data?.usage?.prompt_tokens ?? 0,
      })
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(pending)
    }

    return json({ embedding })
  } catch (e) {
    // Not a crash: the caller gets null and carries on without an embedding.
    const detail = e instanceof Error ? e.message : String(e)
    console.error('Embedding failed:', detail)
    return json({ embedding: null, error: detail })
  }
})
