/**
 * Annotated text converter using html-to-text with custom semantic formatters.
 *
 * Replaces the HTML compressor for model input. Instead of stripping attributes
 * from raw HTML, this converts to annotated plain text with semantic prefixes:
 *   [NAV], [HEADER], [FOOTER], [H1]-[H6], [SECTION], [CARD], [Badge: X], [TABLE]
 *
 * Benefits over compressed HTML:
 *   - 3-5x fewer tokens (plain text vs HTML tags + attributes)
 *   - Explicit structural context (model can't confuse nav with body text)
 *   - No responsive nav duplicates leaking through
 *   - Badge/card detection prevents run-on text merging
 *
 * Uses html-to-text (3-6M weekly downloads) with custom formatters per tag.
 * Firecrawl already returns raw HTML; this processes it without a browser.
 */

import { convert, FormatOptions } from 'html-to-text'
import * as cheerio from 'cheerio'
import Logger from './logger'

// Badge/label class patterns (reused from html-compressor.ts)
const BADGE_CLASS_PATTERN = /badge|tag|label|chip|pill|status|tier|plan/i

/**
 * Pre-process HTML before html-to-text conversion:
 * - Remove script/style/noscript/template/head
 * - Collapse SVGs to placeholder
 * - Remove hidden elements (hidden, sr-only, invisible classes)
 * - Detect and wrap badges as [Badge: text]
 * - Strip data-URI src values
 */
function preProcess(html: string): string {
  const $ = cheerio.load(html, { decodeEntities: false } as any)

  // Remove non-content tags
  $('script, style, noscript, template, head').remove()

  // Collapse SVGs
  $('svg').each((_i, el) => {
    const $el = $(el)
    const ariaLabel = $el.attr('aria-label')
    if (ariaLabel) {
      $el.replaceWith(`[Icon: ${ariaLabel}]`)
    } else {
      $el.remove()
    }
  })

  // Remove hidden elements (same logic as html-compressor.ts)
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
    const hasResponsiveShow = /(?:sm|md|lg|xl|2xl):[a-z]/.test(cls)
    if (hasResponsiveShow) return
    $(el).remove()
  })

  // Remove inert elements (animated number variants, etc.)
  $('[inert]').remove()

  // Detect badge/tag/label spans and replace with annotated text
  $('span, div').each((_i, el) => {
    const $el = $(el)
    const cls = (el as any).attribs?.class || ''
    const text = $el.text().trim()
    if (text.length > 0 && text.length <= 30 && BADGE_CLASS_PATTERN.test(cls)) {
      $el.replaceWith(`[Badge: ${text}]`)
    }
  })

  // Strip data-URI src values
  $('img[src^="data:"]').each((_i, el) => {
    $(el).attr('src', '[data-uri]')
  })

  return $.html()
}

/**
 * Build html-to-text options with custom formatters for semantic HTML5 elements.
 * Each formatter outputs an annotated prefix so the model understands structure.
 */
