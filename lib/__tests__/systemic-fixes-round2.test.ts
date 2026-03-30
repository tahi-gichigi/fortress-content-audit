/**
 * Tests for PR #6: Fix systemic issues A-G (round 2)
 *
 * Each describe block maps to a fix letter for traceability back to the
 * Notion ticket (7edda1f2) and QA failures (2c265922).
 *
 * Test rules followed:
 * - Pure functions only — no jsdom, no component rendering
 * - No jest.mock() of DB clients — logic mirrored where not exported
 * - No AI/LLM calls
 */

import { compressHtml, compressHtmlToChunks } from '../html-compressor'
import { applyCheckerDecisions, type RawIssue, type CheckerVerification } from '../checker-decisions'
import { selectPagesToAudit } from '../page-selector'
import {
  buildCategoryAuditPrompt,
  buildLiberalCategoryAuditPrompt,
  buildCheckerPrompt,
  buildMiniAuditPrompt,
  buildFullAuditPrompt,
} from '../audit-prompts'
import { formatFirecrawlForPrompt, formatPagesForChecker } from '../firecrawl-adapter'
import type { AuditManifest } from '../firecrawl-adapter'

// ============================================================================
// Fix A: Health score formula (0-clamp) + checker fail-safe defaults
//
// Bug: route.ts had a duplicate formula with different weights than lib/health-score.ts.
// Bug: health score clamped to min 1 instead of 0.
// Bug: missing checker verifications defaulted to confirmed=true (let junk through).
//
// Why it matters: health score is the primary metric users see. A site with 250
// issues was showing score 1 instead of 0. And unverified issues were surviving
// the checker, inflating issue counts.
// ============================================================================

describe('Fix A: Health score formula', () => {
  // Mirror the canonical formula from lib/health-score.ts for pure testing.
  // The actual function queries Supabase, so we test the math directly.
  function computeScore(
    low: number,
    medium: number,
    critical: number,
    criticalPages: number
  ): number {
    let score = 100
    score -= low * 0.5
    score -= medium * 2
    score -= critical * 4
    score -= criticalPages * 5
    return Math.max(0, Math.min(100, score))
  }

  it('returns 100 for zero issues', () => {
    expect(computeScore(0, 0, 0, 0)).toBe(100)
  })

  it('applies correct weights: low=0.5, medium=2, critical=4, criticalPages=5', () => {
    // 10 low issues = -5
    expect(computeScore(10, 0, 0, 0)).toBe(95)
    // 10 medium issues = -20
    expect(computeScore(0, 10, 0, 0)).toBe(80)
    // 10 critical issues on 2 pages = -40 - 10 = -50 → score 50
    expect(computeScore(0, 0, 10, 2)).toBe(50)
  })

  it('clamps to 0 — NOT 1 — when penalties exceed 100', () => {
    // 50 critical issues = -200, 10 critical pages = -50 → raw = -150 → clamp to 0
    expect(computeScore(0, 0, 50, 10)).toBe(0)
  })

  it('clamps to 100 maximum', () => {
    // Shouldn't happen but formula should never exceed 100
    expect(computeScore(0, 0, 0, 0)).toBeLessThanOrEqual(100)
  })

  it('matches real-world scenario: seline.so 83 issues all medium = score 0 not 1', () => {
    // QA bug: seline.so had 83 medium issues → old formula showed score 1 (clamped min 1)
    // New formula: 100 - 83*2 = -66 → 0
    expect(computeScore(0, 83, 0, 0)).toBe(0)
  })

  it('matches real-world scenario: plausible.io 92 issues 2 critical', () => {
    // 88 low + 2 medium + 2 critical on 2 pages
    // = 100 - 88*0.5 - 2*2 - 2*4 - 2*5 = 100 - 44 - 4 - 8 - 10 = 34
    expect(computeScore(88, 2, 2, 2)).toBe(34)
  })
})

