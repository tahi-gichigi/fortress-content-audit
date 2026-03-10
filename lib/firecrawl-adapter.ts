/**
 * Adapter to make Firecrawl output compatible with existing audit system
 * Implements Map → selectPagesToAudit → Scrape architecture for intelligent page selection
 */

import { mapWebsite, scrapePage, isFirecrawlAvailable, FirecrawlPage } from './firecrawl-client'
import { selectPagesToAudit } from './page-selector'
import { crawlLinks, type CrawlerIssue } from './link-crawler'
import * as cheerio from 'cheerio'
import Logger from './logger'

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
function stripHtmlNoise(html: string): string {
  let cleaned = html
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '')
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
 * Format Firecrawl pages for audit prompts (replaces formatManifestForPrompt).
 * Includes both markdown content AND a structured element manifest from HTML.
 */
export function formatFirecrawlForPrompt(manifest: AuditManifest): string {
  const { pages } = manifest

  if (pages.length === 0) {
    return '# WEBSITE CONTENT\n\nNo content available (extraction failed).\n'
  }

  let output = '# WEBSITE CONTENT\n\n'
  output += `Extracted from ${pages.length} pages using Firecrawl (bot-protected crawling).\n\n`

  pages.forEach((page, index) => {
    output += `## Page ${index + 1}: ${page.url}\n\n`

    if (page.metadata?.title) {
      output += `**Title:** ${page.metadata.title}\n\n`
    }

    if (page.metadata?.description) {
      output += `**Description:** ${page.metadata.description}\n\n`
    }

    if (page.html) {
      // Use cleaned HTML directly — more accurate than markdown (no lossy conversion,
      // preserves <br>, inline spans, heading levels). stripHtmlNoise removes scripts,
      // comments, and verbose SVGs to reduce token count without losing content.
      const cleanedHtml = stripHtmlNoise(page.html)
      let contentPreview = cleanedHtml
      if (cleanedHtml.length > 14000) {
        // Cut at last '>' to avoid truncating inside a tag attribute or element
        const cutPoint = cleanedHtml.lastIndexOf('>', 14000)
        contentPreview = cleanedHtml.substring(0, cutPoint > 0 ? cutPoint : 14000)
          + '\n\n[Content truncated due to length — do not flag truncation as an issue]'
      }
      output += `**Content (HTML):**\n${contentPreview}\n\n`
    }

    // Append element manifest from HTML if available
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
 * Format Firecrawl pages for audit prompts using markdown content.
 * Used by the two-pass test to compare HTML vs markdown audit input.
 */
export function formatFirecrawlForPromptMarkdown(manifest: AuditManifest): string {
  const { pages } = manifest

  if (pages.length === 0) {
    return '# WEBSITE CONTENT\n\nNo content available (extraction failed).\n'
  }

  let output = '# WEBSITE CONTENT\n\n'
  output += `Extracted from ${pages.length} pages using Firecrawl (bot-protected crawling).\n\n`

  pages.forEach((page, index) => {
    output += `## Page ${index + 1}: ${page.url}\n\n`

    if (page.metadata?.title) {
      output += `**Title:** ${page.metadata.title}\n\n`
    }

    if (page.metadata?.description) {
      output += `**Description:** ${page.metadata.description}\n\n`
    }

    if (page.markdown) {
      let content = page.markdown
      if (content.length > 14000) {
        content = content.substring(0, 14000)
          + '\n\n[Content truncated due to length — do not flag truncation as an issue]'
      }
      output += `**Content (Markdown):**\n${content}\n\n`
    }

    output += '---\n\n'
  })

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
