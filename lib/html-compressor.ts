/**
 * Semantic HTML compressor.
 *
 * Strips everything GPT-5.1 doesn't need for content auditing:
 *   - class, id, style, data-* attributes (80%+ of a Tailwind page's attribute bloat)
 *   - <script>, <style>, <noscript> tags entirely
 *   - HTML comments
 *   - Inline SVG content → <svg/> placeholder (preserving aria-label if present)
 *   - Collapsed/redundant whitespace
 *
 * Preserves:
 *   - All semantic HTML structure (nav, main, section, h1-h6, p, ul, etc.)
 *   - Text content
 *   - href, src, alt, title, type, role, for, name, target, lang, rel
 *   - All aria-* attributes (accessibility auditing)
 *
 * Result: a 200K char page typically compresses to 40-70K chars (60-80% reduction).
 * This is applied AFTER stripHtmlNoise and BEFORE the model prompt — the element
 * manifest in firecrawl-adapter.ts continues to use the raw (pre-compression) HTML.
 */

import * as cheerio from 'cheerio'

// Attributes to keep — everything needed for content + accessibility auditing
const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'type', 'role', 'for', 'htmlfor', 'name',
  'target', 'lang', 'rel', 'action', 'method', 'value', 'placeholder',
  'colspan', 'rowspan', 'scope', 'headers',
])

/**
 * Compress HTML to semantic-only form for model consumption.
 *
 * @param html - Raw or stripped HTML string
 * @returns Compressed HTML with only semantic structure, text, and key attributes
 */
export function compressHtml(html: string): string {
  const $ = cheerio.load(html, { decodeEntities: false })

  // Remove non-content tags entirely
  $('script, style, noscript, template').remove()
  $('head').remove()

  // Collapse inline SVGs to placeholder (same logic as stripHtmlNoise but comprehensive)
  $('svg').each((_i, el) => {
    const $el = $(el)
    const ariaLabel = $el.attr('aria-label')
    const role = $el.attr('role')
    // Replace with minimal placeholder
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
      // Keep aria-* attributes (all of them)
      if (attr.startsWith('aria-')) continue
      // Keep explicitly whitelisted attributes
      if (KEEP_ATTRS.has(attr)) continue
      // Drop everything else (class, id, style, data-*, event handlers, etc.)
      $(el).removeAttr(attr)
    }
  })

  // Collapse whitespace: normalise all runs of whitespace to single spaces
  // We do this on the serialised output (cheerio doesn't do this in-place)
  let compressed = $.html()

  // Remove HTML comment nodes that cheerio might have kept
  compressed = compressed.replace(/<!--[\s\S]*?-->/g, '')

  // Collapse runs of whitespace (spaces, tabs, newlines) between tags to single space
  compressed = compressed
    .replace(/\s{2,}/g, ' ')       // collapse multiple spaces/newlines
    .replace(/>\s+</g, '><')       // remove whitespace between tags (keeps structure tight)
    .replace(/^\s+|\s+$/g, '')     // trim

  return compressed
}

/**
 * Compress HTML and log the reduction ratio for observability.
 *
 * @param html - Raw HTML
 * @param pageUrl - Used in log message only
 * @returns Compressed HTML
 */
export function compressHtmlWithLogging(html: string, pageUrl: string): string {
  const raw = html.length
  const compressed = compressHtml(html)
  const reduction = raw > 0 ? Math.round((1 - compressed.length / raw) * 100) : 0
  // Use console.log here so this shows in LangSmith traces without importing Logger
  console.log(`[HtmlCompressor] ${pageUrl}: ${raw} → ${compressed.length} chars (${reduction}% reduction)`)
  return compressed
}