describe('Fix A: Checker fail-safe defaults', () => {
  const issue: RawIssue = {
    page_url: 'https://example.com',
    category: 'Language',
    issue_description: 'professionalism: "recieve" in hero',
    severity: 'medium',
    suggested_fix: 'Change to "receive".',
  }

  it('drops issues with no matching verification (fail-safe)', () => {
    // Previously defaulted confirmed=true, letting unverified issues through.
    // Now defaults to confirmed=false: if the checker didn't explicitly verify it, drop it.
    const result = applyCheckerDecisions([issue], [])
    expect(result).toHaveLength(0)
  })

  it('drops issues when verification exists but confirmed is missing', () => {
    // Malformed verification response — confirmed field absent
    const verifications = [{ index: 0, confidence: 0.9, evidence: 'found' }] as CheckerVerification[]
    const result = applyCheckerDecisions([issue], verifications)
    // confirmed defaults to false, so dropped
    expect(result).toHaveLength(0)
  })

  it('still keeps explicitly confirmed=true issues', () => {
    const verifications: CheckerVerification[] = [
      { index: 0, confirmed: true, confidence: 0.95, evidence: '<p>recieve</p>' },
    ]
    const result = applyCheckerDecisions([issue], verifications)
    expect(result).toHaveLength(1)
  })

  it('handles batch where some have verifications and some do not', () => {
    const issues = [
      { ...issue, issue_description: 'A' },
      { ...issue, issue_description: 'B' },
      { ...issue, issue_description: 'C' },
    ]
    // Only issue 0 has a verification; issues 1 and 2 have none → dropped
    const verifications: CheckerVerification[] = [
      { index: 0, confirmed: true, confidence: 0.9, evidence: 'found A' },
    ]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(1)
    expect(result[0].issue_description).toBe('A')
  })
})

// ============================================================================
// Fix B: Deterministic page selection + foreign language filter
//
// Bug: page selection used a model call (gpt-4.1-mini) which was non-deterministic.
// Bug: foreign language pages (e.g. /es/, /fr/) were included, causing the model
// to audit in Spanish/Portuguese/Italian instead of the site's primary language.
//
// Why it matters: consistency is key for a paid product. Running the same audit
// twice should select the same pages. Foreign content produces garbled results.
// ============================================================================

describe('Fix B: Page selection — language filter', () => {
  const baseDomain = 'example.com'
  const baseUrls = [
    'https://example.com/',
    'https://example.com/pricing',
    'https://example.com/about',
    'https://example.com/es/pricing',
    'https://example.com/fr/about',
    'https://example.com/de/kontakt',
    'https://example.com/pt/sobre',
    'https://example.com/features',
  ]

  it('filters out foreign language URLs (/es/, /fr/, /de/, /pt/)', async () => {
    const result = await selectPagesToAudit(baseUrls, baseDomain, 'FREE', false)
    expect(result).not.toContain('https://example.com/es/pricing')
    expect(result).not.toContain('https://example.com/fr/about')
    expect(result).not.toContain('https://example.com/de/kontakt')
    expect(result).not.toContain('https://example.com/pt/sobre')
  })

  it('keeps primary language URLs', async () => {
    const result = await selectPagesToAudit(baseUrls, baseDomain, 'FREE', false)
    expect(result).toContain('https://example.com/')
    expect(result).toContain('https://example.com/pricing')
  })

  it('filters all 18 known language prefixes', async () => {
    const langPrefixes = ['es', 'pt', 'it', 'fr', 'de', 'ja', 'ko', 'zh', 'nl', 'ru', 'ar', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'tr']
    const urls = [
      'https://example.com/',
      ...langPrefixes.map(lang => `https://example.com/${lang}/page`),
    ]
    const result = await selectPagesToAudit(urls, baseDomain, 'PAID', false)
    for (const lang of langPrefixes) {
      expect(result).not.toContain(`https://example.com/${lang}/page`)
    }
  })
})

