/**
 * Tests for audit prompt quality (Cluster F: verbosity, location, label clarity)
 */

import { buildMiniAuditPrompt, buildFullAuditPrompt, buildCategoryAuditPrompt } from '../audit-prompts'

describe('audit prompt verbosity and quality', () => {
  const url = 'https://example.com'
  const manifest = ''
  const noExcluded = '[]'
  const noActive = '[]'

  it('mini audit prompt instructs model to name the location', () => {
    const prompt = buildMiniAuditPrompt(url, manifest, noExcluded, noActive)
    expect(prompt).toContain('name the section')
    expect(prompt).toContain('quote the specific text')
  })

  it('mini audit prompt specifies word limits', () => {
    const prompt = buildMiniAuditPrompt(url, manifest, noExcluded, noActive)
    expect(prompt).toContain('10 words or fewer')
    expect(prompt).toContain('8 words or fewer')
  })

  it('mini audit prompt disallows internal readability labels', () => {
    const prompt = buildMiniAuditPrompt(url, manifest, noExcluded, noActive)
    expect(prompt).toContain("never \"readability:\"")
    expect(prompt).toContain('clarity:')
    expect(prompt).toContain('accessibility:')
  })

  it('full audit prompt instructs model to name the location', () => {
    const prompt = buildFullAuditPrompt(url, manifest, noExcluded, noActive)
    expect(prompt).toContain('WHERE')
    expect(prompt).toContain('10 words or fewer')
  })

  it('full audit prompt disallows internal readability labels', () => {
    const prompt = buildFullAuditPrompt(url, manifest, noExcluded, noActive)
    expect(prompt).toContain("never \"readability:\"")
  })

  it('category prompt instructs model on location and word limits', () => {
    const prompt = buildCategoryAuditPrompt('Language', ['https://example.com'], manifest, noExcluded, noActive)
    expect(prompt).toContain('10 words or fewer')
    expect(prompt).toContain('8 words or fewer')
    expect(prompt).toContain("never \"readability:\"")
  })
})
