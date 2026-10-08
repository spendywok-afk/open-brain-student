// ============================================================================
// SHARED BY enrich-thought AND backfill-links — how a thought gets its links
// ============================================================================
// Finds the thought's nearest neighbours (find_links_for_thought) and saves a
// link to each in thought_links.
//
// Two rules on thought_links keep the graph clean:
//   - the same link twice (A→B, A→B)       → skipped by ignoreDuplicates
//   - the reverse of an existing link (B→A when A→B exists) → this is a
//     different unique index, which ignoreDuplicates does NOT cover. One such
//     row would fail the whole batch, so they are filtered out here first.
//
// Scoped to the thought's own user: this runs with the service role key,
// which skips row-level security, so the filter has to be passed by hand.
// ============================================================================

import { adminClient } from './capture.ts'

type Admin = ReturnType<typeof adminClient>

// Returns how many new links were saved. Throws on database errors.
export async function linkThought(
  admin: Admin,
  thought: { id: string; user_id: string | null },
  embedding: number[] | string,
): Promise<number> {
  if (!thought.user_id) return 0

  const { data: neighbors, error } = await admin.rpc('find_links_for_thought', {
    source_id: thought.id,
    source_embedding: embedding,
    p_user_id: thought.user_id,
    match_threshold: 0.5,
    match_count: 5,
  })
  if (error) throw error
  if (!neighbors?.length) return 0

  // Neighbours that already link TO this thought — the connection exists,
  // just saved the other way round.
  const ids = neighbors.map((n: { target_id: string }) => n.target_id)
  const { data: reverse, error: revErr } = await admin
    .from('thought_links')
    .select('source_thought_id')
    .eq('target_thought_id', thought.id)
    .in('source_thought_id', ids)
  if (revErr) throw revErr
  const alreadyLinked = new Set((reverse ?? []).map((r) => r.source_thought_id))

  const links = neighbors
    .filter((n: { target_id: string }) => !alreadyLinked.has(n.target_id))
    .map((n: { target_id: string; similarity: number }) => ({
      source_thought_id: thought.id,
      target_thought_id: n.target_id,
      user_id: thought.user_id,
      similarity_score: n.similarity,
      link_type: 'semantic',
    }))
  if (!links.length) return 0

  // ignoreDuplicates: a link that already exists is skipped, never an error.
  const { data: saved, error: linkErr } = await admin
    .from('thought_links')
    .upsert(links, { onConflict: 'source_thought_id,target_thought_id', ignoreDuplicates: true })
    .select('id')
  if (linkErr) throw linkErr
  return saved?.length ?? 0
}