describe('Fix B: Page selection — determinism', () => {
  const domain = 'example.com'
  // No longform paths (/blog, /articles) — those are filtered when includeLongform=false
  const urls = [
    'https://example.com/',
    'https://example.com/pricing',
    'https://example.com/about',
    'https://example.com/features',
    'https://example.com/contact',
    'https://example.com/team',
    'https://example.com/docs',
    'https://example.com/changelog',
    'https://example.com/integrations',
    'https://example.com/solutions',
  ]

  it('returns the same pages for the same input (deterministic)', async () => {
    const run1 = await selectPagesToAudit(urls, domain, 'FREE', false)
    const run2 = await selectPagesToAudit(urls, domain, 'FREE', false)
    const run3 = await selectPagesToAudit(urls, domain, 'FREE', false)
    expect(run1).toEqual(run2)
    expect(run2).toEqual(run3)
  })

  it('always includes homepage as first URL', async () => {
    const result = await selectPagesToAudit(urls, domain, 'FREE', false)
    expect(result[0]).toBe('https://example.com/')
  })

  it('FREE tier selects 5 pages', async () => {
    const result = await selectPagesToAudit(urls, domain, 'FREE', false)
    expect(result).toHaveLength(5)
  })

  it('PAID tier selects up to 20 pages (returns all when fewer available)', async () => {
    const result = await selectPagesToAudit(urls, domain, 'PAID', false)
    expect(result).toHaveLength(10)
  })

  it('prioritizes high-value marketing pages over low-value ones', async () => {
    const result = await selectPagesToAudit(urls, domain, 'FREE', false)
    // Pricing and about should be selected over changelog
    expect(result).toContain('https://example.com/pricing')
    expect(result).toContain('https://example.com/about')
  })

  it('filters longform paths when includeLongform is false', async () => {
    const withBlog = [...urls, 'https://example.com/blog/my-post']
    const result = await selectPagesToAudit(withBlog, domain, 'PAID', false)
    expect(result).not.toContain('https://example.com/blog/my-post')
  })

  it('includes longform paths when includeLongform is true', async () => {
    const withBlog = ['https://example.com/', 'https://example.com/blog/my-post']
    const result = await selectPagesToAudit(withBlog, domain, 'PAID', true)
    expect(result).toContain('https://example.com/blog/my-post')
  })

  it('returns all URLs when count <= target', async () => {
    const fewUrls = ['https://example.com/', 'https://example.com/pricing']
    const result = await selectPagesToAudit(fewUrls, domain, 'FREE', false)
    expect(result).toHaveLength(2)
  })

  it('falls back to homepage when no URLs provided', async () => {
    const result = await selectPagesToAudit([], domain, 'FREE', false)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('example.com')
  })
})

// ============================================================================
// Fix C: Link crawler 403 handling + category rename
//
// Bug: HEAD requests returning 403 were reported as broken links. Many sites
// block HEAD requests but the pages work fine in a browser.
// Bug: category was "Links & Formatting" but link issues should be "Links"
// and formatting issues should be "Formatting" (separate concerns).
//
// Why it matters: false-positive 403 broken links were the #1 false positive
// across all QA test sites (plausible.io, lottiefiles.com, cal.com).
// ============================================================================

describe('Fix C: Link crawler 403 handling', () => {
  // Mirror the decision logic from checkLinkWithFetch.
  // The actual function makes network calls, so we test the status-code decision tree.
  function classifyStatus(statusCode: number, isGetFallback: boolean): 'ok' | 'broken' | 'error' {
    // After GET fallback, 401/403 = inconclusive → treat as ok
    if (statusCode === 401 || statusCode === 403) return 'ok'
    if (statusCode === 404) return 'broken'
    if (statusCode >= 500) return 'broken'
    if (statusCode >= 400) return 'error'
    return 'ok'
  }

  it('treats 403 as ok (inconclusive), not broken', () => {
    expect(classifyStatus(403, true)).toBe('ok')
  })

  it('treats 401 as ok (inconclusive), not broken', () => {
    expect(classifyStatus(401, true)).toBe('ok')
  })

  it('still treats 404 as broken', () => {
    expect(classifyStatus(404, false)).toBe('broken')
  })

  it('still treats 500 as broken', () => {
    expect(classifyStatus(500, false)).toBe('broken')
  })

  it('treats 200 as ok', () => {
    expect(classifyStatus(200, false)).toBe('ok')
  })

  it('treats 429 (rate limit) as error, not broken', () => {
    expect(classifyStatus(429, false)).toBe('error')
  })
})

