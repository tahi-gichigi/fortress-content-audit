/**
 * HTTP-based link crawler
 * Actually fetches URLs to check if they're broken (vs Map-based inference)
 *
 * Architecture:
 * 1. Extract links from scraped pages
 * 2. HTTP check each link (with concurrency control)
 * 3. Report broken links, redirects, timeouts, etc.
 */

import type { FirecrawlPage } from './firecrawl-client'
import { scrapePage } from './firecrawl-client'
import Logger from './logger'

export interface CrawlerIssue {
  page_url: string // Source page where link appears
  category: 'Links'
  issue_description: string
  severity: 'low' | 'medium' | 'critical'
  suggested_fix: string
}

interface LinkCheckResult {
  url: string
  sourceUrl: string
  linkText: string
  status: 'ok' | 'broken' | 'redirect_chain' | 'slow' | 'timeout' | 'error'
  httpStatus?: number
  redirectCount?: number
  responseTimeMs?: number
  finalUrl?: string
  error?: string
}

interface ExtractedLink {
  text: string
  href: string
  sourceUrl: string
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private current = 0
  private queue: (() => void)[] = []

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }

    return new Promise(resolve => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    this.current--
    const next = this.queue.shift()
    if (next) {
      this.current++
      next()
    }
  }
}

/**
 * Extract links from markdown content
 */
function extractLinksFromMarkdown(
  markdown: string,
  sourceUrl: string
): ExtractedLink[] {
  const links: ExtractedLink[] = []

  // Match markdown links: [text](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let match

  while ((match = linkRegex.exec(markdown)) !== null) {
    const text = match[1]
    const href = match[2]

    // Skip anchors, mailto, tel, javascript
    if (
      href.startsWith('#') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('javascript:')
    ) {
      continue
    }

    links.push({ text, href, sourceUrl })
  }

  return links
}

/**
 * Normalize URL for absolute path
 */
function normalizeUrl(url: string, baseUrl: string): string {
  try {
    // Handle relative URLs
    if (url.startsWith('/') && !url.startsWith('//')) {
      const base = new URL(baseUrl)
      return `${base.origin}${url}`
    }

    // Handle protocol-relative URLs
    if (url.startsWith('//')) {
      const base = new URL(baseUrl)
      return `${base.protocol}${url}`
    }

    // Handle absolute URLs
    if (url.startsWith('http')) {
      return url
    }

    // Relative path
    const base = new URL(baseUrl)
    return new URL(url, base.href).href
  } catch {
    return url
  }
}

/**
 * Check if URL is internal (same domain)
 */
function isInternalUrl(url: string, domain: string): boolean {
  try {
    const parsed = new URL(url)
    const domainParsed = new URL(domain.startsWith('http') ? domain : `https://${domain}`)

    return parsed.hostname === domainParsed.hostname
  } catch {
    return false
  }
}

/**
 * Normalize URL for comparison (remove trailing slash, hash, query params)
 */
function normalizeUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url)
    // Use origin + pathname only (no query, no hash)
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
}

/**
 * Check a single link using HEAD request (fast, free)
 * Falls back to GET if HEAD returns 403/401 (some servers block HEAD).
 * Treats 403/401 as "inconclusive" (info severity) rather than errors.
 */
