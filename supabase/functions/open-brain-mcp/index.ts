// Open Brain MCP server.
//
// MCP (Model Context Protocol) is an open standard that lets AI assistants use
// tools. Any AI that speaks MCP — Claude Desktop today, others tomorrow — sends
// this function small JSON messages in a format called "JSON-RPC", like:
//
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
//
// and this function answers with what it can do, or does it. The AI never
// touches your database itself. It only ever sees what these tools hand back.
//
// The tools on the "menu":
//   search_thoughts  find thoughts related in meaning to a question or topic
//   list_recent      your newest thoughts
//   get_thought      the full text of one thought (the other two show previews)
//   add_thought      save a new thought
// There is deliberately no edit or delete tool. The AI cannot do what is not
// on the menu.
//
// It is deployed with --no-verify-jwt, because Claude Desktop cannot send a
// Supabase login token. That leaves the door open, so the first thing this
// code does is check for your MCP_ACCESS_KEY.
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   MCP_ACCESS_KEY   the password Claude Desktop sends with every request
//   OWNER_USER_ID    your Supabase login's UID — whose thoughts these are
// And two that Supabase provides automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2'
import { stripInvisible } from '../_shared/text.ts'
import { generateEmbedding } from '../_shared/embedding.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const env = (name: string) => Deno.env.get(name) ?? ''

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// A YouTube transcript or PDF can be tens of thousands of characters. Search
// and list results show a preview of each, so ten long thoughts don't flood
// the AI's working memory. get_thought returns the whole thing, up to a ceiling.
const PREVIEW_CHARS = 1500
const FULL_CHARS = 100_000

// MCP has dated versions. The AI says which one it speaks; if we know it we
// agree, otherwise we offer our newest and the AI decides.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

// ── The menu ───────────────────────────────────────────────────────────────
// The descriptions are written for the AI — they are how it decides when and
// how to use each tool.
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's Open Brain — their personal knowledge base of notes, YouTube transcripts, " +
      'articles, PDFs and Telegram messages — for thoughts related in meaning to the query. Matching is ' +
      'by meaning, not exact words, so describe the idea naturally (a question or short phrase works ' +
      'well). Returns up to 10 matches, most similar first, as previews with a similarity score from ' +
      '0 to 1. Each match may list "connected" thoughts — ones the brain linked to it automatically ' +
      'because they are close in meaning; mention them when relevant, since they often surface ideas ' +
      'the user forgot. Call get_thought with an id for the full text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The idea, question or topic to look for' } },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: "The user's most recently saved thoughts in their Open Brain, newest first, as previews.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return (default 10, max 50)' },
      },
    },
  },
  {
    name: 'get_thought',
    description: 'The full text of one thought, by the id shown in search_thoughts or list_recent results.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The thought id' } },
      required: ['id'],
    },
  },
  {
    name: 'add_thought',
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks you to save, " +
      'capture or remember something.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The text to save' } },
      required: ['content'],
    },
  },
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // ── The lock: is this really your Claude? ──────────────────────────────
  // Checked before anything else, so a stranger learns nothing — not even
  // what tools exist.
  const key = env('MCP_ACCESS_KEY')
  const sent = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!key || !sameText(sent, key)) {
    console.warn('Rejected a request: missing or wrong MCP access key')
    return json({ error: 'unauthorized' }, 401)
  }

  // MCP clients sometimes ask to open a long-lived stream with GET. This
  // server only answers questions, so it says "POST only" and the client
  // carries on without one.
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { ...corsHeaders, Allow: 'POST, OPTIONS' } })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json(rpcError(null, -32700, 'That was not valid JSON'), 400)
  }

  // Older MCP versions may bundle several messages in one list.
  const messages = Array.isArray(body) ? body : [body]
  const replies = []
  for (const msg of messages) {
    const reply = await handle(msg)
    if (reply) replies.push(reply)
  }

  // Messages without an id are "notifications" — FYIs that expect no answer.
  if (!replies.length) return new Response(null, { status: 202, headers: corsHeaders })
  return json(Array.isArray(body) ? replies : replies[0])
})

