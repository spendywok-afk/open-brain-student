// ============================================================================
// TEXT HELPERS — shared by capture-url and capture-youtube
// ============================================================================
// Adapted from open-brain-express (_shared/text.ts and _shared/html-extract.ts).
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'",
  lt: '<', gt: '>',
  // punctuation
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»',
  // currency / symbols
  pound: '£', euro: '€', cent: '¢', yen: '¥',
  copy: '©', reg: '®', trade: '™', deg: '°',
  times: '×', divide: '÷', plusmn: '±',
  frac12: '½', frac14: '¼', frac34: '¾',
  // Spanish / accented Latin
  iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', auml: 'ä', Auml: 'Ä',
  ccedil: 'ç', Ccedil: 'Ç',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ',
  oslash: 'ø', Oslash: 'Ø', szlig: 'ß',
}

// Out-of-range numbers are left as written instead of crashing.
const fromCode = (n: number, original: string) =>
  n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : original

// Turns "&rsquo;" into ’, "&#241;" into ñ, and so on.
// &amp; is decoded LAST, so a double-escaped "&amp;lt;" becomes the text
// "&lt;" and never a real "<".
export function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : NAMED_ENTITIES[name] ?? m))
    .replace(/&#(?!0*38;)(\d+);/g, (m, n) => fromCode(Number(n), m))
    .replace(/&#x(?!0*26;)([0-9a-fA-F]+);/gi, (m, n) => fromCode(parseInt(n, 16), m))
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
}

// Web pages can carry invisible control characters (like the "null"
// character) and broken half-emoji. The database rejects those with
// "unsupported Unicode escape sequence", so they are removed before saving.
// Line breaks and tabs are kept. Same rule as the app's own stripInvisible().
export function stripInvisible(s: string): string {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

// HTML -> readable text. Deliberately simple — no external library. Strip the
// machinery (scripts, styles, navigation, footers), then remove the remaining
// tags. Not perfect on every site, but it handles articles and blog posts well.
export function htmlToText(html: string): { title: string; text: string } {
  // Title first, before we destroy the markup
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    // Remove entire elements that never contain article content
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    // Keep paragraph and heading breaks as newlines so structure survives
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Everything else goes
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}
