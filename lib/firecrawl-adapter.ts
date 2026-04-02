/**
 * Adapter to make Firecrawl output compatible with existing audit system
 * Implements Map → selectPagesToAudit → Scrape architecture for intelligent page selection
 */

import { mapWebsite, scrapePage, isFirecrawlAvailable, FirecrawlPage } from './firecrawl-client'
import { selectPagesToAudit } from './page-selector'
import { crawlLinks, type CrawlerIssue } from './link-crawler'
import * as cheerio from 'cheerio'
import Logger from './logger'
import { compressHtmlWithLogging, compressHtmlToChunks } from './html-compressor'

// Feature flag: use Playwright DOM extraction instead of HTML compress step.
// When enabled, Firecrawl still handles map + page selection; Playwright replaces
// the scrape + compress step only. Set USE_PLAYWRIGHT_EXTRACTION=true to enable.
export const USE_PLAYWRIGHT_EXTRACTION = process.env.USE_PLAYWRIGHT_EXTRACTION === 'true'

// Fallback to old method when Firecrawl unavailable
import {
  extractElementManifest,
  formatManifestForPrompt as formatManifestLegacy,
  countInternalPages,
  extractDiscoveredPagesList
} from './manifest-extractor'

/**
 * Strip script tags, HTML comments, and verbose SVGs from raw HTML before
 * feeding to the model. SVGs are collapsed to a placeholder preserving any
 * aria-label/role so the model still understands their purpose.
 */
export function stripHtmlNoise(html: string): string {
  let cleaned = html
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '')
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, '')
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '')
  cleaned = cleaned.replace(/<svg([^>]*)>[\s\S]*?<\/svg>/gi, (_match, attrs) => {
    const ariaLabel = attrs.match(/aria-label="([^"]*)"/)?.[1]
    const role = attrs.match(/role="([^"]*)"/)?.[1]
    if (ariaLabel) return `<svg aria-label="${ariaLabel}"/>`
    if (role) return `<svg role="${role}"/>`
    return '<svg/>'
  })
  return cleaned.trim()
}

export interface AuditManifest {
  pages: FirecrawlPage[]
  discoveredUrls: string[]
  pagesFound: number
  linkValidationIssues?: CrawlerIssue[]
}

/**
 * Extract hostname from domain string
 */
function extractDomainHostname(domain: string): string {
  try {
    const url = new URL(domain.startsWith('http') ? domain : `https://${domain}`)
    return url.hostname
  } catch {
    return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  }
}

/**
 * Filter and deduplicate URLs for an accurate page count.
 * Strips non-page resources (sitemaps, feeds, assets) and normalises
 * trailing slashes / query params to avoid inflated counts.
 */