async function checkLinkWithFetch(
  url: string,
  sourceUrl: string,
  linkText: string,
  timeoutMs: number = 10000
): Promise<LinkCheckResult> {
  const startTime = Date.now()

  const doRequest = async (method: 'HEAD' | 'GET'): Promise<Response> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: BROWSER_HEADERS,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    let response = await doRequest('HEAD')
    let statusCode = response.status

    // Some servers reject HEAD — retry with GET
    if (statusCode === 403 || statusCode === 401 || statusCode === 405) {
      try {
        const getResponse = await doRequest('GET')
        statusCode = getResponse.status
      } catch {
        // GET also failed; keep original HEAD status
      }
    }

    const responseTimeMs = Date.now() - startTime

    // 401/403 = inconclusive (server may block crawlers, not necessarily broken)
    if (statusCode === 401 || statusCode === 403) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'ok', // treat as ok to avoid false-positive issues
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    // 404 = Broken
    if (statusCode === 404) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'broken',
        httpStatus: 404,
        responseTimeMs
      }
    }

    // 5xx = Server error (broken)
    if (statusCode >= 500) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'broken',
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    // 4xx (other than 401/403/404) = Client error
    if (statusCode >= 400) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'error',
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    // 2xx/3xx = Success (fetch follows redirects automatically)
    // Check if slow (>3 seconds)
    if (responseTimeMs > 3000) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'slow',
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    return {
      url,
      sourceUrl,
      linkText,
      status: 'ok',
      httpStatus: statusCode,
      responseTimeMs
    }

  } catch (error) {
    const responseTimeMs = Date.now() - startTime

    return {
      url,
      sourceUrl,
      linkText,
      status: 'error',
      responseTimeMs,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Check a single link using Firecrawl (bypasses bot protection)
 * For external links that may have bot protection
 */
async function checkLinkWithFirecrawl(
  url: string,
  sourceUrl: string,
  linkText: string,
  timeoutMs: number = 10000
): Promise<LinkCheckResult> {
  const startTime = Date.now()

  try {
    // Use Firecrawl to check the URL (handles redirects, bot protection, JS rendering)
    const result = await scrapePage(url)
    const responseTimeMs = Date.now() - startTime

    const statusCode = result.metadata?.statusCode

    // No status code means Firecrawl couldn't access it
    if (!statusCode) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'error',
        responseTimeMs,
        error: 'Could not determine status code'
      }
    }

    // 404 = Broken
    if (statusCode === 404) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'broken',
        httpStatus: 404,
        responseTimeMs
      }
    }

    // 5xx = Server error (broken)
    if (statusCode >= 500) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'broken',
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    // 4xx (other than 404) = Client error
    if (statusCode >= 400) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'error',
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    // 3xx = Redirects (Firecrawl follows them automatically, so if we got here, it worked)
    // 2xx = Success
    // Both are OK!

    // Check if slow (>3 seconds)
    if (responseTimeMs > 3000) {
      return {
        url,
        sourceUrl,
        linkText,
        status: 'slow',
        httpStatus: statusCode,
        responseTimeMs
      }
    }

    return {
      url,
      sourceUrl,
      linkText,
      status: 'ok',
      httpStatus: statusCode,
      responseTimeMs
    }

  } catch (error) {
    const responseTimeMs = Date.now() - startTime

    return {
      url,
      sourceUrl,
      linkText,
      status: 'error',
      responseTimeMs,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Convert check results to issues
 */
function resultToIssue(result: LinkCheckResult): CrawlerIssue | null {
  const { status, url, sourceUrl, linkText, httpStatus, responseTimeMs } = result

  switch (status) {
    case 'ok':
      return null // No issue

    case 'broken':
      return {
        page_url: sourceUrl,
        category: 'Links',
        severity: httpStatus === 404 ? 'critical' : 'medium',
        issue_description: `broken link: Link "${linkText}" points to ${url}, which returned HTTP ${httpStatus}.`,
        suggested_fix: httpStatus === 404
          ? 'Remove the broken link or update it to point to a valid page. The target page does not exist.'
          : `Server error (${httpStatus}). Check the target server or remove the link.`
      }

    case 'slow':
      return {
        page_url: sourceUrl,
        category: 'Links',
        severity: 'low',
        issue_description: `performance: Link "${linkText}" to ${url} took ${responseTimeMs}ms to respond (>3 seconds).`,
        suggested_fix: 'Check if the target server is slow or consider removing the link if it consistently times out.'
      }

    case 'error':
      return {
        page_url: sourceUrl,
        category: 'Links',
        severity: 'medium',
        issue_description: `error: Link "${linkText}" to ${url} returned error${httpStatus ? ` (HTTP ${httpStatus})` : ''}.`,
        suggested_fix: result.error || 'Check the link and verify it is accessible.'
      }

    default:
      return null
  }
}

/**
 * Crawl and validate links from scraped pages
 */
export async function crawlLinks(
  scrapedPages: FirecrawlPage[],
  domain: string,
  config?: {
    concurrency?: number
    timeoutMs?: number
    checkExternal?: boolean
    maxLinks?: number
    auditedUrls?: string[] // List of URLs being audited by AI models
  }
): Promise<CrawlerIssue[]> {
  const {
    concurrency = 5,
    timeoutMs = 10000,
    checkExternal = false,
    maxLinks = 200,
    auditedUrls = []
  } = config || {}

  Logger.debug(`[LinkCrawler] Starting link validation for ${scrapedPages.length} pages`)
  Logger.debug(`[LinkCrawler] Config: concurrency=${concurrency}, timeout=${timeoutMs}ms, checkExternal=${checkExternal}, maxLinks=${maxLinks}`)

  // Extract all links from pages
  const allLinks: ExtractedLink[] = []
  for (const page of scrapedPages) {
    if (!page.markdown) continue
    const links = extractLinksFromMarkdown(page.markdown, page.url)
    allLinks.push(...links)
  }

  // Normalize and filter links
  const linksToCheck = allLinks
    .map(link => ({
      ...link,
      href: normalizeUrl(link.href, link.sourceUrl)
    }))
    .filter(link => {
      const isInternal = isInternalUrl(link.href, domain)
      const isExternal = !isInternal

      // Always check external links if tier allows
      if (isExternal && checkExternal) {
        return true
      }

      // Skip external links if tier doesn't allow
      if (isExternal && !checkExternal) {
        return false
      }

      // Check all internal links — broken links to any page should be caught

      // Skip non-HTML files (images, videos, PDFs, etc.)
      // Firecrawl can't scrape these and they should be validated differently
      const assetExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.pdf', '.zip', '.mp4', '.mp3', '.css', '.js', '.woff', '.woff2', '.ttf', '.eot']
      const url = link.href.toLowerCase()
      if (assetExtensions.some(ext => url.includes(ext))) {
        return false
      }

      return true
    })

  // Log how many links were filtered
  const beforeFilterCount = allLinks.length
  const afterFilterCount = linksToCheck.length
  const filteredOutCount = beforeFilterCount - afterFilterCount

  if (filteredOutCount > 0) {
    Logger.debug(
      `[LinkCrawler] Filtered ${filteredOutCount} links to non-audited pages ` +
      `(${beforeFilterCount} total → ${afterFilterCount} checking)`
    )
  }

  // Deduplicate by URL+source (same link on same page)
  const uniqueLinks = Array.from(
    new Map(
      linksToCheck.map(link => [`${link.href}||${link.sourceUrl}`, link])
    ).values()
  )

  // Limit total links to check
  const limitedLinks = uniqueLinks.slice(0, maxLinks)

  if (uniqueLinks.length > maxLinks) {
    Logger.info(`[LinkCrawler] Limited to ${maxLinks} links (${uniqueLinks.length} total found)`)
  }

  // Count internal vs external for logging
  const internalCount = limitedLinks.filter(link => isInternalUrl(link.href, domain)).length
  const externalCount = limitedLinks.length - internalCount

  Logger.info(`[LinkCrawler] Checking ${limitedLinks.length} links (${internalCount} internal via fetch, ${externalCount} external via Firecrawl)...`)

  // Check links with concurrency control
  // Use hybrid approach: Fetch for internal, Firecrawl for external (bypasses bot protection)
  const semaphore = new Semaphore(concurrency)
  const results: LinkCheckResult[] = []

  const checkPromises = limitedLinks.map(async (link) => {
    await semaphore.acquire()
    try {
      const isInternal = isInternalUrl(link.href, domain)

      // Internal links: use fast HEAD request
      // External links: use Firecrawl (bypasses LinkedIn, Capterra, etc. bot protection)
      const result = isInternal
        ? await checkLinkWithFetch(link.href, link.sourceUrl, link.text, timeoutMs)
        : await checkLinkWithFirecrawl(link.href, link.sourceUrl, link.text, timeoutMs)

      results.push(result)
    } catch (error) {
      Logger.warn(`[LinkCrawler] Unexpected error checking ${link.href}:`, error)
    } finally {
      semaphore.release()
    }
  })

  await Promise.all(checkPromises)

  // Convert results to issues and deduplicate by URL
  const rawIssues = results
    .map(result => resultToIssue(result))
    .filter((issue): issue is CrawlerIssue => issue !== null)

  // Deduplicate: one issue per broken URL (keep highest severity)
  const issuesByUrl = new Map<string, CrawlerIssue>()
  for (const issue of rawIssues) {
    // Extract URL from issue description for dedup key
    const urlMatch = issue.issue_description.match(/points to ([^\s,]+)|to ([^\s]+) took|to ([^\s]+) returned/)
    const targetUrl = urlMatch ? (urlMatch[1] || urlMatch[2] || urlMatch[3]) : issue.issue_description
    const key = `${issue.page_url}::${targetUrl}`
    const existing = issuesByUrl.get(key)
    if (!existing) {
      issuesByUrl.set(key, issue)
    } else {
      // Keep higher severity
      const severityRank = { critical: 3, medium: 2, low: 1 }
      const existingRank = severityRank[existing.severity as keyof typeof severityRank] ?? 0
      const newRank = severityRank[issue.severity as keyof typeof severityRank] ?? 0
      if (newRank > existingRank) issuesByUrl.set(key, issue)
    }
  }
  const issues = Array.from(issuesByUrl.values())

  // Log summary
  const statusCounts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  Logger.info(
    `[LinkCrawler] Complete: ${results.length} links checked. ` +
    `${statusCounts.ok || 0} OK, ${statusCounts.broken || 0} broken, ` +
    `${statusCounts.timeout || 0} timeout, ${statusCounts.error || 0} errors. ` +
    `Found ${issues.length} issues.`
  )

  return issues
}