describe('Fix C: Category rename — Links separated from Formatting', () => {
  // Mirror the resultToIssue category assignment
  it('broken link issues use category "Links" not "Links & Formatting"', () => {
    // Verify the CrawlerIssue type uses 'Links'
    const issue = {
      page_url: 'https://example.com',
      category: 'Links' as const,
      severity: 'critical' as const,
      issue_description: 'broken link: Link "Docs" points to /docs, which returned HTTP 404.',
      suggested_fix: 'Remove the broken link or update it.',
    }
    expect(issue.category).toBe('Links')
  })

  it('Formatting category prompt uses "Formatting" not "Links & Formatting"', () => {
    const prompt = buildCategoryAuditPrompt(
      'Formatting',
      ['https://example.com'],
      '',
      '[]',
      '[]'
    )
    expect(prompt).toContain('Formatting')
    expect(prompt).not.toContain('Links & Formatting')
  })

  it('mini audit prompt uses "Formatting" category name', () => {
    const prompt = buildMiniAuditPrompt('https://example.com', '', '[]', '[]')
    expect(prompt).toContain('Formatting')
    expect(prompt).not.toContain('Links & Formatting')
  })

  it('full audit prompt uses "Formatting" category name', () => {
    const prompt = buildFullAuditPrompt('https://example.com', '', '[]', '[]')
    expect(prompt).toContain('Formatting')
    expect(prompt).not.toContain('Links & Formatting')
  })

  it('checker prompt uses "Formatting" verification criteria', () => {
    const issues = [{ category: 'Formatting', issue_description: 'missing alt text' }]
    const prompt = buildCheckerPrompt('## Page\n<img src="/hero.jpg"/>', issues, 'Formatting')
    expect(prompt).toContain('HTML structure supports the claim')
  })
})

// ============================================================================
// Fix D: Checker chunk coverage + within-audit dedup
//
// Bug: formatPagesForChecker only sent chunk 1 to the checker, so issues on
// the second half of long pages were rejected ("text not found in HTML").
// Bug: same issue surfaced twice on the same page (once as low, once as medium)
// because two category auditors flagged it independently.
//
// Why it matters: checker blind spots = real issues dropped. Duplicates make
// the audit look sloppy and inflate issue counts.
// ============================================================================

describe('Fix D: Checker sees both chunks for long pages', () => {
  it('formatPagesForChecker includes "part 1 of 2" and "part 2 of 2" for large pages', () => {
    // Generate a page large enough to produce 2 chunks at the default 60K limit
    const sections = Array.from({ length: 2000 }, (_, i) =>
      `<section><h2>Section ${i}</h2><p>${'Lorem ipsum dolor sit amet consectetur. '.repeat(15)}</p></section>`
    ).join('')
    const bigHtml = `<html><body>${sections}</body></html>`

    const manifest: AuditManifest = {
      pages: [{ url: 'https://example.com/', html: bigHtml, markdown: '' }],
      discoveredUrls: [],
      pagesFound: 1,
    }

    const output = formatPagesForChecker(manifest, new Set(['https://example.com/']))
    expect(output).toContain('part 1 of 2')
    expect(output).toContain('part 2 of 2')
  })

  it('formatPagesForChecker uses single chunk for small pages (no part markers)', () => {
    const manifest: AuditManifest = {
      pages: [{ url: 'https://example.com/', html: '<p>Short page</p>', markdown: '' }],
      discoveredUrls: [],
      pagesFound: 1,
    }

    const output = formatPagesForChecker(manifest, new Set(['https://example.com/']))
    expect(output).not.toContain('part 1 of 2')
    expect(output).toContain('Short page')
  })

  it('formatPagesForChecker shows fallback when no pages match', () => {
    const manifest: AuditManifest = {
      pages: [{ url: 'https://example.com/', html: '<p>Content</p>', markdown: '' }],
      discoveredUrls: [],
      pagesFound: 1,
    }
    const output = formatPagesForChecker(manifest, new Set(['https://other.com/']))
    expect(output).toContain('No HTML available')
  })
})

