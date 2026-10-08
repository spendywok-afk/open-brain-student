// ============================================================================
// ENRICH-THOUGHT — your first agent
// ============================================================================
// Every time a new row lands in the thoughts table, a Supabase Database
// Webhook sends it here. This function asks the AI (through call-llm) for:
//
//   tags       3–5 short labels
//   category   idea, learning, question, reference, plan or reflection
//   summary    one sentence
//
// and writes them back onto the same row. Then it asks generate-embedding for
// the thought's meaning as 1,536 numbers and stores that in the embedding
// column. The two steps are independent: if tagging fails the embedding is
// still tried, and if the embedding fails the thought just waits for the
// backfill. Short notes and the weekly digest skip tagging but still get an
// embedding, so they show up in meaning-based search.
//
// Once the embedding is saved, it finds the thought's nearest neighbours (more
// than 50% similar, at most 5) and links them in thought_links — the graph.
//
// Last, long thoughts (over 2,000 characters) are cut into ~300-word pieces,
// each with its own embedding, in thought_chunks — so a detail buried deep in a
// transcript can be found on its own. Short thoughts are skipped.
//
// It answers the webhook straight away and does the work afterwards, because
// webhooks give up waiting after a few seconds and an AI call can take longer.
// It always answers 200: a webhook that keeps failing is no help to anyone,
// and the thought itself is already safely saved. Problems go to the logs
// (Supabase → Edge Functions → enrich-thought → Logs).
//
// WHO MAY CALL THIS: deployed with --no-verify-jwt, so it checks for your
// AGENT_SECRET itself. The webhook sends it as "Authorization: Bearer ...".
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   AGENT_SECRET   the password the webhook (and the weekly cron job) send
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { adminClient } from '../_shared/capture.ts'
import { callLLM } from '../_shared/llm.ts'
import { generateEmbedding } from '../_shared/embedding.ts'
import { linkThought } from '../_shared/links.ts'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']

// Long captures (a full YouTube transcript) are cut to this many characters
// before going to the AI. Plenty to tag and summarise from, and it keeps the
// cost of one enormous capture to a few cents.
const MAX_CHARS = 60_000

const SYSTEM_PROMPT = `You tag notes in a personal knowledge base.
Reply with ONLY a JSON object, no other text:
{"tags": ["3 to 5 short lowercase tags"], "category": "one of: ${CATEGORIES.join(', ')}", "summary": "one sentence"}
Tags should be specific topics a person would search for later. The summary describes what the note is about, in plain words.`

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

async function enrich(record: { id: string; user_id: string | null; content: string }) {
  try {
    const content = record.content.length > MAX_CHARS
      ? record.content.slice(0, MAX_CHARS) + '\n\n[note continues — cut here for tagging]'
      : record.content

    const reply = await callLLM({
      systemPrompt: SYSTEM_PROMPT,
      prompt: `The note:\n\n${content}`,
      maxTokens: 400,
      userId: record.user_id,
      source: 'enrich-thought',
    })

    // Pull the {...} out even if the AI wrapped it in extra words.
    const match = reply.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`AI reply had no JSON in it: ${reply.slice(0, 200)}`)
    const parsed = JSON.parse(match[0])

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t: unknown) => typeof t === 'string' && t.trim()).map((t: string) => t.trim().toLowerCase()).slice(0, 5)
      : []
    const category = typeof parsed.category === 'string' && CATEGORIES.includes(parsed.category.toLowerCase())
      ? parsed.category.toLowerCase()
      : null
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 500) : null

    const { error } = await adminClient()
      .from('thoughts')
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq('id', record.id)
    if (error) throw error

    console.log(`Enriched ${record.id}: [${tags.join(', ')}] ${category}`)
  } catch (e) {
    console.error(`Could not enrich ${record.id}:`, e instanceof Error ? e.message : e)
  }
}

async function embed(record: { id: string; user_id: string | null; content: string }) {
  try {
    const embedding = await generateEmbedding({
      text: record.content,
      userId: record.user_id,
      source: 'enrich-thought',
    })
    // No embedding? Carry on — the thought is saved and the backfill can
    // fill this in later. generate-embedding already logged why.
    if (!embedding) return

    const { error } = await adminClient()
      .from('thoughts')
      .update({ embedding })
      .eq('id', record.id)
    if (error) throw error

    console.log(`Embedded ${record.id}`)
    await link(record, embedding)
  } catch (e) {
    console.error(`Could not save embedding for ${record.id}:`, e instanceof Error ? e.message : e)
  }
}

// Auto-link: find the thought's nearest neighbours and save a link to each.
// Only runs once the embedding is saved — no embedding, no linking.
async function link(record: { id: string; user_id: string | null }, embedding: number[]) {
  try {
    const count = await linkThought(adminClient(), record, embedding)
    console.log(`Linked ${record.id} to ${count} thought(s)`)
  } catch (e) {
    console.error(`Could not link ${record.id}:`, e instanceof Error ? e.message : e)
  }
}

// Chunk it, if it's long enough to be worth it. Never throws, and does nothing
// for thoughts under 2,000 characters — safe to call on every thought.
async function chunk(record: { id: string; user_id: string | null; content: string }) {
  const count = await saveThoughtChunksSafe(
    adminClient(), record.id, record.content, 'enrich-thought', 'summary', record.user_id ?? undefined,
  )
  if (count) console.log(`Chunked ${record.id} into ${count} piece(s)`)
}

Deno.serve(async (req) => {
  const ok = () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })

  const secret = Deno.env.get('AGENT_SECRET') ?? ''
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!secret || token !== secret) {
    console.warn('Rejected a call without the right AGENT_SECRET')
    return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 401 })
  }

  const payload = await req.json().catch(() => null)
  const record = payload?.record

  if (payload?.type !== 'INSERT' || !record?.id || typeof record.content !== 'string' || !record.content.trim()) {
    console.log('Nothing to enrich in this call')
    return ok()
  }

  let tag = true
  if (record.content.trim().length < 20) {
    console.log(`Skipped tagging ${record.id}: too short to tag`)
    tag = false
  }
  // The weekly digest saves itself as a thought — leave its category alone.
  if (record.category === 'digest' || record.enriched_at) {
    tag = false
  }

  // Tag first, then embed — every thought gets an embedding either way.
  // Then chunk: independent of the whole-thought embedding, so a failure there
  // doesn't stop the pieces from being embedded.
  const work = (async () => {
    if (tag) await enrich(record)
    await embed(record)
    await chunk(record)
  })()
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work)
  else await work

  return ok()
})
