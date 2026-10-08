// ============================================================================
// BACKFILL-EMBEDDINGS — gives older thoughts their embedding
// ============================================================================
// Thoughts saved before Level 6 have an empty embedding column. Each call to
// this function embeds a small batch of them, oldest first. A loop in your
// terminal calls it again and again until none are left.
//
// Request:  POST { batch_size?: number, offset?: number }
// Response: { processed, embedded, failed, offset_next, remaining }
//
// About offset: every thought that gets embedded drops out of "thoughts with
// no embedding", so the next batch naturally starts at the next one. Only
// failures stay behind — offset_next skips past them so one bad thought can't
// stop the loop. remaining counts what is still left to try after that.
//
// Small batches on purpose: each thought is one call to the embedding
// provider, and Supabase stops a function that runs too long.
//
// WHO MAY CALL THIS: deployed with --no-verify-jwt, so it checks for your
// AGENT_SECRET itself — the same password your webhook and weekly cron send.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   AGENT_SECRET
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { adminClient, json } from '../_shared/capture.ts'
import { generateEmbedding } from '../_shared/embedding.ts'

const DEFAULT_BATCH = 5
const MAX_BATCH = 20

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const secret = Deno.env.get('AGENT_SECRET') ?? ''
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!secret || token !== secret) return json({ error: 'Not allowed' }, 401)

  const body = await req.json().catch(() => ({}))
  const batchSize = Math.min(Math.max(Number.isInteger(body?.batch_size) ? body.batch_size : DEFAULT_BATCH, 1), MAX_BATCH)
  const offset = Math.max(Number.isInteger(body?.offset) ? body.offset : 0, 0)

  const admin = adminClient()
  const { data: thoughts, error } = await admin
    .from('thoughts')
    .select('id, user_id, content')
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + batchSize - 1)
  if (error) return json({ error: error.message }, 500)

  let embedded = 0
  let failed = 0
  for (const t of thoughts ?? []) {
    // One thought failing never stops the batch.
    try {
      if (!t.content?.trim()) throw new Error('empty content')
      const embedding = await generateEmbedding({ text: t.content, userId: t.user_id, source: 'backfill-embeddings' })
      if (!embedding) throw new Error('no embedding returned')
      const { error: upErr } = await admin.from('thoughts').update({ embedding }).eq('id', t.id)
      if (upErr) throw upErr
      embedded++
    } catch (e) {
      failed++
      console.warn(`Skipped ${t.id}:`, e instanceof Error ? e.message : e)
    }
  }

  const offsetNext = offset + failed
  const { count, error: countErr } = await admin
    .from('thoughts')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)
  if (countErr) return json({ error: countErr.message }, 500)

  return json({
    processed: thoughts?.length ?? 0,
    embedded,
    failed,
    offset_next: offsetNext,
    remaining: Math.max((count ?? 0) - offsetNext, 0),
  })
})