function deduplicateAndFilterUrls(urls: (string | any)[]): string[] {
  // Non-page extensions and path patterns to exclude
  const EXCLUDE_EXTENSIONS = /\.(xml|json|rss|atom|txt|pdf|png|jpg|jpeg|gif|svg|ico|css|js|woff2?|ttf|eot|mp4|webm|zip|tar)$/i
  const EXCLUDE_PATHS = /\/(sitemap|feed|rss|api\/|_next\/|static\/|assets\/|crawled-sitemap)/i

  const seen = new Set<string>()

  for (const raw of urls) {
    const urlStr = typeof raw === 'string' ? raw : raw?.url
    if (!urlStr || typeof urlStr !== 'string') continue

    try {
      const parsed = new URL(urlStr)
      // Skip non-page resources
      if (EXCLUDE_EXTENSIONS.test(parsed.pathname)) continue
      if (EXCLUDE_PATHS.test(parsed.pathname)) continue

      // Normalise: strip trailing slash and query params for dedup
      const normalised = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`
      seen.add(normalised)
    } catch {
      continue
    }
  }

  return Array.from(seen)
}

/**
 * Fallback: Use legacy manifest extractor when Firecrawl unavailable
 */
async function extractWithLegacyManifest(
  domain: string,
  tier: 'FREE' | 'PAID',
  includeLongform: boolean
): Promise<AuditManifest> {
  Logger.info('[Fallback] Using legacy manifest-extractor')

  // Ensure domain has protocol
  const normalizedDomain = domain.startsWith('http') ? domain : `https://${domain}`
  const manifests = await extractElementManifest(normalizedDomain)
  const discoveredUrls = extractDiscoveredPagesList(manifests)
  const domainHostname = extractDomainHostname(domain)

  // Apply same intelligent selection
  const selectedUrls = await selectPagesToAudit(
    discoveredUrls,
    domainHostname,
    tier,
    includeLongform
  )

  // Convert legacy manifests to Firecrawl-style pages
  const pages: FirecrawlPage[] = manifests
    .filter(m => selectedUrls.includes(m.page_url))
    .map(m => {
      // Convert links to markdown format for link crawler
      const markdownLinks = m.links
        .map(link => `[${link.text}](${link.href})`)
        .join('\n')

      return {
        url: m.page_url,
        markdown: formatManifestLegacy([m]) + '\n\n' + markdownLinks,
        metadata: {
          title: m.headings[0]?.text || undefined
        }
      }
    })

  // Run link crawler even in fallback mode (uses hybrid approach)
  Logger.debug(`[Fallback] Running link crawler on ${pages.length} pages...`)
  const linkValidationIssues = await crawlLinks(pages, domain, {
    concurrency: tier === 'FREE' ? 3 : 5,
    checkExternal: false, // Disabled: external sites use bot protection (403 errors)
    maxLinks: tier === 'FREE' ? 50 : 200,
    timeoutMs: 8000,
    auditedUrls: pages.map(p => p.url) // Only check links to audited pages
  })
  Logger.info(`[LinkCrawler] Found ${linkValidationIssues.length} link issues`)

  return {
    pages,
    discoveredUrls,
    pagesFound: countInternalPages(manifests),
    linkValidationIssues
  }
}

/**
 * Extract content using Firecrawl with intelligent page selection
 * Architecture: Map (discover) → selectPagesToAudit (intelligence) → Scrape (parallel)
 * Falls back to manifest-extractor if Firecrawl API key not configured
 */
export async function extractWithFirecrawl(
  domain: string,
  tier: 'FREE' | 'PAID' = 'FREE',
  includeLongform: boolean = false
): Promise<AuditManifest> {
  // Fallback to legacy method if Firecrawl not available
  if (!isFirecrawlAvailable()) {
    Logger.warn('[Firecrawl] API key not configured, falling back to manifest-extractor')
    return extractWithLegacyManifest(domain, tier, includeLongform)
  }

  const limit = tier === 'FREE' ? 6 : 20

  try {
    // Phase 1: Map - Discover all URLs on the site
    Logger.debug(`[Firecrawl] Phase 1: Mapping URLs from ${domain}...`)
    const mapResults = await mapWebsite(domain)
    // Extract URL strings from map results (Firecrawl returns {url, title, description})
    let allUrls: string[] = mapResults.map(r => typeof r === 'string' ? r : (r.url || String(r)))
    Logger.debug(`[Firecrawl] Map discovered ${allUrls.length} URLs`)

    // SPA fallback: if map found very few URLs, scrape the homepage to
    // discover links. Map does a lightweight fetch that misses client-rendered
    // content; scrape runs a real browser and sees everything.
    const MIN_MAP_URLS = 5
    if (allUrls.length < MIN_MAP_URLS) {
      Logger.info(`[Firecrawl] Map returned only ${allUrls.length} URLs — scraping homepage for SPA link discovery`)
      const normalizedDomain = domain.startsWith('http') ? domain : `https://${domain}`
      try {
        const homePage = await scrapePage(normalizedDomain)
        const homeLinks = (homePage.links || []).filter(link => {
          // Only keep internal links on the same domain
          try {
            const linkHost = new URL(link).hostname
            const domainHost = extractDomainHostname(domain)
            return linkHost === domainHost || linkHost === `www.${domainHost}` || `www.${linkHost}` === domainHost
          } catch { return false }
        })
        // Merge with map results, deduplicate
        const urlSet = new Set([...allUrls, ...homeLinks])
        allUrls = Array.from(urlSet)
        Logger.info(`[Firecrawl] SPA fallback added ${homeLinks.length} links from homepage (${allUrls.length} total URLs)`)
      } catch (err) {
        Logger.warn('[Firecrawl] SPA fallback homepage scrape failed:', err)
      }
    }

    // Phase 2: Smart Selection - Use our intelligent page selector
    const domainHostname = extractDomainHostname(domain)
    const selectedUrls = await selectPagesToAudit(
      allUrls,
      domainHostname,
      tier,
      includeLongform
    )
    Logger.debug(`[Firecrawl] Selected ${selectedUrls.length}/${allUrls.length} pages for audit`)

    // Phase 3: Parallel Scrape - Fetch content for selected pages
    Logger.debug(`[Firecrawl] Phase 3: Scraping ${selectedUrls.length} selected pages...`)
    const scrapePromises = selectedUrls.map(url =>
      scrapePage(url).catch(err => {
        Logger.warn(`[Firecrawl] Failed to scrape ${url}:`, err)
        return null
      })
    )
    const scrapeResults = await Promise.all(scrapePromises)
    const pages = scrapeResults.filter((p): p is FirecrawlPage => p !== null)

    Logger.info(`[Firecrawl] Successfully scraped ${pages.length}/${selectedUrls.length} pages (discovered ${allUrls.length} total URLs)`)

    // Phase 4: HTTP Link Crawler - Check links via actual HTTP requests
    Logger.debug(`[Firecrawl] Phase 4: Crawling links from scraped pages...`)
    const linkValidationIssues = await crawlLinks(pages, domain, {
      concurrency: tier === 'FREE' ? 3 : 5,
      checkExternal: false, // Disabled: external sites use bot protection (403 errors)
      maxLinks: tier === 'FREE' ? 50 : 200,
      timeoutMs: 8000,
      auditedUrls: pages.map(p => p.url) // Only check links to audited pages
    })
    Logger.info(`[LinkCrawler] Found ${linkValidationIssues.length} link issues`)

    // Count unique pages, excluding non-page URLs (sitemaps, feeds, etc.)
    const uniquePageUrls = deduplicateAndFilterUrls(allUrls)

    return {
      pages,
      discoveredUrls: allUrls, // Already extracted as strings above
      pagesFound: uniquePageUrls.length,
      linkValidationIssues
    }
  } catch (error) {
    Logger.error('[Firecrawl] Extraction failed', error instanceof Error ? error : undefined)

    // Fallback to legacy if Firecrawl fails (e.g., out of credits, network error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('Insufficient credits') || errorMessage.includes('credit')) {
      Logger.warn('[Firecrawl] Out of credits, falling back to manifest-extractor')
      return extractWithLegacyManifest(domain, tier, includeLongform)
    }

    throw error
  }
}

/**
 * Deduplicate responsive text from elements that have separate desktop/mobile
 * child spans with identical content (e.g. ctaText + ctaTextMobile).
 * Cheerio's .text() concatenates all children, producing "Talk to an ExpertTalk to an Expert".
 */
function deduplicateElementText($el: ReturnType<cheerio.CheerioAPI>, $: cheerio.CheerioAPI): string {
  const raw = $el.text().trim()
  if (!raw) return ''

  // Collect unique text from direct text-bearing children
  const childTexts: string[] = []
  $el.children().each((_i: number, child: any) => {
    const t = $(child).text().trim()
    if (t) childTexts.push(t)
  })

  // If children have duplicate texts (responsive variants), deduplicate
  if (childTexts.length >= 2) {
    const unique = [...new Set(childTexts)]
    if (unique.length < childTexts.length) {
      return unique.join(' ').substring(0, 80)
    }
  }

  // Fallback heuristic: if the string is its own first half repeated, take the first half
  // Handles cases where children are nested deeper than direct children
  if (raw.length >= 4 && raw.length % 2 === 0) {
    const half = raw.length / 2
    if (raw.substring(0, half) === raw.substring(half)) {
      return raw.substring(0, half).substring(0, 80)
    }
  }

  return raw.substring(0, 80)
}

/**
 * Extract a lightweight element manifest from Firecrawl HTML.
 * Lists interactive elements (links, buttons) with attributes so models
 * can cross-reference what's actually on the page vs what markdown shows.
 */
function extractElementManifestFromHtml(html: string, pageUrl: string): string {
  const $ = cheerio.load(html)

  // Strip hidden elements at the Cheerio level as a safety net
  // (the browser-side script may miss some CSS-hidden responsive variants)
  $('[aria-hidden="true"], .sr-only, .visually-hidden').remove()
  $('[style*="display:none"], [style*="display: none"], [style*="visibility:hidden"], [style*="visibility: hidden"]').remove()

  const lines: string[] = []

  // Extract links with href and text
  const links: string[] = []
  $('a[href]').each((_i, el) => {
    const $el = $(el)
    const href = $el.attr('href') || ''
    const text = deduplicateElementText($el, $)
    if (!text && !href) return

    // Classify link type
    let type = 'internal'
    if (href.startsWith('mailto:')) type = 'mailto'
    else if (href.startsWith('tel:')) type = 'tel'
    else if (href.startsWith('http') && !href.includes(new URL(pageUrl).hostname)) type = 'external'
    else if (href.startsWith('#')) type = 'anchor'
    else if (href.startsWith('javascript:')) type = 'javascript'

    links.push(`- "${text || '[no text]'}" → ${href} (${type})`)
  })

  if (links.length > 0) {
    lines.push(`### Links (${links.length})`)
    // Cap at 50 to avoid token bloat
    lines.push(...links.slice(0, 50))
    if (links.length > 50) lines.push(`... and ${links.length - 50} more`)
  }

  // Extract buttons
  const buttons: string[] = []
  $('button, [role="button"], input[type="submit"], input[type="button"]').each((_i, el) => {
    const $el = $(el)
    const text = deduplicateElementText($el, $) || $el.attr('value') || ''
    const onclick = $el.attr('onclick') ? ' (has onclick)' : ''
    if (text) buttons.push(`- "${text}"${onclick}`)
  })

  if (buttons.length > 0) {
    lines.push(`### Buttons (${buttons.length})`)
    lines.push(...buttons.slice(0, 30))
  }

  // Extract interactive widgets (chat, modals, etc.)
  const widgets: string[] = []
  $('[data-chat], [class*="chat"], [id*="chat"], [class*="intercom"], [id*="intercom"], [class*="crisp"], [id*="crisp"], [class*="drift"], [id*="drift"], [class*="widget"], [class*="modal"]').each((_i, el) => {
    const $el = $(el)
    const tag = el.type === 'tag' ? (el as any).tagName || 'unknown' : 'unknown'
    const id = $el.attr('id') || ''
    const classes = ($el.attr('class') || '').substring(0, 60)
    widgets.push(`- <${tag}> id="${id}" class="${classes}"`)
  })

  if (widgets.length > 0) {
    lines.push(`### Interactive Widgets (${widgets.length})`)
    lines.push(...widgets.slice(0, 10))
  }

  return lines.join('\n')
}

/**
 * Extract structured visible text from a rendered page using Playwright.
 * Returns a formatted string of {tag, text, href, section} tuples.
 * Only used when USE_PLAYWRIGHT_EXTRACTION=true.
 */
export async function extractRenderedTextForUrl(url: string): Promise<string> {
  // Dynamic import to avoid loading Playwright unless needed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = require('/home/ubuntu/.openclaw/tools/browser/node_modules/playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(2000)

    const elements: Array<{ tag: string; text: string; href?: string; section?: string }> = await page.evaluate(() => {
      const results: Array<{ tag: string; text: string; href?: string; section?: string }> = []
      const seen = new Set<string>()
      const SEMANTIC_TAGS = new Set([
        'h1','h2','h3','h4','h5','h6',
        'p','li','td','th','caption',
        'a','button','label','legend',
        'blockquote','figcaption','summary','dt','dd',
        'section','article','nav','header','footer','main','aside'
      ])

      function getNearestSection(node: Element): string {
        let el: Element | null = node
        while (el && el !== document.body) {
          const tag = el.tagName?.toLowerCase()
          if (['nav','header','footer','main','aside','section','article'].includes(tag)) {
            return el.getAttribute('aria-label') || el.id || tag
          }
          el = el.parentElement
        }
        return ''
      }

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node: Element) => {
            const style = window.getComputedStyle(node)
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return NodeFilter.FILTER_REJECT
            }
            if ((node as HTMLElement).offsetHeight === 0 && (node as HTMLElement).offsetWidth === 0) {
              return NodeFilter.FILTER_REJECT
            }
            if (style.position === 'absolute' && style.overflow === 'hidden' &&
                (node as HTMLElement).offsetWidth <= 1 && (node as HTMLElement).offsetHeight <= 1) {
              return NodeFilter.FILTER_REJECT
            }
            const cls = ((node as HTMLElement).className || '').toString().toLowerCase()
            if (/\b(sr-only|visually-hidden|screen-reader-text|clip-hidden)\b/.test(cls)) {
              return NodeFilter.FILTER_REJECT
            }
            const tag = node.tagName.toLowerCase()
            if (['script','style','svg','noscript','iframe','video','audio','canvas','img'].includes(tag)) {
              return NodeFilter.FILTER_REJECT
            }
            return NodeFilter.FILTER_ACCEPT
          }
        } as TreeWalker as any
      )

      let node: Node | null = walker.currentNode
      while (node) {
        const el = node as Element
        const tag = el.tagName?.toLowerCase()
        if (tag && SEMANTIC_TAGS.has(tag)) {
          const isContainer = ['section','article','nav','header','footer','main','aside'].includes(tag)
          let text = ''
          if (isContainer) {
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent || ''
              }
            }
            text = text.trim()
          } else {
            text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() || ''
          }

          if (text.length > 2) {
            const key = `${tag}:${text}`
            if (!seen.has(key)) {
              seen.add(key)
              const entry: { tag: string; text: string; href?: string; section?: string } = { tag, text }
              if (tag === 'a') {
                entry.href = (el as HTMLAnchorElement).href || undefined
              }
              const section = getNearestSection(el)
              if (section) entry.section = section
              results.push(entry)
            }
          }
        }
        node = walker.nextNode()
      }
      return results
    })

    let output = `# Page: ${url}\n\n`
    let currentSection = ''
    for (const el of elements) {
      if (el.section && el.section !== currentSection) {
        currentSection = el.section
        output += `\n--- ${currentSection} ---\n`
      }
      const tagLabel = el.tag.toUpperCase()
      if (el.tag === 'a') {
        output += `[${tagLabel}] ${el.text} -> ${el.href || ''}\n`
      } else {
        output += `[${tagLabel}] ${el.text}\n`
      }
    }
    return output
  } finally {
    await browser.close()
  }
}

