/**
 * Semantic HTML compressor.
 *
 * Strips everything GPT-5.1 doesn't need for content auditing:
 *   - class, id, style, data-* attributes (80%+ of a Tailwind page's attribute bloat)
 *   - <script>, <style>, <noscript> tags entirely
 *   - HTML comments
 *   - Inline SVG content → <svg/> placeholder (preserving aria-label if present)
 *   - data: URI src values (base64 images — huge token cost, zero audit value)
 *   - Collapsed/redundant whitespace
 *
 * Preserves:
 *   - All semantic HTML structure (nav, main, section, h1-h6, p, ul, etc.)
 *   - Text content
 *   - href, src (non-data-URI), alt, title, type, role, for, name, target, lang, rel
 *   - All aria-* attributes (accessibility auditing)
 *
 * Result: a 200K char page typically compresses to 40-70K chars (60-80% reduction).
 * This is applied AFTER stripHtmlNoise and BEFORE the model prompt — the element
 * manifest in firecrawl-adapter.ts continues to use the raw (pre-compression) HTML.
 *
 * NOTE: compressHtml is self-contained — it removes scripts/SVGs/comments
 * defensively even though stripHtmlNoise already handles them in the main pipeline.
 * This allows it to be used standalone without depending on call order.
 */

import * as cheerio from 'cheerio'
import Logger from './logger'

// Attributes to keep — everything needed for content + accessibility auditing
const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'type', 'role', 'for',
  'name', 'target', 'lang', 'rel', 'action', 'method', 'value', 'placeholder',
  'colspan', 'rowspan', 'scope', 'headers',
  // inert marks elements as non-interactive and hidden from AT — keeps inactive
  // digits in animated number components (e.g. number-flow-react) from being
  // read as content by the model
  'inert',
])

// Inline formatting-only tags to unwrap (keep text content, remove wrapper).
// Bold/italic/underline carry no semantic meaning for content auditing.
// Verified via LangSmith: no audit issue has ever relied on text being bold or italic.
// Must be a const array for use in cheerio selector strings.
const INLINE_FORMAT_TAGS = [
  'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
  'sub', 'sup', 'small', 'font', 'bdt', 'bdo', 'tt', 'strike', 'big',
]

/**
 * Compress HTML to semantic-only form for model consumption.
 *
 * @param html - Raw or stripped HTML string
 * @returns Compressed HTML with only semantic structure, text, and key attributes
 */