// ── The switchboard: one JSON-RPC message in, one answer out ───────────────
async function handle(msg: any) {
  const id = msg?.id
  const isNotification = id === undefined || id === null

  if (msg?.jsonrpc !== '2.0' || typeof msg?.method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Not a JSON-RPC 2.0 request')
  }
  if (isNotification) return null

  switch (msg.method) {
    // The handshake: the AI introduces itself, we introduce ourselves.
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'open-brain', version: '1.0.0' },
        instructions:
          "This is the user's Open Brain: their own notes, saved videos, articles and PDFs. " +
          'When a question touches something they may have captured, search it before answering ' +
          'from general knowledge, and say which thoughts you drew on.',
      })
    }

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })

    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      try {
        const text = await callTool(name, args)
        return rpcResult(id, { content: [{ type: 'text', text }] })
      } catch (e) {
        // A tool failing is reported to the AI as a normal answer marked as an
        // error, so it can read what went wrong and try something else.
        console.error('open-brain-mcp tool error:', name, e)
        const message = e instanceof Error ? e.message : String((e as any)?.message ?? e)
        return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + message }], isError: true })
      }
    }

    default:
      return rpcError(id, -32601, 'Unknown method: ' + msg.method)
  }
}

// ── The kitchen: each tool's actual database work ──────────────────────────
async function callTool(name: string, args: Record<string, unknown>) {
  const ownerUserId = env('OWNER_USER_ID')
  if (!ownerUserId) throw new Error('The OWNER_USER_ID secret is not set in Supabase.')

  // The service role key skips the security rule from Level 2 entirely, so
  // every query below must say whose thoughts it means — by hand.
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  })

  switch (name) {
    case 'search_thoughts': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query is empty — pass a word or phrase to search for')

      // Search by meaning: turn the question into an embedding, then ask the
      // database for the thoughts whose embeddings point the same way.
      const embedding = await generateEmbedding({ text: query, userId: ownerUserId, source: 'mcp-search' })
      if (embedding) {
        const { data, error } = await db.rpc('search_thoughts', {
          query_embedding: embedding,
          p_user_id: ownerUserId,
          match_threshold: 0.3,
          match_count: 10,
        })
        if (error) throw error
        if (!data.length) return 'No thoughts are close in meaning to "' + query + '". Try describing it differently.'
        // Connections are a bonus — if fetching them fails, still return the results.
        const connected = await connectionsFor(db, ownerUserId, data.map((t: Thought) => t.id)).catch((e) => {
          console.warn('Search worked, but connections could not be loaded:', e instanceof Error ? e.message : e)
          return new Map<string, { id: string; similarity: number; content: string }[]>()
        })
        return JSON.stringify(
          data.map((t: Thought & { similarity: number }) => ({
            ...preview(t),
            similarity: round2(t.similarity),
            ...(connected.get(t.id)?.length ? { connected: connected.get(t.id) } : {}),
          })),
          null,
          2,
        )
      }

      // No embedding (provider down, out of credit): fall back to plain text
      // matching so search still works, just less cleverly.
      // % and _ are wildcards in ilike; escape them so they match literally
      const pattern = '%' + query.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
      const { data, error } = await db
        .from('thoughts')
        .select('id, content, created_at, metadata')
        .eq('user_id', ownerUserId)
        .ilike('content', pattern)
        .order('created_at', { ascending: false })
        .limit(10)
      if (error) throw error
      if (!data.length) return 'No thoughts contain "' + query + '". Try a different or shorter word.'
      return JSON.stringify(data.map(preview), null, 2)
    }

    case 'list_recent': {
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 10), 1), 50)
      const { data, error } = await db
        .from('thoughts')
        .select('id, content, created_at, metadata')
        .eq('user_id', ownerUserId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      if (!data.length) return 'The brain is empty.'
      return JSON.stringify(data.map(preview), null, 2)
    }

    case 'get_thought': {
      const id = String(args.id ?? '').trim()
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('That is not a valid thought id')
      const { data, error } = await db
        .from('thoughts')
        .select('id, content, created_at, metadata')
        .eq('user_id', ownerUserId)
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      if (!data) return 'No thought with id ' + id
      const cut = data.content.length > FULL_CHARS
      return JSON.stringify(
        {
          id: data.id,
          created_at: data.created_at,
          source: data.metadata?.source ?? null,
          content: cut ? data.content.slice(0, FULL_CHARS) : data.content,
          ...(cut ? { note: 'Cut at ' + FULL_CHARS + ' of ' + data.content.length + ' characters' } : {}),
        },
        null,
        2,
      )
    }

    case 'add_thought': {
      const content = stripInvisible(String(args.content ?? '')).trim()
      if (!content) throw new Error('content is empty — nothing to save')
      const { data, error } = await db
        .from('thoughts')
        // upsert, not insert: saving the same text twice updates the existing
        // row instead of failing on the duplicate rule (dedup_key + user_id).
        .upsert(
          { content, user_id: ownerUserId, metadata: { source: 'mcp' } },
          { onConflict: 'dedup_key,user_id', ignoreDuplicates: false },
        )
        .select('id, content, created_at')
        .single()
      if (error) throw error
      return 'Saved to the brain:\n' + JSON.stringify(data, null, 2)
    }

    default:
      throw new Error('Unknown tool: ' + name)
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────
type Thought = { id: string; content: string; created_at: string; metadata: any }

