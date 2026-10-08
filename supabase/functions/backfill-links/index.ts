// ============================================================================
// BACKFILL-LINKS — builds the graph for thoughts saved before Level 6
// ============================================================================
// New thoughts link themselves when they are saved (enrich-thought). Older
// ones never went through that, so each call to this function links a small
// batch of them, oldest first. A loop in your terminal calls it again and
// again until it reaches the end.
//
// Request:  POST { batch_size?: number, offset?: number }
// Response: { processed, linked, already_done, links_created, offset_next, remaining }
//
//   linked         thoughts in this batch that got at least one new link
//   already_done   thoughts whose neighbours were all linked already (or
//                  that have none above 50%) — safe to run this twice
//
// Unlike the embeddings backfill, nothing drops out of the list as it goes —
// every thought with an embedding stays in it — so offset simply moves
// forward by the batch size.
//
// Small batches on purpose (default 3): each thought means a nearest-neighbour
// search, and Supabase stops a function that uses too much memory or time
// (error 546).
//
// WHO MAY CALL THIS: deployed with --no-verify-jwt, so it checks for your
// AGENT_SECRET itself.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   AGENT_SECRET
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { adminClient, json } from '../_shared/capture.ts'
import { linkThought } from '../_shared/links.ts'

const DEFAULT_BATCH = 3
const MAX_BATCH = 10

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
    .select('id, user_id, embedding')
    .not('embedding', 'is', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + batchSize - 1)
  if (error) return json({ error: error.message }, 500)

  let linked = 0
  let alreadyDone = 0
  let linksCreated = 0
  for (const t of thoughts ?? []) {
    // One thought failing never stops the batch.
    try {
      const created = await linkThought(admin, t, t.embedding)
      if (created > 0) {
        linked++
        linksCreated += created
      } else {
        alreadyDone++
      }
    } catch (e) {
      console.warn(`Skipped ${t.id}:`, e instanceof Error ? e.message : e)
    }
  }

  const offsetNext = offset + (thoughts?.length ?? 0)
  const { count, error: countErr } = await admin
    .from('thoughts')
    .select('id', { count: 'exact', head: true })
    .not('embedding', 'is', null)
  if (countErr) return json({ error: countErr.message }, 500)

  return json({
    processed: thoughts?.length ?? 0,
    linked,
    already_done: alreadyDone,
    links_created: linksCreated,
    offset_next: offsetNext,
    remaining: Math.max((count ?? 0) - offsetNext, 0),
  })
})