export function compressHtml(html: string): string {
  const $ = cheerio.load(html, { decodeEntities: false })

  // Remove non-content tags entirely (defensive — stripHtmlNoise handles these
  // in the main pipeline, but keeping them here makes the fn safe to call standalone)
  $('script, style, noscript, template, head').remove()

  // Collapse inline SVGs to placeholder — preserve aria-label/role if present
  $('svg').each((_i, el) => {
    const $el = $(el)
    const ariaLabel = $el.attr('aria-label')
    const role = $el.attr('role')
    if (ariaLabel) {
      $el.replaceWith(`<svg aria-label="${ariaLabel}"/>`)
    } else if (role) {
      $el.replaceWith(`<svg role="${role}"/>`)
    } else {
      $el.replaceWith('<svg/>')
    }
  })

  // Remove visually-hidden elements BEFORE stripping classes.
  // Tailwind's `hidden` class means display:none; `sr-only` clips to 1px; `invisible`
  // means visibility:hidden. After class stripping, these elements get unwrapped and their
  // text content merges with adjacent text — causing phantom audit issues like
  // "Add to your websiteA" (where "A" was a keyboard-shortcut badge inside a hidden span).
  // Widened from $('span') to $('*') — hidden/sr-only/invisible are applied to div, p, a,
  // and other elements too, not just spans.
  // Two-tier hidden-class removal:
  //
  // Tier 1 — spans: always remove if hidden/sr-only/invisible, regardless of responsive
  // counterpart classes. Spans get unwrapped later (they carry no block structure), so a
  // `hidden md:block` span would merge its text into adjacent content — the original
  // stray-A false positive. Stage 1 (browser JS) is the authority on viewport visibility;
  // stage 3 removes all hidden spans as a safety net.
  //
  // Tier 2 — all other elements: only remove if there is NO responsive show class (md:flex,
  // lg:block, etc.). Block elements like `<div class="hidden md:flex">` are desktop-visible
  // nav containers — stage 1 at desktop viewport correctly leaves them in, so stage 3
  // must not remove them. Only remove truly-always-hidden block elements.
  $('span').each((_i, el) => {
    const cls = (el as any).attribs?.class || ''
    if (/(?:^|\s)hidden(?:\s|$)|(?:^|\s)sr-only(?:\s|$)|(?:^|\s)invisible(?:\s|$)/.test(cls)) {
      $(el).remove()
    }
  })
  $(':not(span)').each((_i, el) => {
    const cls = (el as any).attribs?.class || ''
    const isHidden = /(?:^|\s)hidden(?:\s|$)|(?:^|\s)sr-only(?:\s|$)|(?:^|\s)invisible(?:\s|$)/.test(cls)
    if (!isHidden) return
    // Skip responsive patterns like `hidden md:flex` — visible at larger breakpoints.
    const hasResponsiveShow = /(?:sm|md|lg|xl|2xl):[a-z]/.test(cls)
    if (hasResponsiveShow) return
    $(el).remove()
  })

  // Detect badge/tag/label spans before attribute stripping — class attrs are
  // needed for pattern matching and will be removed in the next step.
  // These often appear as inline UI chips (e.g. "New", "Beta", "Pro") and get merged
  // into adjacent text without whitespace, producing false positives.
  $('span').each((_i, el) => {
    const $el = $(el)
    const cls = (el as any).attribs?.class || ''
    const text = $el.text().trim()
    if (text.length <= 30 && /badge|tag|label|chip|pill|status|tier|plan/i.test(cls)) {
      $el.replaceWith(`[Badge: ${text}]`)
    }
  })

  // Strip disallowed attributes from every element
  $('*').each((_i, el) => {
    if (el.type !== 'tag') return
    const attribs = (el as any).attribs || {}
    for (const attr of Object.keys(attribs)) {
      // Keep all aria-* (accessibility auditing)
      if (attr.startsWith('aria-')) continue
      // Keep whitelisted attributes
      if (KEEP_ATTRS.has(attr)) continue
      // Drop everything else (class, id, style, data-*, event handlers, etc.)
      $(el).removeAttr(attr)
    }

    // Strip data URI src values — base64 images are enormous and add no audit value.
    // Replace with a placeholder so the model still knows an image/resource exists.
    const src = (el as any).attribs?.src
    if (src && src.startsWith('data:')) {
      $(el).attr('src', '[data-uri]')
    }
  })

  // Unwrap inline formatting tags — keep text content, remove tag wrapper.
  // Insert a space when the preceding sibling is a text/element node with no trailing
  // whitespace, to avoid merging adjacent words (e.g. "ClickHere" instead of "Click Here").
  // Must run AFTER attribute stripping so aria-*/role detection on <span> still works.
  $(INLINE_FORMAT_TAGS.join(', ')).each((_i, el) => {
    const prev = el.prev
    if (prev && prev.type === 'text') {
      const prevText = (prev as any).data || ''
      if (prevText.length > 0 && !/\s$/.test(prevText)) {
        (prev as any).data = prevText + ' '
      }
    }
    $(el).replaceWith($(el).contents())
  })

  // Unwrap bare <span> elements — only keep spans that carry semantic meaning
  // via aria-* attributes, role, or inert (inert spans are inactive variants in
  // animated components like number-flow-react — unwrapping them loses the signal).
  $('span').each((_i, el) => {
    const attribs = (el as any).attribs || {}
    const hasAria = Object.keys(attribs).some(a => a.startsWith('aria-'))
    const hasRole = !!attribs.role
    const hasInert = 'inert' in attribs
    if (!hasAria && !hasRole && !hasInert) {
      // Insert space before unwrapping if previous sibling text has no trailing
      // whitespace — prevents adjacent spans merging into one word:
      // <span>Artificial</span><span>Intelligence</span> → "Artificial Intelligence"
      const prev = el.prev
      if (prev && prev.type === 'text') {
        const prevText = (prev as any).data || ''
        if (prevText.length > 0 && !/\s$/.test(prevText)) {
          (prev as any).data = prevText + ' '
        }
      }
      $(el).replaceWith($(el).contents())
    }
  })

  // Collapse empty and single-child divs — pure structural noise with no audit value.
  // Traverse in reverse DOM order (bottom-up) so children collapse before parents,
  // allowing grandparent divs to become eligible after their child divs are unwrapped.
  // Guard: skip divs with role or aria-* — those are semantic landmarks (role="main",
  // aria-label="navigation") and must not be unwrapped.
  const allDivs = $('div').toArray().reverse()
  for (const el of allDivs) {
    const $el = $(el)
    const attribs = (el as any).attribs || {}
    if (attribs.role) continue
    if (Object.keys(attribs).some(a => a.startsWith('aria-'))) continue
    const children = $el.children()
    // directText: any text node content not inside a child element
    const directText = $el.clone().children().remove().end().text().trim()
    if (children.length === 0 && !directText) {
      // Empty div — remove entirely
      $el.remove()
    } else if (children.length === 1 && !directText) {
      // Single child, no sibling text — unwrap the wrapper div
      $el.replaceWith($el.contents())
    }
  }

  // Serialise and clean up
  let compressed = $.html()

  // Remove any HTML comments cheerio might have retained
  compressed = compressed.replace(/<!--[\s\S]*?-->/g, '')

  // Collapse whitespace: newlines/tabs → single space, then trim.
  // We intentionally do NOT strip all whitespace between tags (the old >\s+< pattern)
  // because that merges adjacent inline elements: "<a>About</a> <a>Pricing</a>" →
  // "AboutPricing". Confirmed source of the dub.co "DubRead more" false positive.
  compressed = compressed
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '')

  return compressed
}

