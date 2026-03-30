/**
 * Tests for the two-pass model checker (liberal prompt + checker pass).
 *
 * Three areas:
 * 1. buildLiberalCategoryAuditPrompt — recall-optimized prompt content
 * 2. buildCheckerPrompt — category-specific verification criteria
 * 3. applyCheckerDecisions — filtering logic (mirrored pure fn, no API calls)
 */

import { buildLiberalCategoryAuditPrompt, buildCheckerPrompt, buildCategoryAuditPrompt } from '../audit-prompts'
import { applyCheckerDecisions, type RawIssue, type CheckerVerification } from '../checker-decisions'

// Type alias for backwards compatibility with test code
type Verification = CheckerVerification

// ============================================================================
// 1. Liberal prompt: optimized for recall
// ============================================================================

describe('buildLiberalCategoryAuditPrompt — recall orientation', () => {
  const urls = ['https://example.com', 'https://example.com/about']
  const manifest = ''
  const noExcluded = '[]'
  const noActive = '[]'

  it('instructs model to include when in doubt', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(prompt).toContain('when in doubt, include')
  })

  it('mentions that a checker verifies everything', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(prompt).toContain('checker verifies everything')
  })

  it('does NOT include the foreign-language guardrail (let checker decide intent)', () => {
    // The precision prompt has this; liberal prompt intentionally omits it
    const liberalPrompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    const precisionPrompt = buildCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(precisionPrompt).toContain('Do not flag intentional foreign-language content')
    expect(liberalPrompt).not.toContain('Do not flag intentional foreign-language content')
  })

  it('returns flat issues array format (no total_issues/pages_with_issues in output spec)', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    // Output spec should be just an issues array, not summary counts
    expect(prompt).toContain('"issues": [...]')
    expect(prompt).not.toContain('total_issues')
    expect(prompt).not.toContain('pages_with_issues')
  })

  it('instructs specificity over word count caps', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    // No word count cap — replaced with structural clarity instructions
    expect(prompt).not.toContain('words or fewer')
    expect(prompt).toContain('quote the exact text')
    expect(prompt).toContain('Be specific')
  })

  it('instructs model to report the same issue on each page it appears', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(prompt).toContain('Report the same issue on each page it appears')
  })

  it('mentions severity defaults to medium', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(prompt).toContain('default')
    expect(prompt).toContain('"medium"')
  })

  it('still excludes link issues (link validation is a separate system)', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(prompt).toContain('Do NOT check or report ANY link issues')
  })

  it('still includes responsive duplicates instruction (class-attr-free version)', () => {
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, noExcluded, noActive)
    expect(prompt).toContain('RESPONSIVE DUPLICATES')
    // Class attributes are stripped from HTML, so Tailwind class examples are no longer in the prompt.
    // The instruction now uses structural clues (two nav elements, repeated sections).
    expect(prompt).toContain('Two <nav> elements')
    expect(prompt).not.toContain('hidden md:flex')
  })

  it('injects ignore keywords block when provided', () => {
    const prompt = buildLiberalCategoryAuditPrompt(
      'Language', urls, manifest, noExcluded, noActive,
      ['SaaS', 'omnichannel']
    )
    expect(prompt).toContain('Allowed Terms')
    expect(prompt).toContain('SaaS')
    expect(prompt).toContain('omnichannel')
  })

  it('injects flag keywords block when provided', () => {
    const prompt = buildLiberalCategoryAuditPrompt(
      'Language', urls, manifest, noExcluded, noActive,
      [], ['synergy', 'leverage']
    )
    expect(prompt).toContain('Flag Keywords')
    expect(prompt).toContain('synergy')
  })

  it('injects excluded issues block when provided', () => {
    const excluded = JSON.stringify([{ page_url: 'https://example.com', category: 'Language', issue_description: 'test' }])
    const prompt = buildLiberalCategoryAuditPrompt('Language', urls, manifest, excluded, noActive)
    expect(prompt).toContain('Previously Resolved/Ignored Issues')
    expect(prompt).toContain('DO NOT report these again')
  })

  it('targets all three categories with correct focus blocks', () => {
    for (const category of ['Language', 'Facts & Consistency', 'Formatting'] as const) {
      const prompt = buildLiberalCategoryAuditPrompt(category, urls, manifest, noExcluded, noActive)
      expect(prompt).toContain(`auditing for ${category} issues ONLY`)
    }
  })
})