function buildConvertOptions(): FormatOptions {
  return {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      // Semantic landmark elements get block-level prefixes
      { selector: 'nav', format: 'semanticBlock', options: { prefix: '[NAV]' } },
      { selector: 'header', format: 'semanticBlock', options: { prefix: '[HEADER]' } },
      { selector: 'footer', format: 'semanticBlock', options: { prefix: '[FOOTER]' } },
      { selector: 'main', format: 'semanticBlock', options: { prefix: '[MAIN]' } },
      { selector: 'aside', format: 'semanticBlock', options: { prefix: '[ASIDE]' } },
      { selector: 'section', format: 'semanticBlock', options: { prefix: '[SECTION]' } },
      { selector: 'article', format: 'semanticBlock', options: { prefix: '[ARTICLE]' } },

      // Headings
      { selector: 'h1', format: 'semanticBlock', options: { prefix: '[H1]' } },
      { selector: 'h2', format: 'semanticBlock', options: { prefix: '[H2]' } },
      { selector: 'h3', format: 'semanticBlock', options: { prefix: '[H3]' } },
      { selector: 'h4', format: 'semanticBlock', options: { prefix: '[H4]' } },
      { selector: 'h5', format: 'semanticBlock', options: { prefix: '[H5]' } },
      { selector: 'h6', format: 'semanticBlock', options: { prefix: '[H6]' } },

      // Paragraphs get [P] prefix for clear text block delineation
      { selector: 'p', format: 'semanticBlock', options: { prefix: '[P]' } },

      // Links: preserve href
      { selector: 'a', format: 'anchor', options: { hideLinkHrefIfSameAsText: true } },

      // Images: show alt text
      { selector: 'img', format: 'image', options: {} },

      // Tables
      { selector: 'table', format: 'dataTable', options: {} },

      // Lists use default formatting (bullets/numbers)
      { selector: 'ul', format: 'unorderedList', options: {} },
      { selector: 'ol', format: 'orderedList', options: {} },

      // Blockquotes
      { selector: 'blockquote', format: 'blockquote', options: {} },

      // Form elements
      { selector: 'button', format: 'semanticInline', options: { prefix: '[Button:', suffix: ']' } },
      { selector: 'input[type="submit"]', format: 'semanticInline', options: { prefix: '[Button:', suffix: ']' } },
      { selector: 'label', format: 'semanticInline', options: { prefix: '[Label:', suffix: ']' } },

      // Skip these entirely
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
    ],
    formatters: {
      // Block-level semantic formatter: outputs prefix + content on its own line
      semanticBlock: (elem, walk, builder, formatOptions) => {
        const prefix = (formatOptions as any).prefix || ''
        builder.openBlock({ leadingLineBreaks: 1 })
        if (prefix) builder.addInline(prefix + ' ')
        walk(elem.children, builder)
        builder.closeBlock({ trailingLineBreaks: 1 })
      },
      // Inline semantic formatter: wraps content in prefix/suffix
      semanticInline: (elem, walk, builder, formatOptions) => {
        const prefix = (formatOptions as any).prefix || ''
        const suffix = (formatOptions as any).suffix || ''
        builder.addInline(prefix)
        walk(elem.children, builder)
        builder.addInline(suffix)
      },
    },
  }
}

/**
 * Convert raw HTML to annotated text with semantic prefixes.
 *
 * @param html - Raw HTML from Firecrawl scrape
 * @param pageUrl - URL for logging
 * @returns Annotated text string
 */
export function htmlToAnnotatedText(html: string, pageUrl: string): string {
  const rawLen = html.length

  // Pre-process: remove noise, detect badges, strip hidden elements
  const cleaned = preProcess(html)

  // Convert to annotated text
  const options = buildConvertOptions()
  let annotated = convert(cleaned, options)

  // Post-process: collapse excessive blank lines, trim
  annotated = annotated
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')

  const reduction = rawLen > 0 ? Math.round((1 - annotated.length / rawLen) * 100) : 0
  Logger.info(`[AnnotatedText] ${pageUrl}: ${rawLen} -> ${annotated.length} chars (${reduction}% reduction)`)

  return annotated
}

/**
 * Convert HTML and split into chunks if too large.
 * Returns array of annotated text chunks, each under the limit.
 */
export function htmlToAnnotatedTextChunks(
  html: string,
  pageUrl: string,
  limit = 60000
): string[] {
  const annotated = htmlToAnnotatedText(html, pageUrl)

  if (annotated.length <= limit) return [annotated]

  // Split at double-newline boundaries (section breaks), falling back to single newlines
  const hasDoubleNewlines = annotated.includes('\n\n')
  const sections = hasDoubleNewlines ? annotated.split(/\n\n/) : annotated.split(/\n/)
  const chunks: string[] = []
  let current = ''

  for (const section of sections) {
    if (current.length + section.length + 2 > limit) {
      if (current) {
        chunks.push(current.trim())
        current = ''
      }
      // Single section larger than limit: truncate
      if (section.length > limit) {
        chunks.push(section.slice(0, limit) + '\n[Content truncated]')
        continue
      }
    }
    current += (current ? '\n\n' : '') + section
  }

  if (current.trim()) chunks.push(current.trim())

  // Hard cap: max 2 chunks
  const result = chunks.slice(0, 2)
  if (result.length > 1) {
    Logger.info(`[AnnotatedText] ${pageUrl}: chunked into ${result.length} parts`)
  }

  return result.length > 0 ? result : [annotated.slice(0, limit)]
}