function preview(t: Thought) {
  const content = t.content ?? ''
  return {
    id: t.id,
    created_at: t.created_at,
    source: t.metadata?.source ?? null,
    content: content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) + '…' : content,
    ...(content.length > PREVIEW_CHARS ? { full_length: content.length } : {}),
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// The graph: for each search result, the thoughts it is linked to in
// thought_links (either direction), strongest first, as short previews.
const CONNECTED_PER_RESULT = 3
const CONNECTED_PREVIEW_CHARS = 300

async function connectionsFor(db: any, ownerUserId: string, ids: string[]) {
  const byThought = new Map<string, { id: string; similarity: number; content: string }[]>()
  if (!ids.length) return byThought

  const list = ids.join(',')
  const { data: links, error } = await db
    .from('thought_links')
    .select('source_thought_id, target_thought_id, similarity_score')
    .eq('user_id', ownerUserId)
    .or(`source_thought_id.in.(${list}),target_thought_id.in.(${list})`)
    .order('similarity_score', { ascending: false })
  if (error) throw error
  if (!links?.length) return byThought

  // Pair each result with the thought at the other end of each of its links.
  const pairs: { from: string; to: string; similarity: number }[] = []
  for (const l of links) {
    if (ids.includes(l.source_thought_id)) pairs.push({ from: l.source_thought_id, to: l.target_thought_id, similarity: l.similarity_score })
    if (ids.includes(l.target_thought_id)) pairs.push({ from: l.target_thought_id, to: l.source_thought_id, similarity: l.similarity_score })
  }

  const otherIds = [...new Set(pairs.map((p) => p.to))]
  const { data: others, error: othersErr } = await db
    .from('thoughts')
    .select('id, content')
    .eq('user_id', ownerUserId)
    .in('id', otherIds)
  if (othersErr) throw othersErr
  const text = new Map<string, string>((others ?? []).map((o: { id: string; content: string }) => [o.id, o.content ?? '']))

  for (const p of pairs) {
    const content = text.get(p.to)
    if (content === undefined) continue
    const items = byThought.get(p.from) ?? []
    if (items.length >= CONNECTED_PER_RESULT) continue
    items.push({
      id: p.to,
      similarity: round2(p.similarity),
      content: content.length > CONNECTED_PREVIEW_CHARS ? content.slice(0, CONNECTED_PREVIEW_CHARS) + '…' : content,
    })
    byThought.set(p.from, items)
  }
  return byThought
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

// Compares every character even after a mismatch, so the time a wrong guess
// takes doesn't hint at how many characters were right.
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