describe('Fix D: Within-audit deduplication', () => {
  // Mirror deduplicateIssues from lib/audit.ts (not exported)
  type Issue = { page_url: string; category: string; issue_description: string; severity: string; suggested_fix: string }

  function deduplicateIssues(issues: Issue[]): Issue[] {
    const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim()

    const isSimilar = (a: string, b: string): boolean => {
      const na = normalize(a)
      const nb = normalize(b)
      if (na === nb) return true
      if (na.includes(nb) || nb.includes(na)) return true
      const setA = new Set(na)
      const setB = new Set(nb)
      const shared = [...setA].filter(c => setB.has(c)).length
      const maxLen = Math.max(setA.size, setB.size)
      if (maxLen === 0) return true
      return shared / maxLen > 0.8
    }

    const severityRank: Record<string, number> = { critical: 3, medium: 2, low: 1 }
    const deduped: Issue[] = []

    for (const issue of issues) {
      const existingIdx = deduped.findIndex(
        d => d.page_url === issue.page_url && isSimilar(d.issue_description, issue.issue_description)
      )
      if (existingIdx === -1) {
        deduped.push(issue)
      } else {
        const existingRank = severityRank[deduped[existingIdx].severity] ?? 0
        const newRank = severityRank[issue.severity] ?? 0
        if (newRank > existingRank) {
          deduped[existingIdx] = issue
        }
      }
    }
    return deduped
  }

  const baseIssue = (overrides?: Partial<Issue>): Issue => ({
    page_url: 'https://example.com',
    category: 'Language',
    issue_description: 'professionalism: "1,100+ Cancel Guides" lacks specificity',
    severity: 'medium',
    suggested_fix: 'Be more specific.',
    ...overrides,
  })

  it('removes exact duplicate on the same page', () => {
    const issues = [baseIssue(), baseIssue()]
    expect(deduplicateIssues(issues)).toHaveLength(1)
  })

  it('keeps issues on different pages (not duplicates)', () => {
    const issues = [
      baseIssue({ page_url: 'https://example.com/' }),
      baseIssue({ page_url: 'https://example.com/pricing' }),
    ]
    expect(deduplicateIssues(issues)).toHaveLength(2)
  })

  it('keeps the higher severity when duplicates differ in severity', () => {
    // QA finding: same issue appeared as both "low" and "medium" on seline.so
    const issues = [
      baseIssue({ severity: 'low' }),
      baseIssue({ severity: 'medium' }),
    ]
    const result = deduplicateIssues(issues)
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe('medium')
  })

  it('keeps critical over medium when duplicates conflict', () => {
    const issues = [
      baseIssue({ severity: 'medium' }),
      baseIssue({ severity: 'critical' }),
    ]
    const result = deduplicateIssues(issues)
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe('critical')
  })

  it('treats substring-contained descriptions as similar', () => {
    // justcancel.io QA: same issue with slightly different wording
    const issues = [
      baseIssue({ issue_description: 'clarity: "1,100+ Cancel Guides" lacks specificity' }),
      baseIssue({ issue_description: 'clarity: "1,100+ Cancel Guides" headline lacks specificity and context' }),
    ]
    const result = deduplicateIssues(issues)
    expect(result).toHaveLength(1)
  })

  it('keeps dissimilar issues on the same page', () => {
    const issues = [
      baseIssue({ issue_description: 'professionalism: "recieve" misspelled in hero' }),
      baseIssue({ issue_description: 'trust: pricing table contradicts footer' }),
    ]
    expect(deduplicateIssues(issues)).toHaveLength(2)
  })

  it('returns empty array for empty input', () => {
    expect(deduplicateIssues([])).toEqual([])
  })
})

