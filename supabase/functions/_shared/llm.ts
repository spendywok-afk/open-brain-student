// ============================================================================
// SHARED BY EVERY AGENT — how to ask the AI something
// ============================================================================
// Agents never call an AI company directly. They call your own call-llm
// function, which picks the provider. This helper is the only place that
// knows call-llm's address and how to knock on its door.
//
// The knock: call-llm only answers callers holding the service role key.
// Forget that header and call-llm says 401 — and the agent appears to "do
// nothing" with no obvious error. So it lives here, once, for every agent.
// ============================================================================

export async function callLLM(request: {
  prompt: string
  systemPrompt?: string
  maxTokens?: number
  userId?: string | null
  source: string
}): Promise<string> {
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/call-llm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    body: JSON.stringify({ ...request, userId: request.userId ?? undefined }),
    signal: AbortSignal.timeout(120_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`call-llm returned ${res.status}: ${data?.error ?? 'no details'}`)
  return typeof data?.text === 'string' ? data.text : ''
}
