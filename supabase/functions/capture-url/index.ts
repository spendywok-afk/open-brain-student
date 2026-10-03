// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste a link to an article and this function fetches the page, strips it
// down to readable text, and saves it to your brain.
//
// WHY THIS RUNS ON THE SERVER: a web page in your browser is not allowed to
// fetch pages from other websites — that rule is called CORS, and it exists to
// protect you. That is why Level 2 made you copy article text by hand. A
// server has no such limit, so the app hands the link to this function and
// this function does the fetching.
//
// NO AI SUMMARY YET: this saves the full article text as-is. Summarising needs
// an AI key, which arrives in Level 5 — that level's enrichment agent will do
// the summarising. Saving the full text now means nothing is lost meanwhile.
//
// Fetching logic adapted from open-brain-express's capture-url. The saving is
// a plain insert, matching what the app's own URL tab did in Level 2.
// ============================================================================

import { adminClient, corsHeaders, getCaller, json, saveCapture } from '../_shared/capture.ts'
import { htmlToText } from '../_shared/text.ts'

const MAX_BYTES = 3_000_000 // don't try to swallow a 50MB page

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const admin = adminClient()
    const user = await getCaller(admin, req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A web address is required' }, 400)

    // Only http(s). Blocks attempts to make the server read other kinds of address.
    let parsed: URL
    try {
      parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : 'https://' + url.trim())
    } catch {
      return json({ ok: false, error: "That web address doesn't look right" }, 400)
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname.includes('.')) {
      return json({ ok: false, error: "That web address doesn't look right" }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return json({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may need a login or block automated readers — paste the text yourself instead.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to capture' }, 413)

    const extracted = htmlToText(raw)
    const text = extracted.text
    const title = extracted.title || parsed.hostname.replace(/^www\./, '')

    if (text.length < 200) {
      return json({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with ' +
          'JavaScript after loading, which a server cannot see — paste the text yourself instead.',
      }, 422)
    }

    // Same shape as a Level 2 URL capture, so it looks the same in your app.
    const id = await saveCapture(admin, {
      userId: user.id,
      content: '🔗 Web: ' + title + '\n' + parsed.href + '\n\n' + text,
      metadata: { url: parsed.href, title, captured_by: 'capture-url' },
      sourceText: text,
      sourceKind: 'web',
    })

    return json({ ok: true, id, title, chars: text.length })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = String(err).includes('timeout') || String(err).includes('TimeoutError')
      ? 'That page took too long to respond.'
      : err instanceof Error ? err.message : String(err)
    return json({ ok: false, error: msg }, 500)
  }
})
