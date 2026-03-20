/**
 * Tests for lib/firecrawl-adapter.ts
 *
 * Focused on nav/footer deduplication across pages — the structural dedup added
 * to formatFirecrawlForPrompt to avoid burning tokens on repeated chrome.
 */

import { formatFirecrawlForPrompt } from '../firecrawl-adapter'
import type { AuditManifest } from '../firecrawl-adapter'

// Minimal page factory — only html is needed for dedup tests
function makePage(url: string, navText: string, bodyText: string) {
  return {
    url,
    html: `<html><body><nav>${navText}</nav><main><p>${bodyText}</p></main></body></html>`,
    markdown: bodyText,
  }
}

// ============================================================================
// Nav/footer deduplication
// ============================================================================

describe('formatFirecrawlForPrompt — nav/footer deduplication', () => {
  it('replaces identical nav on page 2 with placeholder', () => {
    const manifest: AuditManifest = {
      pages: [
        makePage('https://example.com/', 'Home Pricing About', 'Welcome to Example'),
        makePage('https://example.com/pricing', 'Home Pricing About', 'Our pricing plans'),
      ],
      discoveredUrls: [],
      pagesFound: 2,
    }
    const output = formatFirecrawlForPrompt(manifest)

    // Page 1 should have the real nav text
    const page1Section = output.split('## Page 2')[0]
    expect(page1Section).toContain('Home Pricing About')

    // Page 2 should have the placeholder instead
    const page2Section = output.split('## Page 2')[1]
    expect(page2Section).toContain('[Same as Page 1]')
    expect(page2Section).not.toContain('Home Pricing About')
  })

  it('does NOT replace nav when text differs between pages', () => {
    const manifest: AuditManifest = {
      pages: [
        makePage('https://example.com/', 'Home Pricing About', 'Welcome'),
        makePage('https://example.com/pricing', 'Home Pricing About Contact', 'Pricing'),
      ],
      discoveredUrls: [],
      pagesFound: 2,
    }
    const output = formatFirecrawlForPrompt(manifest)

    // Both navs have different text — neither should be replaced
    expect(output).not.toContain('[Same as Page 1]')
  })

  it('keeps page 1 nav intact and only deduplicates from page 2 onwards', () => {
    const manifest: AuditManifest = {
      pages: [
        makePage('https://example.com/', 'Shared Nav', 'Page 1 content'),
        makePage('https://example.com/about', 'Shared Nav', 'Page 2 content'),
        makePage('https://example.com/contact', 'Shared Nav', 'Page 3 content'),
      ],
      discoveredUrls: [],
      pagesFound: 3,
    }
    const output = formatFirecrawlForPrompt(manifest)

    // Page 1 should have the actual nav
    const page1 = output.split('## Page 2')[0]
    expect(page1).toContain('Shared Nav')

    // Page 2 and 3 should have the placeholder
    const afterPage1 = output.split('## Page 2')[1]
    const placeholderCount = (afterPage1.match(/\[Same as Page 1\]/g) || []).length
    expect(placeholderCount).toBeGreaterThanOrEqual(2)
  })
})