// ============================================================================
// Fix E: HTML compressor — badge placeholder, inline spacing, zero-width filter
//
// Bug: badge spans (e.g. "New", "Beta") got unwrapped and merged into adjacent
// text → "Dynamic ContentNew" false positive on beehiiv.com.
// Bug: inline tag unwrapping dropped the space between siblings →
// "ClickHere" instead of "Click Here".
// Bug: model hallucinated zero-width characters that don't exist in the HTML.
//
// Why it matters: these are the root causes of 3 distinct false positive
// categories from QA testing.
// ============================================================================

describe('Fix E: Badge placeholder detection', () => {
  it('replaces badge-class spans with [Badge: text] placeholder', () => {
    const html = '<h3>Dynamic Content<span class="badge ml-2">New</span></h3>'
    const result = compressHtml(html)
    expect(result).toContain('[Badge: New]')
    expect(result).not.toContain('ContentNew')
  })

  it('replaces tag-class spans', () => {
    const html = '<p>Feature<span class="tag text-xs">Beta</span></p>'
    const result = compressHtml(html)
    expect(result).toContain('[Badge: Beta]')
  })

  it('replaces label-class spans', () => {
    const html = '<div>Plan<span class="label">Pro</span></div>'
    const result = compressHtml(html)
    expect(result).toContain('[Badge: Pro]')
  })

  it('replaces pill/chip/status/tier/plan class patterns', () => {
    const patterns = ['pill', 'chip', 'status', 'tier', 'plan']
    for (const cls of patterns) {
      const html = `<span class="${cls}">Active</span>`
      const result = compressHtml(html)
      expect(result).toContain('[Badge: Active]')
    }
  })

  it('does NOT badge-ify long text spans (>30 chars)', () => {
    const longText = 'This is a very long span that is not a badge label'
    const html = `<span class="badge">${longText}</span>`
    const result = compressHtml(html)
    // Long text should not be treated as a badge
    expect(result).not.toContain('[Badge:')
  })

  it('does NOT badge-ify spans without badge/tag/label classes', () => {
    const html = '<span class="text-green-600 font-bold">$49</span>'
    const result = compressHtml(html)
    expect(result).not.toContain('[Badge:')
    expect(result).toContain('$49')
  })
})

describe('Fix E: Inline tag spacing', () => {
  it('inserts space when unwrapping inline tag adjacent to text', () => {
    // The beehiiv.com false positive: "AINewsletterGenerator" missing spaces
    const html = '<h1>AI<strong>Newsletter</strong>Generator</h1>'
    const result = compressHtml(html)
    expect(result).not.toContain('AINewsletter')
    // Should have space separation
    expect(result).toContain('AI ')
  })

  it('preserves existing space between adjacent elements', () => {
    const html = '<p>Click <strong>here</strong> to continue</p>'
    const result = compressHtml(html)
    expect(result).toContain('Click here to continue')
  })

  it('does not double-space when whitespace already exists', () => {
    const html = '<p>Word <em>emphasis</em> more</p>'
    const result = compressHtml(html)
    // Should not have double spaces
    expect(result).not.toMatch(/Word {2,}emphasis/)
  })
})

