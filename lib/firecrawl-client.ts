/**
 * Firecrawl API Client
 * Handles web crawling with bot protection and JS rendering
 * Uses dynamic import for @mendable/firecrawl-js to prevent module-level failures
 * from breaking all exports (e.g. isFirecrawlAvailable)
 */

import Logger from './logger'

// Dynamic import to avoid module-level failures poisoning all exports
const getFirecrawlClient = async () => {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    throw new Error(
      'FIRECRAWL_API_KEY not found in environment variables. ' +
      'Add FIRECRAWL_API_KEY=your_key to .env.local or .env file. ' +
      'Get your API key from https://firecrawl.dev'
    )
  }
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  return new FirecrawlApp({ apiKey })
}

/**
 * Check if Firecrawl is available (API key configured)
 */
export function isFirecrawlAvailable(): boolean {
  return !!process.env.FIRECRAWL_API_KEY
}

export interface FirecrawlPage {
  url: string
  markdown?: string
  html?: string
  links?: string[]
  metadata?: {
    title?: string
    description?: string
    statusCode?: number
  }
  /** Pre-extracted structured text from Playwright DOM walk. Populated upstream
   * when USE_PLAYWRIGHT_EXTRACTION=true. Replaces HTML compress step in prompt formatting. */
  renderedText?: string
}

export interface CrawlOptions {
  limit?: number
  maxDepth?: number
  includePaths?: string[]
  excludePaths?: string[]
  onlyMainContent?: boolean
}

/**
 * Crawl a website and return pages with markdown content
 */
export async function crawlWebsite(
  url: string,
  options: CrawlOptions = {}
): Promise<FirecrawlPage[]> {
  const {
    limit = 20,
    maxDepth = 3,
    includePaths,
    excludePaths,
    onlyMainContent = true
  } = options

  const firecrawl = await getFirecrawlClient()

  try {
    Logger.info(`[Firecrawl] Starting crawl of ${url} (limit: ${limit})`)
    const startTime = Date.now()

    const result = await firecrawl.crawl(url, {
      limit,
      maxDepth,
      includePaths,
      excludePaths,
      scrapeOptions: {
        formats: ['markdown', 'links'],
        onlyMainContent
      }
    } as any)

    const duration = Date.now() - startTime
    Logger.info(`[Firecrawl] Crawl completed in ${(duration / 1000).toFixed(1)}s: ${result.data?.length || 0} pages`)

    return (result.data || []) as FirecrawlPage[]
  } catch (error) {
    Logger.error('[Firecrawl] Crawl failed', error instanceof Error ? error : undefined)
    throw error
  }
}

/**
 * Map a website to discover all URLs
 * Returns array of URL strings or objects with url property
 */
export async function mapWebsite(url: string): Promise<Array<string | { url: string; title?: string; description?: string }>> {
  const firecrawl = await getFirecrawlClient()

  try {
    Logger.info(`[Firecrawl] Mapping ${url}`)
    const startTime = Date.now()

    const result = await firecrawl.map(url, {
      includeSubdomains: false,
      limit: 1000
    })

    const duration = Date.now() - startTime
    const urls = result.links || []
    Logger.info(`[Firecrawl] Map completed in ${(duration / 1000).toFixed(1)}s: ${urls.length} URLs found`)

    return urls
  } catch (error) {
    Logger.error('[Firecrawl] Map failed', error instanceof Error ? error : undefined)
    throw error
  }
}

// JS to strip hidden elements before extraction (see ADR-001).
// Runs in browser context where getComputedStyle resolves all CSS
// including Tailwind responsive classes and media queries.
// Also strips sr-only / visually-hidden elements and aria-hidden content.
const STRIP_HIDDEN_ELEMENTS_SCRIPT = `
  // Phase 0: Open native HTML accordions so their content is visible before hidden-element
  // stripping. <details> elements are closed by default — expanding them here means the
  // browser calculates their children as visible and phase 2 won't remove them.
  document.querySelectorAll('details').forEach(d => { d.open = true; });
  // Force a synchronous reflow so getComputedStyle in phase 2 reflects the opened state.
  void document.body.offsetHeight;

  // Phase 0b: Expand Radix/Headless UI closed accordion panels.
  // Radix uses CSS attribute selectors ([data-state="closed"] { display:none }) rather
  // than JS toggling, so flipping the attribute makes panel content visible to
  // getComputedStyle in phase 2 — without triggering React event handlers.
  // Guard: skip dialog, tooltip, menu, and modal components that also use data-state.
  // These should stay closed to avoid surfacing off-screen modal content as live text.
  const ACCORDION_SKIP_ROLES = new Set(['dialog','alertdialog','tooltip','menu','menuitem','listbox']);
  document.querySelectorAll('[data-state="closed"]').forEach(el => {
    if (ACCORDION_SKIP_ROLES.has(el.getAttribute('role') || '')) return;
    if (el.getAttribute('aria-modal') === 'true') return;
    if (el.hasAttribute('data-radix-tooltip-content')) return;
    if (el.hasAttribute('data-radix-dialog-content')) return;
    el.setAttribute('data-state', 'open');
  });
  void document.body.offsetHeight;

  // Phase 1: Strip by class/attribute (sr-only, visually-hidden, aria-hidden)
  document.querySelectorAll('.sr-only, .visually-hidden, [aria-hidden="true"]').forEach(el => {
    el.remove();
  });

  // Phase 2: Strip by computed style (display:none, visibility:hidden, zero-size)
  // Skip inline formatting tags like <br>, <wbr>, <hr> — they have zero dimensions but carry meaning
  const skipTags = new Set(['BR', 'WBR', 'HR', 'IMG', 'INPUT', 'SVG', 'META', 'LINK']);
  document.querySelectorAll('*').forEach(el => {
    if (skipTags.has(el.tagName)) return;
    try {
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (el.offsetHeight === 0 && el.offsetWidth === 0)
      ) {
        el.remove();
        return;
      }
      // Catch clip-based hiding patterns (position:absolute + clip rect)
      if (
        style.position === 'absolute' &&
        style.overflow === 'hidden' &&
        el.offsetWidth <= 1 &&
        el.offsetHeight <= 1
      ) {
        el.remove();
      }
    } catch (e) {}
  });
`

/**
 * Scrape a single page
 * Strips hidden elements (responsive duplicates) before extraction.
 * Uses onlyMainContent: false so the link crawler sees nav/footer links too.
 */
export async function scrapePage(url: string): Promise<FirecrawlPage> {
  const firecrawl = await getFirecrawlClient()

  try {
    const result = await firecrawl.scrape(url, {
      formats: ['markdown', 'links', 'html'],
      onlyMainContent: false,
      actions: [
        { type: 'wait', milliseconds: 500 },
        { type: 'executeJavascript' as any, script: STRIP_HIDDEN_ELEMENTS_SCRIPT },
        { type: 'wait', milliseconds: 200 },
      ]
    })

    return {
      url,
      markdown: result.markdown,
      html: result.html,
      links: result.links,
      metadata: result.metadata
    }
  } catch (error) {
    Logger.error(`[Firecrawl] Scrape failed for ${url}`, error instanceof Error ? error : undefined)
    throw error
  }
}
