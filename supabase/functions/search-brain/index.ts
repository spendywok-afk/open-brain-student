// ============================================================================
// SEARCH-BRAIN — the app's Search tab
// ============================================================================
// The same hybrid search Claude Desktop gets through open-brain-mcp: meaning
// and exact words at once, over whole thoughts and the chunks of long ones.
//
// WHY THIS RUNS ON THE SERVER: search_thoughts needs an embedding of the
// search words, and making one needs your OpenRouter key — a secret that can
// never sit inside a web page. So the app asks this function, and this
// function asks generate-embedding.
//
// WHO IS ASKING: read from the caller's own login token — never from the
// request body, where a browser could put anyone's id. The database call then
// uses the service role key, because chunks are deliberately hidden from
// signed-in users (RLS on, no rules) — so whose thoughts to search is passed
// by hand as p_user_id, set to the id from the token.
//
// If the embedding fails (provider down, out of credit), search still runs
// keyword-only instead of showing an error.
//
// Deployed WITH JWT verification (the default): only a signed-in app can call it.
// ============================================================================

import { adminClient, corsHeaders, getCaller, json } from '../_shared/capture.ts'
import { generateEmbedding } from '../_shared/embedding.ts'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const admin = adminClient()
    const user = await getCaller(admin, req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) return json({ ok: false, error: 'Type something to search for' }, 400)
    const limit = Math.min(Math.max(Math.floor(Number(body.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT)

    // null on any failure — the search below then runs keyword-only
    const embedding = await generateEmbedding({ text: query, userId: user.id, source: 'app-search' })

    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: user.id,
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: limit,
    })
    if (error) throw error

    return json({ ok: true, keywordOnly: !embedding, results: data ?? [] })
  } catch (err) {
    console.error('[search-brain] Failed:', err)
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