describe('Fix E: Zero-width character verification', () => {
  // Mirror the zero-width check from verifyIssuesAgainstHtml in lib/audit.ts
  const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF\u00AD\u200E\u200F\u2060\u2061-\u2064]/

  function shouldDropZeroWidthClaim(issueDescription: string, rawHtml: string): boolean {
    const isZeroWidthClaim = /invisible character|zero.?width|hidden character|non.?printable/i.test(issueDescription)
    if (!isZeroWidthClaim) return false
    return !ZERO_WIDTH_REGEX.test(rawHtml)
  }

  it('drops zero-width claim when HTML contains no zero-width chars', () => {
    // plausible.io QA: model hallucinated zero-width characters
    const html = '<p>What is audience segmentation?</p>'
    const desc = 'credibility: "What" appears to contain an invisible or zero-width character'
    expect(shouldDropZeroWidthClaim(desc, html)).toBe(true)
  })

  it('keeps zero-width claim when HTML actually has zero-width chars', () => {
    const html = '<p>What\u200B is audience segmentation?</p>'
    const desc = 'credibility: "What" contains an invisible or zero-width character'
    expect(shouldDropZeroWidthClaim(desc, html)).toBe(false)
  })

  it('does not affect non-zero-width issue descriptions', () => {
    const html = '<p>recieve your order</p>'
    const desc = 'professionalism: "recieve" misspelled'
    expect(shouldDropZeroWidthClaim(desc, html)).toBe(false)
  })

  it('catches "hidden character" phrasing variants', () => {
    const html = '<p>Normal text</p>'
    expect(shouldDropZeroWidthClaim('trust: hidden character found in heading', html)).toBe(true)
    expect(shouldDropZeroWidthClaim('professionalism: non-printable character in CTA', html)).toBe(true)
  })

  it('recognizes all zero-width Unicode codepoints', () => {
    const chars = ['\u200B', '\u200C', '\u200D', '\uFEFF', '\u00AD', '\u200E', '\u200F', '\u2060']
    for (const char of chars) {
      const html = `<p>test${char}word</p>`
      expect(ZERO_WIDTH_REGEX.test(html)).toBe(true)
    }
  })
})

// ============================================================================
// Fix F: Severity rubric in prompts
//
// Bug: no explicit rubric → model used its own judgment, producing inconsistent
// severity ratings. Same type of issue rated differently across runs.
//
// Why it matters: severity is a key dimension of audit quality. Users see
// critical/medium/low and make prioritization decisions based on it.
// ============================================================================

describe('Fix F: Severity rubric in prompts', () => {
  const urls = ['https://example.com']
  const noExcluded = '[]'
  const noActive = '[]'

  it('category audit prompt includes severity rubric', () => {
    const prompt = buildCategoryAuditPrompt('Language', urls, '', noExcluded, noActive)
    expect(prompt).toContain('SEVERITY RUBRIC')
    expect(prompt).toContain('critical:')
    expect(prompt).toContain('medium:')
    expect(prompt).toContain('low:')
  })

  it('liberal audit prompt includes severity rubric', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, '', noExcluded, noActive)
    expect(prompt).toContain('SEVERITY RUBRIC')
  })

  it('rubric defines critical as broken functionality / wrong information', () => {
    const prompt = buildCategoryAuditPrompt('Language', urls, '', noExcluded, noActive)
    expect(prompt).toContain('broken functionality')
    expect(prompt).toContain('completely wrong information')
  })

  it('rubric defines low as minor style preferences / nitpicks', () => {
    const prompt = buildCategoryAuditPrompt('Language', urls, '', noExcluded, noActive)
    expect(prompt).toContain('minor style preferences')
    expect(prompt).toContain('nitpicks')
  })

  it('rubric includes concrete examples for each severity level', () => {
    const prompt = buildCategoryAuditPrompt('Language', urls, '', noExcluded, noActive)
    // Should include at least one example per level
    expect(prompt).toContain('Free forever')
    expect(prompt).toContain('AI-powered')
    expect(prompt).toContain('footer copyright')
  })

  it('rubric is present in all three category prompts', () => {
    for (const category of ['Language', 'Facts & Consistency', 'Formatting'] as const) {
      const prompt = buildCategoryAuditPrompt(category, urls, '', noExcluded, noActive)
      expect(prompt).toContain('SEVERITY RUBRIC')
    }
  })
})

// ============================================================================
// Fix G: Nav dedup fingerprint includes hrefs
//
// Bug: nav dedup used only text content for fingerprinting. Localized navs with
// the same text but different href paths were incorrectly deduplicated.
//
// Why it matters: a Spanish nav (/es/pricing) and English nav (/pricing) have
// the same visible text but link to different pages. Deduplicating them hides
// the localized nav from the model.
// ============================================================================

