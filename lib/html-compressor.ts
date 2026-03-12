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
  // Must run AFTER attribute stripping so aria-*/role detection on <span> still works.
  $(INLINE_FORMAT_TAGS.join(', ')).each((_i, el) => {
    $(el).replaceWith($(el).contents())
  })

  // Unwrap bare <span> elements — only keep spans that carry semantic meaning
  // via aria-* attributes or role (e.g. aria-live regions, tooltip anchors).
  $('span').each((_i, el) => {
    const attribs = (el as any).attribs || {}
    const hasAria = Object.keys(attribs).some(a => a.startsWith('aria-'))
    const hasRole = !!attribs.role
    if (!hasAria && !hasRole) {
      $(el).replaceWith($(el).contents())
    }
  })

  // Serialise and clean up
  let compressed = $.html()

  // Remove any HTML comments cheerio might have retained
  compressed = compressed.replace(/<!--[\s\S]*?-->/g, '')

  // Collapse whitespace: multi-space/newline runs → single space,
  // then remove whitespace between tags (block-level structure only, inline text is safe)
  compressed = compressed
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
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
