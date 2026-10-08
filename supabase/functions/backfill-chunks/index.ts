// ============================================================================
// BACKFILL-CHUNKS — chunks the long thoughts saved before Level 7
// ============================================================================
// New long thoughts chunk themselves when they are saved (enrich-thought).
// Older ones never went through that, so each call to this function chunks a
// small batch of them, BIGGEST FIRST — they gain the most, which matters most
// if the run is interrupted. A loop in your terminal calls it again and again
// until nothing is left.
//
// The to-do list is the thoughts_needing_chunks view (Level 7, Step 1): long
// thoughts with no chunks yet. A thought drops off it as soon as it is
// chunked, so a stopped run picks up where it left off.
//
// Request:  POST { batch_size?: number, skip?: number, dry_run?: boolean, fill_missing?: boolean }
// Response: { processed, chunked, chunks_written, failed, skip_next, remaining,
//             chunks_missing_embedding }
//   dry_run: true  → { needs_chunks } only; writes nothing
//   fill_missing: true → instead of chunking, embeds chunks that were saved
//                  without an embedding (provider hiccup mid-run). Batches of
//                  chunks (default 10, max 25), not thoughts. Response:
//                  { processed, filled, failed, skip_next, remaining }
//
//   failed / skip  a thought that could not be chunked stays on the list, so
//                  the loop passes skip_next back as skip to step past it
//                  instead of retrying it forever.
//   chunks_missing_embedding  chunks saved without an embedding (provider
//                  down, out of credit) — still keyword-searchable, invisible
//                  to meaning search. Should be 0.
//
// Small batches on purpose (default 1, max 5): a 75,000-character capture is
// ~65 chunks, each one an embedding call, and Supabase stops a function that
// runs too long.
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
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'
import { generateEmbedding } from '../_shared/embedding.ts'

const DEFAULT_BATCH = 1
const MAX_BATCH = 5
const DEFAULT_FILL_BATCH = 10
const MAX_FILL_BATCH = 25

// fill_missing mode: a chunk saved without an embedding is otherwise never
// revisited. Embed a batch of them and write each one back.
async function fillMissing(admin: ReturnType<typeof adminClient>, body: Record<string, unknown>) {
  const batchSize = Math.min(Math.max(Number.isInteger(body?.batch_size) ? body.batch_size as number : DEFAULT_FILL_BATCH, 1), MAX_FILL_BATCH)
  const skip = Math.max(Number.isInteger(body?.skip) ? body.skip as number : 0, 0)

  const { data: chunks, error } = await admin
    .from('thought_chunks')
    .select('id, content, thoughts(user_id)')
    .is('embedding', null)
    .order('thought_id', { ascending: true })
    .order('chunk_index', { ascending: true })
    .range(skip, skip + batchSize - 1)
  if (error) throw error

  let filled = 0
  let failed = 0
  for (const c of chunks ?? []) {
    // deno-lint-ignore no-explicit-any
    const userId = (c as any).thoughts?.user_id ?? null
    const embedding = await generateEmbedding({ text: c.content, userId, source: 'chunk:backfill' })
    if (!embedding) {
      failed++
      continue
    }
    const { error: updErr } = await admin.from('thought_chunks').update({ embedding }).eq('id', c.id)
    if (updErr) {
      console.warn(`Could not save embedding for chunk ${c.id}:`, updErr.message)
      failed++
    } else {
      filled++
    }
  }

  const skipNext = skip + failed
  const { count, error: countErr } = await admin
    .from('thought_chunks')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)
  if (countErr) throw countErr

  return json({
    processed: chunks?.length ?? 0,
    filled,
    failed,
    skip_next: skipNext,
    remaining: Math.max((count ?? 0) - skipNext, 0),
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const secret = Deno.env.get('AGENT_SECRET') ?? ''
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!secret || token !== secret) return json({ error: 'Not allowed' }, 401)

  const body = await req.json().catch(() => ({}))
  if (body?.fill_missing === true) {
    try {
      return await fillMissing(adminClient(), body)
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  const batchSize = Math.min(Math.max(Number.isInteger(body?.batch_size) ? body.batch_size : DEFAULT_BATCH, 1), MAX_BATCH)
  const skip = Math.max(Number.isInteger(body?.skip) ? body.skip : 0, 0)

  const admin = adminClient()

  const countNeeding = async () => {
    const { count, error } = await admin
      .from('thoughts_needing_chunks')
      .select('id', { count: 'exact', head: true })
    if (error) throw error
    return count ?? 0
  }

  try {
    if (body?.dry_run === true) return json({ needs_chunks: await countNeeding() })

    const { data: todo, error } = await admin
      .from('thoughts_needing_chunks')
      .select('id')
      .order('chars', { ascending: false })
      .order('id', { ascending: true })
      .range(skip, skip + batchSize - 1)
    if (error) throw error

    let chunked = 0
    let chunksWritten = 0
    let failed = 0
    for (const { id } of todo ?? []) {
      // One thought failing never stops the batch.
      const { data: t, error: getErr } = await admin
        .from('thoughts').select('id, user_id, content').eq('id', id).maybeSingle()
      if (getErr || !t) {
        console.warn(`Skipped ${id}:`, getErr?.message ?? 'not found')
        failed++
        continue
      }
      const count = await saveThoughtChunksSafe(
        admin, t.id, t.content, 'backfill-chunks', 'summary', t.user_id ?? undefined,
      )
      if (count > 0) {
        chunked++
        chunksWritten += count
        console.log(`Chunked ${t.id} (${t.content.length} chars) into ${count} piece(s)`)
      } else {
        failed++
      }
    }

    const skipNext = skip + failed
    const { count: missing, error: missErr } = await admin
      .from('thought_chunks')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null)
    if (missErr) throw missErr

    return json({
      processed: todo?.length ?? 0,
      chunked,
      chunks_written: chunksWritten,
      failed,
      skip_next: skipNext,
      remaining: Math.max((await countNeeding()) - skipNext, 0),
      chunks_missing_embedding: missing ?? 0,
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
