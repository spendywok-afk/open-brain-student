// ============================================================================
// SHARED BY capture-url AND capture-youtube
// ============================================================================
// The parts both capture functions need: who is calling, and how to save.
//
// The saving here is deliberately plain — one upsert into thoughts, one into
// thought_sources — exactly what the app's own saveThought() did in Level 2.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { stripInvisible } from './text.ts'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// The "admin" client uses the service role key, which skips the security rule
// from Level 2 entirely. That is why every save below sets user_id by hand.
export function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
}

// Who is calling? Read from their login token — never from the request body.
// Trusting a user id sent in the body would let anyone write into anyone
// else's brain.
export async function getCaller(admin: ReturnType<typeof adminClient>, req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return null
  return data.user
}

export async function saveCapture(
  admin: ReturnType<typeof adminClient>,
  capture: {
    userId: string
    content: string
    metadata: Record<string, unknown>
    sourceText: string
    sourceKind: string
  },
) {
  const content = stripInvisible(capture.content)
  const sourceText = stripInvisible(capture.sourceText)

  const { data: thought, error } = await admin
    .from('thoughts')
    // upsert, not insert: capturing the same thing twice updates the existing
    // row instead of failing on the duplicate rule (dedup_key + user_id).
    .upsert(
      { user_id: capture.userId, content, metadata: capture.metadata },
      { onConflict: 'dedup_key,user_id', ignoreDuplicates: false },
    )
    .select('id, created_at')
    .single()
  if (error) throw error

  // The thought is already saved — a problem here must not undo the capture.
  try {
    const { error: srcErr } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: capture.userId,
      source_text: sourceText,
      source_kind: capture.sourceKind,
      char_count: sourceText.length,
      truncated: false,
    })
    if (srcErr) throw srcErr
  } catch (e) {
    console.warn('Thought saved, but its full source text was not stored:', e instanceof Error ? e.message : e)
  }

  return thought.id as string
}