/**
 * Format Firecrawl pages for audit prompts (replaces formatManifestForPrompt).
 * Includes both markdown content AND a structured element manifest from HTML.
 * When USE_PLAYWRIGHT_EXTRACTION=true, replaces the HTML compress step with
 * Playwright DOM extraction for cleaner, lower-token input.
 */
export function formatFirecrawlForPrompt(manifest: AuditManifest): string {
  const { pages } = manifest

  if (pages.length === 0) {
    return '# WEBSITE CONTENT\n\nNo content available (extraction failed).\n'
  }

  let output = '# WEBSITE CONTENT\n\n'
  output += `Extracted from ${pages.length} pages using Firecrawl (bot-protected crawling).\n\n`

  // Nav/footer dedup: fingerprint shared structural blocks across pages.
  // On page 2+, a nav/header/footer with identical text to one already seen is
  // replaced with a placeholder to avoid burning tokens on repeated chrome.
  // 300-char fingerprint: a single word difference (e.g. CTA change) prevents false dedup.
  const seenBlocks = new Set<string>()

  pages.forEach((page, index) => {
    output += `## Page ${index + 1}: ${page.url}\n\n`

    if (page.metadata?.title) {
      output += `**Title:** ${page.metadata.title}\n\n`
    }

    if (page.metadata?.description) {
      output += `**Description:** ${page.metadata.description}\n\n`
    }

    if (USE_PLAYWRIGHT_EXTRACTION && page.renderedText) {
      // Playwright path: use pre-extracted structured DOM text instead of compressed HTML.
      // CSS-resolved, JS-rendered, hidden elements already stripped.
      output += `**Content (Playwright DOM):**\n${page.renderedText}\n\n`
    } else if (page.html) {
      // Pipeline: stripHtmlNoise → compressHtmlToChunks (up to 2 × 60K chunks).
      // Dedup nav/header/footer before inserting into prompt so repeated chrome
      // doesn't burn tokens on page 2+. Element manifest still runs on raw HTML (unaffected).
      const chunks = compressHtmlToChunks(stripHtmlNoise(page.html), page.url)

      // Deduplicate shared structural blocks (nav, header, footer) across pages.
      // Fingerprint includes text + href values so a nav with the same text but different
      // links (e.g. localized navs) is NOT treated as a duplicate.
      const $c = cheerio.load(chunks.join(''), { decodeEntities: false })
      for (const tag of ['nav', 'header', 'footer'] as const) {
        $c(tag).each((_i, el) => {
          const text = $c(el).text().replace(/\s+/g, ' ').trim()
          const hrefs = $c(el).find('a[href]').map((_i2, a) => $c(a).attr('href') || '').toArray()
          const fp = `${tag}:${text.slice(0, 200)}:${hrefs.slice(0, 5).join(',')}`
          if (seenBlocks.has(fp)) {
            $c(el).replaceWith(`<${tag}>[Same as Page 1]</${tag}>`)
          } else {
            seenBlocks.add(fp)
          }
        })
      }
      const dedupedHtml = $c.html()

      // Re-split at the original chunk boundaries after dedup (best-effort).
      // For a single chunk, this is a no-op. For 2 chunks, dedup shrinks the combined
      // HTML so we output it as-is (still within token budget for the auditor).
      if (chunks.length === 1) {
        output += `**Content (HTML):**\n${dedupedHtml}\n\n`
      } else {
        // Distribute deduped content back into two labelled parts for model clarity
        const mid = Math.ceil(dedupedHtml.length / 2)
        const boundary = dedupedHtml.lastIndexOf('>', mid)
        const split = boundary > 0 ? boundary + 1 : mid
        output += `**Content (HTML, part 1 of 2):**\n${dedupedHtml.slice(0, split)}\n\n`
        output += `**Content (HTML, part 2 of 2):**\n${dedupedHtml.slice(split)}\n\n`
      }
    }

    // Append element manifest from HTML if available.
    // Uses raw (pre-compression) HTML — element manifest must not be deduplicated
    // because nav links may differ per page even when text looks the same.
    if (page.html) {
      const elementManifest = extractElementManifestFromHtml(page.html, page.url)
      if (elementManifest) {
        output += `**Element Manifest (from HTML):**\n${elementManifest}\n\n`
      }
    }

    output += '---\n\n'
  })

  return output
}

