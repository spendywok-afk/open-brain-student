// ============================================================================
// WEEKLY-DIGEST — a report on your own mind, every Sunday
// ============================================================================
// A pg_cron job inside your database calls this once a week. It reads the
// last 7 days of thoughts, asks the AI (through call-llm) what you have been
// learning, and:
//
//   1. saves the report as a new thought with category 'digest'
//   2. sends it to you on Telegram, if your bot's secrets are set
//
// Fewer than 5 thoughts in the week? It stops and says so in the logs —
// there is not enough to say anything useful.
//
// WHO MAY CALL THIS: deployed with --no-verify-jwt, so it checks for your
// AGENT_SECRET itself. The cron job reads that from Vault and sends it.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   AGENT_SECRET          the password the cron job sends
//   OWNER_USER_ID         your Supabase login's UID — whose week this is
//   TELEGRAM_BOT_TOKEN    optional, for delivery to Telegram
//   TELEGRAM_OWNER_ID     optional, your Telegram account's number
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { adminClient } from '../_shared/capture.ts'
import { callLLM } from '../_shared/llm.ts'

const env = (name: string) => Deno.env.get(name) ?? ''

const MIN_THOUGHTS = 5
// Each thought is sent as its summary when enrichment made one, otherwise as
// the start of its text. Keeps a week of long transcripts affordable.
const MAX_CHARS_PER_THOUGHT = 1_500

const SYSTEM_PROMPT = `You write a short weekly digest of someone's personal notes, addressed to them as "you".
Write plain text — no markdown symbols like # or **. Use these three sections, each starting with its title on its own line:

What you were learning
Key themes
A question you seem to be exploring

Under the first, group what they learned into a few short paragraphs. Under the second, list 3 to 5 themes, one per line, starting each with "- ". Under the third, write one open question in a sentence or two.
Be specific to what the notes actually say. Keep the whole digest under 400 words.`

type Thought = { content: string; category: string | null; tags: string[] | null; summary: string | null; created_at: string }

async function sendToTelegram(text: string) {
  const token = env('TELEGRAM_BOT_TOKEN')
  const chatId = env('TELEGRAM_OWNER_ID')
  if (!token || !chatId) return
  try {
    // Telegram caps one message at 4096 characters.
    for (let i = 0; i < text.length; i += 4000) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(i, i + 4000), link_preview_options: { is_disabled: true } }),
      })
      if (!res.ok) console.error('Telegram sendMessage failed:', res.status, await res.text())
    }
  } catch (e) {
    console.error('Could not reach Telegram:', e)
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  const secret = env('AGENT_SECRET')
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!secret || token !== secret) {
    console.warn('Rejected a call without the right AGENT_SECRET')
    return json({ error: 'Not allowed' }, 401)
  }

  try {
    const ownerUserId = env('OWNER_USER_ID')
    if (!ownerUserId) throw new Error('The OWNER_USER_ID secret is not set in Supabase.')

    const admin = adminClient()
    const weekEnd = new Date()
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000)

    const { data, error } = await admin
      .from('thoughts')
      .select('content, category, tags, summary, created_at')
      .eq('user_id', ownerUserId)
      .gte('created_at', weekStart.toISOString())
      .or('category.is.null,category.neq.digest')
      .order('created_at', { ascending: true })
    if (error) throw error

    const thoughts = (data ?? []) as Thought[]
    if (thoughts.length < MIN_THOUGHTS) {
      console.log(`Only ${thoughts.length} thoughts this week (need ${MIN_THOUGHTS}) — no digest.`)
      return json({ ok: true, skipped: true, thoughts: thoughts.length })
    }

    // Group by the category the enrichment agent gave each thought.
    const groups = new Map<string, Thought[]>()
    for (const t of thoughts) {
      const key = t.category ?? 'uncategorised'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(t)
    }

    let notes = ''
    for (const [category, items] of groups) {
      notes += `\n== ${category} (${items.length}) ==\n`
      for (const t of items) {
        const text = t.summary?.trim() || t.content.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_PER_THOUGHT)
        const tags = t.tags?.length ? ` [${t.tags.join(', ')}]` : ''
        notes += `- ${t.created_at.slice(0, 10)}${tags}: ${text}\n`
      }
    }

    const digest = await callLLM({
      systemPrompt: SYSTEM_PROMPT,
      prompt: `Here are my ${thoughts.length} notes from the past 7 days, grouped by category:\n${notes}`,
      maxTokens: 1500,
      userId: ownerUserId,
      source: 'weekly-digest',
    })
    if (!digest.trim()) throw new Error('The AI returned an empty digest')

    const range = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`
    const content = `Weekly digest, ${range} (${thoughts.length} thoughts)\n\n${digest.trim()}`

    // enriched_at is set so this row is never re-tagged by enrich-thought.
    // upsert, not insert: a re-run that produces the same text updates the
    // existing row instead of failing on the duplicate rule (dedup_key + user_id).
    const { error: saveErr } = await admin
      .from('thoughts')
      .upsert(
        {
          user_id: ownerUserId,
          content,
          category: 'digest',
          tags: ['digest'],
          summary: `Weekly digest of ${thoughts.length} thoughts, ${range}`,
          enriched_at: new Date().toISOString(),
          metadata: { source: 'weekly-digest', week_start: weekStart.toISOString(), week_end: weekEnd.toISOString() },
        },
        { onConflict: 'dedup_key,user_id', ignoreDuplicates: false },
      )
      .select('id, created_at')
      .single()
    if (saveErr) throw saveErr

    await sendToTelegram(content)

    console.log(`Digest saved: ${thoughts.length} thoughts, ${groups.size} categories`)
    return json({ ok: true, thoughts: thoughts.length })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('Weekly digest failed:', message)
    return json({ ok: false, error: message }, 500)
  }
})