/**
 * Split compressed HTML at semantic boundaries (section/article children of main)
 * when a page is still too large after compression.
 *
 * Returns an array of self-contained HTML chunks, each under maxChars.
 * If the page fits in one chunk, the array has a single element.
 */
export function chunkHtml(html: string, maxChars: number): string[] {
  if (html.length <= maxChars) return [html]

  const $ = cheerio.load(html, { decodeEntities: false })

  // Collect top-level semantic children: direct children of main, or all sections/articles
  const candidates: string[] = []
  const $main = $('main')
  const $body = $('body')

  const $container = $main.length ? $main : $body
  $container.children().each((_i, el) => {
    candidates.push($.html(el))
  })

  if (candidates.length === 0) {
    // No semantic children found — fall back to character split at last tag boundary
    const cut = html.lastIndexOf('>', maxChars)
    return [html.substring(0, cut > 0 ? cut : maxChars) + '\n[Content truncated]']
  }

  // Greedily pack candidates into chunks
  const chunks: string[] = []
  let current = ''

  for (const candidate of candidates) {
    if (current.length + candidate.length > maxChars) {
      if (current) {
        chunks.push(current.trim())
        current = ''
      }
      // Single element larger than maxChars — include it as its own chunk (unavoidable)
      if (candidate.length > maxChars) {
        const cut = candidate.lastIndexOf('>', maxChars)
        chunks.push(candidate.substring(0, cut > 0 ? cut : maxChars) + '\n[Section truncated]')
        continue
      }
    }
    current += candidate
  }

  if (current.trim()) chunks.push(current.trim())

  return chunks.length > 0 ? chunks : [html.substring(0, maxChars)]
}

/**
 * Compress HTML and return all chunks as an array.
 * If the compressed page fits within limit, returns a single-element array.
 * If it exceeds limit, returns up to 2 chunks (hard cap — prevents runaway token growth).
 * The checker continues to use compressHtmlWithLogging (chunk 1 only) — cost stays flat.
 */
export function compressHtmlToChunks(html: string, pageUrl: string, limit = 60000): string[] {
  const rawLen = html.length
  const compressed = compressHtml(html)
  const reduction = rawLen > 0 ? Math.round((1 - compressed.length / rawLen) * 100) : 0
  Logger.info(`[HtmlCompressor] ${pageUrl}: ${rawLen} → ${compressed.length} chars (${reduction}% reduction)`)
  if (compressed.length <= limit) return [compressed]
  const chunks = chunkHtml(compressed, limit)
  Logger.info(`[HtmlCompressor] ${pageUrl}: chunked into ${chunks.length} sections`)
  return chunks.slice(0, 2) // hard cap: max 2 chunks to bound token growth
}

/**
 * Compress HTML, log the reduction ratio to LangSmith, and return the result.
 * If the compressed page still exceeds limit, applies DOM-aware chunking and
 * returns the concatenated chunks with section markers.
 */
export function compressHtmlWithLogging(html: string, pageUrl: string, limit = 60000): string {
  const rawLen = html.length
  const compressed = compressHtml(html)
  const reduction = rawLen > 0 ? Math.round((1 - compressed.length / rawLen) * 100) : 0
  Logger.info(`[HtmlCompressor] ${pageUrl}: ${rawLen} → ${compressed.length} chars (${reduction}% reduction)`)

  if (compressed.length <= limit) return compressed

  // DOM-aware chunking fallback for extremely large pages
  const chunks = chunkHtml(compressed, limit)
  if (chunks.length > 1) {
    Logger.info(`[HtmlCompressor] ${pageUrl}: chunked into ${chunks.length} sections (page still ${compressed.length} chars after compression)`)
  }
  // For now return only the first chunk — auditor has web_search for the rest.
  // Multi-chunk support (separate API call per chunk) is future work.
  return chunks[0]
}
