// Telegram bot for Open Brain.
//
// Telegram calls this function (a "webhook") every time someone messages your
// bot. It checks the message really came from Telegram, and really came from
// YOU, then:
//
//   /search words   or   ?words   → finds up to 5 matching thoughts
//   /recent                       → shows your 5 newest thoughts
//   /start  or  /help             → shows what the bot can do
//   anything else                 → saves it as a new thought
//
// It is deployed with --no-verify-jwt, because Telegram cannot send a Supabase
// login token. That leaves the door open, so this code checks who is knocking.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN       from BotFather — lets this code send replies
//   TELEGRAM_WEBHOOK_SECRET  a password Telegram sends with every message
//   TELEGRAM_OWNER_ID        your Telegram account's number — only you get answers
//   OWNER_USER_ID            your Supabase login's UID — who the thoughts belong to
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-telegram-bot-api-secret-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Telegram retries any message that does not get a 200 back, over and over.
// So once we know a request is really from Telegram, we always answer 200 —
// even when something went wrong — and report the problem in the chat instead.
const ok = () => new Response('ok', { headers: corsHeaders })

const env = (name: string) => Deno.env.get(name) ?? ''

const HELP =
  '🧠 Your Open Brain bot\n\n' +
  '• Send any message → saved to your brain\n' +
  '• /search coffee  (or  ?coffee) → find matching thoughts\n' +
  '• /recent → your 5 newest thoughts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return ok()
  if (req.method !== 'POST') return ok()

  // ── Check 1: is this really Telegram? ──────────────────────────────────
  // When you registered the webhook you gave Telegram a secret. It sends that
  // secret in a header with every message. Anyone else calling this address
  // will not have it. (Not Telegram, so the "always 200" rule doesn't apply.)
  const secret = env('TELEGRAM_WEBHOOK_SECRET')
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    console.warn('Rejected a request: missing or wrong webhook secret')
    return new Response('unauthorized', { status: 401, headers: corsHeaders })
  }

  let update: any
  try {
    update = await req.json()
  } catch {
    return ok()
  }

  // Edits, reactions, being added to groups, etc. — nothing to do.
  const msg = update?.message
  if (!msg?.chat?.id) return ok()
  const chatId = msg.chat.id

  // ── Check 2: is this really you? ───────────────────────────────────────
  // Only a private chat with your own Telegram account gets through. In a
  // group, replies would be visible to everyone in it.
  const ownerTelegramId = env('TELEGRAM_OWNER_ID')
  if (msg.chat.type !== 'private' || !ownerTelegramId || String(msg.from?.id) !== ownerTelegramId) {
    await reply(
      chatId,
      '🔒 This is a private bot.\n\n' +
        'If this is your bot, your Telegram ID is: ' + msg.from?.id + '\n' +
        'Add it in Supabase as the secret TELEGRAM_OWNER_ID.',
    )
    return ok()
  }

  try {
    const ownerUserId = env('OWNER_USER_ID')
    if (!ownerUserId) throw new Error('The OWNER_USER_ID secret is not set in Supabase.')

    // The service role key skips the security rule from Level 2 entirely, so
    // every query below must say whose thoughts it means — by hand.
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })

    const text = (msg.text ?? '').trim()
    if (!text) {
      await reply(chatId, 'I can only save text messages for now.')
      return ok()
    }

    const searchMatch = text.match(/^\/search(@\w+)?\s*([\s\S]*)$/i)
    if (searchMatch || text.startsWith('?')) {
      const query = (searchMatch ? searchMatch[2] : text.slice(1)).trim()
      await reply(chatId, query ? await search(db, ownerUserId, query) : 'What should I search for? Try: /search coffee')
    } else if (/^\/recent(@\w+)?$/i.test(text)) {
      await reply(chatId, await recent(db, ownerUserId))
    } else if (/^\/(start|help)(@\w+)?$/i.test(text)) {
      await reply(chatId, HELP)
    } else if (text.startsWith('/')) {
      await reply(chatId, "I don't know that command.\n\n" + HELP)
    } else {
      // upsert, not insert: if Telegram re-sends a message, the existing row is
      // updated instead of a duplicate being saved (dedup_key + user_id).
      const { error } = await db
        .from('thoughts')
        .upsert(
          { content: text, user_id: ownerUserId, metadata: { source: 'telegram' } },
          { onConflict: 'dedup_key,user_id', ignoreDuplicates: false },
        )
        .select('id, created_at')
        .single()
      if (error) throw error
      await reply(chatId, '✅ Saved to your brain')
    }
  } catch (e) {
    console.error('telegram-bot error:', e)
    await reply(chatId, '⚠️ Something went wrong: ' + (e instanceof Error ? e.message : String(e)))
  }

  return ok()
})

async function search(db: any, ownerUserId: string, query: string) {
  // % and _ are wildcards in ilike; escape them so they match literally
  const pattern = '%' + query.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
  const { data, error } = await db
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', ownerUserId)
    .ilike('content', pattern)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data.length) return '🔎 Nothing matches "' + query + '"'
  return '🔎 Top ' + data.length + ' for "' + query + '":\n\n' + data.map(formatThought).join('\n\n')
}

async function recent(db: any, ownerUserId: string) {
  const { data, error } = await db
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', ownerUserId)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data.length) return 'Your brain is empty. Send me a thought!'
  return '🕒 Your 5 newest thoughts:\n\n' + data.map(formatThought).join('\n\n')
}

// Telegram messages max out at 4096 characters, and a PDF or transcript can be
// far longer — so each thought shows as a short preview.
function formatThought(t: { content: string; created_at: string }, i: number) {
  const date = new Date(t.created_at).toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
  })
  const oneLine = (t.content ?? '').replace(/\s+/g, ' ').trim()
  const preview = oneLine.length > 300 ? oneLine.slice(0, 300) + '…' : oneLine
  return (i + 1) + '. [' + date + '] ' + preview
}

async function reply(chatId: number, text: string) {
  try {
    const res = await fetch('https://api.telegram.org/bot' + env('TELEGRAM_BOT_TOKEN') + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Plain text on purpose: no formatting mode means no characters in your
      // thoughts can break the message.
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        link_preview_options: { is_disabled: true },
      }),
    })
    if (!res.ok) console.error('Telegram sendMessage failed:', res.status, await res.text())
  } catch (e) {
    console.error('Could not reach Telegram:', e)
  }
}