/**
 * Format only the pages that have issues for the checker pass.
 * Gives the checker the same cleaned HTML + element manifest the auditor saw,
 * but scoped to just the pages relevant to the current category — same
 * stripHtmlNoise + 14k truncation as formatFirecrawlForPrompt.
 */
export function formatPagesForChecker(
  manifest: AuditManifest,
  pageUrls: Set<string>
): string {
  const pages = manifest.pages.filter(p => pageUrls.has(p.url))
  if (pages.length === 0) return '[No HTML available for any issue page]'

  let output = ''
  for (const page of pages) {
    output += `## Page: ${page.url}\n\n`
    if (page.html) {
      // Use compressHtmlToChunks so both chunks are included for checker verification.
      // Previously only chunk 1 was sent (compressHtmlWithLogging), causing the checker
      // to miss issues in the second half of long pages.
      const chunks = compressHtmlToChunks(stripHtmlNoise(page.html), page.url)
      if (chunks.length === 1) {
        output += `${chunks[0]}\n\n`
      } else {
        output += `**part 1 of 2:**\n${chunks[0]}\n\n`
        output += `**part 2 of 2:**\n${chunks[1]}\n\n`
      }
    }
    output += '---\n\n'
  }
  return output
}


/**
 * Get audited URLs from manifest
 */
export function getAuditedUrls(manifest: AuditManifest): string[] {
  return manifest.pages.map(p => p.url)
}

/**
 * Count pages found (replaces countInternalPages)
 */
export function countPagesFound(manifest: AuditManifest): number {
  return manifest.pagesFound
}

/**
 * Get discovered pages list (replaces extractDiscoveredPagesList)
 */
export function getDiscoveredPages(manifest: AuditManifest): string[] {
  return manifest.discoveredUrls
}