// ============================================================================
// 2. Checker prompt: category-specific verification criteria
// ============================================================================

describe('buildCheckerPrompt — skeptical quality gate', () => {
  const snippetsText = '## Page: https://example.com\n\n<p>Hello world</p>\n\n---\n\n'
  const issues = [
    { category: 'Language', issue_description: 'professionalism: "recieve" in hero — misspelled', page_url: 'https://example.com' },
    { category: 'Language', issue_description: 'clarity: missing period in footer CTA', page_url: 'https://example.com' },
  ]
  const category = 'Language'

  it('frames itself as the final quality gate', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('final quality gate')
    expect(prompt).toContain('Be skeptical')
  })

  it('requires clear HTML evidence', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('HTML evidence')
  })

  it('includes the passed snippet content', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('<p>Hello world</p>')
  })

  it('tells checker it has the same HTML the auditor reviewed', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('same HTML the auditor reviewed')
  })

  it('still outputs uncertain as a valid value', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('"uncertain"')
  })

  it('lists all issues with their indices', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('0. [Language]')
    expect(prompt).toContain('1. [Language]')
    expect(prompt).toContain(issues[0].issue_description)
    expect(prompt).toContain(issues[1].issue_description)
  })

  it('includes "uncertain" as a valid output value', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('"uncertain"')
  })

  it('asks for severity in output (checker assigns final severity)', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('"severity"')
  })

  it('asks for evidence snippet in output', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, category)
    expect(prompt).toContain('"evidence"')
  })

  it('uses Language-specific verification criteria when category is Language', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, 'Language')
    expect(prompt).toContain('exact quoted text exists in the HTML')
    expect(prompt).toContain('claimed error')
    expect(prompt).toContain('stylistic choices')
    expect(prompt).toContain('Regional spelling')
  })

  it('uses Facts-specific verification criteria when category is Facts & Consistency', () => {
    const factsIssues = [{ category: 'Facts & Consistency', issue_description: 'credibility: "100 users" vs "1000 users"' }]
    const prompt = buildCheckerPrompt(snippetsText, factsIssues, 'Facts & Consistency')
    expect(prompt).toContain('internal consistency')
    expect(prompt).toContain('not external facts')
    expect(prompt).toContain('Cross-page contradictions')
  })

  it('uses Formatting-specific verification criteria when category is Formatting', () => {
    const fmtIssues = [{ category: 'Formatting', issue_description: 'accessibility: image missing alt text in hero' }]
    const prompt = buildCheckerPrompt(snippetsText, fmtIssues, 'Formatting')
    expect(prompt).toContain('HTML structure supports the claim')
    expect(prompt).toContain('uncertain')
  })

  it('uses a generic fallback for unknown category', () => {
    const prompt = buildCheckerPrompt(snippetsText, issues, 'Unknown')
    expect(prompt).toContain('final quality gate')
    expect(prompt).toContain('clear supporting evidence')
  })
})

// ============================================================================
// 3. Checker filtering logic
// The decision tree that determines which issues survive the checker pass.
// This is the critical efficacy logic — wrong filtering = wrong results shown to users.
// ============================================================================