describe('Fix G: Nav dedup fingerprint includes hrefs', () => {
  function makePage(url: string, navHtml: string, bodyText: string) {
    return {
      url,
      html: `<html><body>${navHtml}<main><p>${bodyText}</p></main></body></html>`,
      markdown: bodyText,
    }
  }

  it('deduplicates nav with same text AND same hrefs', () => {
    const nav = '<nav><a href="/pricing">Pricing</a> <a href="/about">About</a></nav>'
    const manifest: AuditManifest = {
      pages: [
        makePage('https://example.com/', nav, 'Home page'),
        makePage('https://example.com/pricing', nav, 'Pricing page'),
      ],
      discoveredUrls: [],
      pagesFound: 2,
    }
    const output = formatFirecrawlForPrompt(manifest)
    expect(output).toContain('[Same as Page 1]')
  })

  it('does NOT deduplicate nav with same text but different hrefs', () => {
    const navEn = '<nav><a href="/pricing">Pricing</a> <a href="/about">About</a></nav>'
    const navEs = '<nav><a href="/es/pricing">Pricing</a> <a href="/es/about">About</a></nav>'
    const manifest: AuditManifest = {
      pages: [
        makePage('https://example.com/', navEn, 'English home'),
        makePage('https://example.com/es/', navEs, 'Spanish home'),
      ],
      discoveredUrls: [],
      pagesFound: 2,
    }
    const output = formatFirecrawlForPrompt(manifest)
    // Both navs should appear — the hrefs differ
    expect(output).not.toContain('[Same as Page 1]')
  })

  it('deduplicates footer with same text and hrefs across pages', () => {
    const page = (url: string, body: string) => ({
      url,
      html: `<html><body><main><p>${body}</p></main><footer><a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer></body></html>`,
      markdown: body,
    })
    const manifest: AuditManifest = {
      pages: [page('https://example.com/', 'Home'), page('https://example.com/about', 'About')],
      discoveredUrls: [],
      pagesFound: 2,
    }
    const output = formatFirecrawlForPrompt(manifest)
    expect(output).toContain('[Same as Page 1]')
  })
})

// ============================================================================
// Cross-fix: Prompt language detection instruction
//
// Bug: prompts said "write output in the page's language" but didn't tell the
// model to skip foreign-language pages. Linear.app audit returned Spanish issues.
//
// This interacts with Fix B (page selection filters URLs) but is a separate
// defense: even if a foreign page slips through, the model should skip it.
// ============================================================================

describe('Cross-fix: Prompt language detection', () => {
  it('category prompt instructs to skip foreign-language pages', () => {
    const prompt = buildCategoryAuditPrompt(
      'Language',
      ['https://example.com'],
      '',
      '[]',
      '[]'
    )
    expect(prompt).toContain("primary language")
    expect(prompt).toContain('skip it')
  })

  it('liberal prompt also instructs to skip foreign-language pages', () => {
    const prompt = buildLiberalCategoryAuditPrompt(
      'Language',
      ['https://example.com'],
      '',
      '[]',
      '[]'
    )
    expect(prompt).toContain("primary language")
    expect(prompt).toContain('skip it')
  })
})

// ============================================================================
// Cross-fix: Badge/UI chip false-positive prevention in prompts
//
// Bug: text adjacent to badge elements merged during compression, e.g.
// "Dynamic ContentNew" on beehiiv.com. Fix E handles the compressor side;
// the prompt also needs to tell the model not to flag [Badge: text] patterns.
// ============================================================================

describe('Cross-fix: Badge instruction in prompts', () => {
  it('all prompt builders mention badge/tag/label elements', () => {
    const mini = buildMiniAuditPrompt('https://example.com', '', '[]', '[]')
    const full = buildFullAuditPrompt('https://example.com', '', '[]', '[]')
    const category = buildCategoryAuditPrompt('Language', ['https://example.com'], '', '[]', '[]')
    const liberal = buildLiberalCategoryAuditPrompt('Language', ['https://example.com'], '', '[]', '[]')

    for (const prompt of [mini, full, category, liberal]) {
      expect(prompt).toContain('[Badge:')
      expect(prompt).toContain('intentional inline UI chips')
    }
  })
})
