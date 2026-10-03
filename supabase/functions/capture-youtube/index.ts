// ============================================================================
// CAPTURE-YOUTUBE
// ============================================================================
// Paste a YouTube link, get what was said in the video saved to your brain.
//
// WHY THIS FILE IS COMPLICATED — worth understanding before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre — which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code, it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA    — a service built for this. Fetches from home internet
//                    connections, so it gets real transcripts. Free tier covers
//                    ~100 videos/month. Optional: with no SUPADATA_API_KEY
//                    secret we skip straight to route 2.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the iPhone
//                    and Android apps, which YouTube often serves properly even
//                    from a datacentre. No key needed, free, works sometimes.
//   3. DESCRIPTION — if no captions can be had, fall back to the video's
//                    description so you still capture something. Clearly
//                    labelled as such, in the saved thought AND in the app.
//
// NO AI SUMMARY YET: this saves the transcript as-is. Summarising needs an AI
// key, which arrives in Level 5 — that level's enrichment agent will do it.
//
// Fetching logic adapted from open-brain-express's capture-youtube. The saving
// is a plain insert, matching what the app's own YouTube tab did in Level 2.
// ============================================================================

import { adminClient, corsHeaders, getCaller, json, saveCapture } from '../_shared/capture.ts'
import { decodeEntities } from '../_shared/text.ts'

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: 'supadata' | 'innertube' | 'description'
}

// ---------------------------------------------------------------------------
// Pull the 11-character video id out of any YouTube link shape
// ---------------------------------------------------------------------------
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live|v)\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.trim().match(p)
    if (m) return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Title via oEmbed — lightweight, no key, essentially always works
// ---------------------------------------------------------------------------
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return decodeEntities(data.title as string)
    }
  } catch { /* fall through to placeholder */ }
  return `Video ${videoId}`
}

// ---------------------------------------------------------------------------
// ROUTE 1 — Supadata
// ---------------------------------------------------------------------------
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  // Read per request, so adding the secret later works without code changes.
  const key = Deno.env.get('SUPADATA_API_KEY') ?? ''
  if (!key) {
    console.log('[youtube] No SUPADATA_API_KEY — skipping to Innertube')
    return null
  }

  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(25_000) },
    )
    if (!res.ok) {
      // 402 / 429 here almost always means the free monthly quota is spent
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`)
      return null
    }

    const data = await res.json()
    // Supadata returns either plain text or a list of timed segments
    const transcript = (
      typeof data?.content === 'string'
        ? data.content
        : (data?.content ?? []).map((s: { text?: string }) => s.text ?? '').join(' ')
    )
      .replace(/\s+/g, ' ')
      .trim()

    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: decodeEntities(transcript), hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
// ROUTE 2 — Innertube (YouTube's internal app API)
//
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// full caption list even from a datacentre, where the normal web page would
// give us nothing.
// ---------------------------------------------------------------------------
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  // deno-lint-ignore no-explicit-any
  let best: any = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }

      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response around — even without captions it carries the
      // description, which is better than nothing.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks

    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      // deno-lint-ignore no-explicit-any
      const t = tracks as any[]
      const track =
        t.find((x) => x.languageCode === 'en' && x.kind !== 'asr') ??
        t.find((x) => x.languageCode === 'en') ??
        t.find((x) => String(x.languageCode ?? '').startsWith('en')) ??
        t[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })

      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML comes in two shapes:
        //   <text start="1.2" dur="3.4">words here</text>
        //   <p t="1200" d="3400"><s>words</s><s> here</s></p>
        let parts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1])
        if (!parts.length) parts = [...xml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1])
        const transcript = parts
          .map((p) => decodeEntities(p.replace(/<[^>]+>/g, '')))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
        console.log('[youtube] Innertube caption file came back empty')
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = (details?.keywords as string[] | undefined)?.join(', ') ?? ''

    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }

    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const admin = adminClient()
    const user = await getCaller(admin, req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    const url = body?.url
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A YouTube link is required' }, 400)

    const videoId = extractVideoId(url)
    if (!videoId) {
      return json({
        ok: false,
        error: "That doesn't look like a YouTube video link. Expected something like https://www.youtube.com/watch?v=...",
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    // The app lets you edit the title before capturing; use that if given.
    const typedTitle = typeof body?.title === 'string' ? body.title.trim().slice(0, 300) : ''
    const title = typedTitle || (await fetchTitle(videoUrl, videoId))

    // Try each route in order, first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))

    if (!result) {
      return json({
        ok: false,
        error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked.',
      }, 422)
    }

    // Same shape as a Level 2 YouTube capture, so it looks the same in your app.
    // A description-only capture says so right in the thought, so you are never
    // fooled into thinking it is what was actually said.
    const header = '📹 YouTube: ' + title + '\n' + videoUrl + '\n\n'
    const content = result.hasTranscript
      ? header + result.content
      : header + "(No transcript was available — this is the video's description, not what was said.)\n\n" + result.content

    const id = await saveCapture(admin, {
      userId: user.id,
      content,
      metadata: {
        title,
        video_id: videoId,
        video_url: videoUrl,
        has_transcript: result.hasTranscript,
        fetched_via: result.source,
        captured_by: 'capture-youtube',
      },
      sourceText: result.content,
      sourceKind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
    })

    return json({
      ok: true,
      id,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      chars: result.content.length,
    })
  } catch (err) {
    console.error('[youtube] Failed:', err)
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