describe('applyCheckerDecisions — filtering logic', () => {
  const baseIssue = (override?: Partial<RawIssue>): RawIssue => ({
    page_url: 'https://example.com',
    category: 'Language',
    issue_description: 'professionalism: "recieve" in hero',
    severity: 'medium',
    suggested_fix: 'Change to "receive".',
    ...override,
  })

  it('keeps confirmed=true issues', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.95, evidence: '<p>recieve</p>' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(1)
    expect(result[0].issue_description).toBe(issues[0].issue_description)
  })

  it('drops confirmed=false issues', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: false, confidence: 0.9, evidence: 'text not found' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(0)
  })

  it('keeps uncertain issues with confidence >= 0.7', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: 'uncertain', confidence: 0.7, evidence: 'maybe' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(1)
  })

  it('keeps uncertain issues with confidence > 0.7', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: 'uncertain', confidence: 0.85, evidence: 'possibly' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(1)
  })

  it('drops uncertain issues with confidence < 0.7', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: 'uncertain', confidence: 0.69, evidence: 'not sure' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(0)
  })

  it('drops uncertain issues with confidence exactly below threshold (0.69)', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: 'uncertain', confidence: 0.69, evidence: '' }]
    expect(applyCheckerDecisions(issues, verifications)).toHaveLength(0)
  })

  it('attaches evidence and confidence to passing issues', () => {
    const issues = [baseIssue()]
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.95, evidence: '<p>recieve</p>' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result[0].evidence).toBe('<p>recieve</p>')
    expect(result[0].confidence).toBe(0.95)
  })

  it('checker can upgrade severity (e.g. low → critical)', () => {
    const issues = [baseIssue({ severity: 'low' })]
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.9, severity: 'critical', evidence: 'found it' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result[0].severity).toBe('critical')
  })

  it('checker can downgrade severity (e.g. critical → low)', () => {
    const issues = [baseIssue({ severity: 'critical' })]
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.9, severity: 'low', evidence: 'minor' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result[0].severity).toBe('low')
  })

  it('keeps original severity when checker provides invalid value', () => {
    const issues = [baseIssue({ severity: 'medium' })]
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.9, severity: 'INVALID', evidence: '' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result[0].severity).toBe('medium')
  })

  it('keeps original severity when checker omits severity field', () => {
    const issues = [baseIssue({ severity: 'critical' })]
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.9, evidence: '' }]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result[0].severity).toBe('critical')
  })

  it('handles mixed batch: some pass, some fail', () => {
    const issues = [
      baseIssue({ issue_description: 'A' }),
      baseIssue({ issue_description: 'B' }),
      baseIssue({ issue_description: 'C' }),
    ]
    const verifications: Verification[] = [
      { index: 0, confirmed: true, confidence: 0.95, evidence: 'found A' },
      { index: 1, confirmed: false, confidence: 0.9, evidence: 'not found B' },
      { index: 2, confirmed: 'uncertain', confidence: 0.8, evidence: 'maybe C' },
    ]
    const result = applyCheckerDecisions(issues, verifications)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.issue_description)).toEqual(['A', 'C'])
  })

  it('drops issues when no verification found for an index (fail-safe default)', () => {
    // Fix A: Missing verification → confirmed defaults to false (fail-safe), confidence to 0.5.
    // Previously defaulted to true, which let unverified issues through.
    const issues = [baseIssue()]
    const result = applyCheckerDecisions(issues, []) // no verifications at all
    expect(result).toHaveLength(0)
  })

  it('returns empty array when given empty issues', () => {
    expect(applyCheckerDecisions([], [])).toEqual([])
  })

  it('preserves all original issue fields on passing issues', () => {
    const issue = baseIssue({ page_url: 'https://foo.com', category: 'Facts & Consistency', suggested_fix: 'Fix it.' })
    const verifications: Verification[] = [{ index: 0, confirmed: true, confidence: 0.99, evidence: 'proof' }]
    const result = applyCheckerDecisions([issue], verifications)
    expect(result[0].page_url).toBe('https://foo.com')
    expect(result[0].category).toBe('Facts & Consistency')
    expect(result[0].suggested_fix).toBe('Fix it.')
  })
})
