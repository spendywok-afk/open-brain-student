// ============================================================================
// SHARED BY EVERY FUNCTION THAT NEEDS AN EMBEDDING
// ============================================================================
// Functions never call the embedding provider directly. They call your own
// generate-embedding function, which picks the model. This helper is the only
// place that knows generate-embedding's address and how to knock on its door.
//
// The knock: one edge function calling another must prove who it is, or the
// call is rejected with a 401 before generate-embedding runs. The symptom is
// that embeddings silently never appear and the generate-embedding logs are
// empty, because it never ran. So the header lives here, once.
//
// Never throws: returns null on any failure, so a thought without an
// embedding is still saved and can be backfilled later.
// ============================================================================

export async function generateEmbedding(request: {
  text: string
  userId?: string | null
  source: string
}): Promise<number[] | null> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ ...request, userId: request.userId ?? undefined }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!Array.isArray(data?.embedding)) {
      console.warn(`No embedding (generate-embedding returned ${res.status}): ${data?.error ?? 'no details'}`)
      return null
    }
    return data.embedding
  } catch (e) {
    console.warn('No embedding:', e instanceof Error ? e.message : e)
    return null
  }
}
