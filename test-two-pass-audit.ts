/**
 * Two-pass audit test: compares HTML vs markdown audit input formats.
 * Pass 1 (Audit): gpt-5.2, no reasoning, 3 categories in parallel
 * Pass 2 (Checker): gpt-5.2, low reasoning, grouped by page
 * Metrics: tokens, cost, time, issues before/after check, drop rate, confidence
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import * as fs from 'fs'
config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import {
  extractWithFirecrawl,
  formatFirecrawlForPrompt,
  formatFirecrawlForPromptMarkdown,
  getAuditedUrls,
  type AuditManifest,
} from './lib/firecrawl-adapter'
import { buildCategoryAuditPrompt } from './lib/audit-prompts'
import { createTracedOpenAIClient } from './lib/langsmith-openai'

const MODEL = 'gpt-5.2'
const SITES = ['https://secondhome.io', 'https://justcancel.io', 'https://youform.com']

// ── Types ──────────────────────────────────────────────────────────────────

interface RawIssue {
  page_url: string
  category: string
  issue_description: string
  severity: string
  suggested_fix: string
}

interface VerifiedIssue extends RawIssue {
  confirmed: boolean
  confidence: number
  evidence: string
}

interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0 }
}

interface VariantResult {
  format: 'html' | 'markdown'
  auditDurationMs: number
  checkerDurationMs: number
  auditTokens: TokenUsage
  checkerTokens: TokenUsage
  auditCostUsd: number
  checkerCostUsd: number
  rawIssues: RawIssue[]
  verifiedIssues: VerifiedIssue[]
}

interface SiteResult {
  domain: string
  pagesAudited: number
  crawlDurationMs: number
  variantA: VariantResult
  variantB: VariantResult
}

// ── Audit Pass ─────────────────────────────────────────────────────────────

const CATEGORIES = ['Language', 'Facts & Consistency', 'Links & Formatting'] as const
type Category = typeof CATEGORIES[number]

async function runAuditPass(
  manifestText: string,
  pagesToAudit: string[],
  domain: string,
  format: 'html' | 'markdown'
): Promise<{ issues: RawIssue[]; tokens: TokenUsage; costUsd: number; durationMs: number }> {
  const openai = createTracedOpenAIClient({ apiKey: process.env.OPENAI_API_KEY, timeout: 450000 })
  const domainHostname = new URL(domain.startsWith('http') ? domain : `https://${domain}`).hostname
  const startTime = Date.now()

  const categoryPromises = CATEGORIES.map(async (category: Category) => {
    const promptText = buildCategoryAuditPrompt(category, pagesToAudit, manifestText, '[]', '[]')

    const params: any = {
      model: MODEL,
      input: promptText,
      tools: [{ type: 'web_search', filters: { allowed_domains: [domainHostname] } }],
      max_tool_calls: 15,
      max_output_tokens: 20000,
      include: ['web_search_call.action.sources'],
      text: { format: { type: 'text' }, verbosity: 'low' },
      // No reasoning for audit pass — if API rejects null, will be caught and retried
      reasoning: null,
      store: true,
    }

    let response: any
    try {
      response = await openai.responses.create(params)
    } catch (err: any) {
      // If reasoning:null is rejected, retry with lowest effort
      if (err?.message?.includes('reasoning') || err?.status === 400) {
        console.log(`  [${format}/${category}] reasoning:null rejected, retrying with effort:low`)
        params.reasoning = { effort: 'low', summary: null }
        response = await openai.responses.create(params)
      } else {
        throw err
      }
    }

    // Poll for completion — Responses API is async when using web_search tool
    let finalResponse = response
    let status = response.status as string
    let attempts = 0
    const maxAttempts = 300 // 5 minutes max
    while ((status === 'queued' || status === 'in_progress') && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      finalResponse = await openai.responses.retrieve(response.id)
      status = finalResponse.status as string
      attempts++
    }
    if (status !== 'completed' && status !== 'incomplete') {
      console.warn(`  [${format}/${category}] final status: ${status} — 0 issues`)
      return { issues: [], inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cost: 0 }
    }

    const outputText = finalResponse.output_text || ''
    // Responses API uses .usage (not .usage_metadata which is LangSmith-side)
    const usage = (finalResponse as any).usage || {}

    let issues: RawIssue[] = []
    try {
      const trimmed = outputText.trim()
      if (trimmed && trimmed !== 'null') {
        // Strip markdown code fences if present
        const cleaned = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const parsed = JSON.parse(cleaned)
        if (parsed?.issues) issues = parsed.issues
      }
    } catch {
      console.warn(`  [${format}/${category}] JSON parse failed — raw output: ${outputText.substring(0, 200)}`)
    }

    const inputTokens: number = usage.input_tokens || 0
    const outputTokens: number = usage.output_tokens || 0
    const reasoningTokens: number = usage.output_tokens_details?.reasoning_tokens || usage.output_token_details?.reasoning || 0
    const cacheReadTokens: number = usage.input_tokens_details?.cached_tokens || usage.input_token_details?.cache_read || 0

    console.log(`  [${format}/${category}] ${issues.length} issues | in:${inputTokens} out:${outputTokens} reasoning:${reasoningTokens}`)

    return { issues, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cost: 0 }
  })

  const results = await Promise.allSettled(categoryPromises)
  const allIssues: RawIssue[] = []
  const totalTokens = emptyTokens()
  let totalCost = 0

  for (const r of results) {
    if (r.status === 'fulfilled') {
      allIssues.push(...r.value.issues)
      totalTokens.input += r.value.inputTokens
      totalTokens.output += r.value.outputTokens
      totalTokens.reasoning += r.value.reasoningTokens
      totalTokens.cacheRead += r.value.cacheReadTokens
      totalCost += r.value.cost
    } else {
      console.warn(`  [${format}] category failed:`, r.reason)
    }
  }

  return { issues: allIssues, tokens: totalTokens, costUsd: totalCost, durationMs: Date.now() - startTime }
}

// ── Checker Pass ───────────────────────────────────────────────────────────

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg([^>]*)>[\s\S]*?<\/svg>/gi, (_m: string, attrs: string) => {
      const label = attrs.match(/aria-label="([^"]*)"/)?.[1]
      return label ? `<svg aria-label="${label}"/>` : '<svg/>'
    })
    .trim()
}

async function runCheckerPass(
  rawIssues: RawIssue[],
  manifest: AuditManifest
): Promise<{ issues: VerifiedIssue[]; tokens: TokenUsage; costUsd: number; durationMs: number }> {
  if (rawIssues.length === 0) {
    return { issues: [], tokens: emptyTokens(), costUsd: 0, durationMs: 0 }
  }

  const openai = createTracedOpenAIClient({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000 })

  // Build page HTML map (comments stripped — same as what audit model sees)
  const htmlByUrl = new Map<string, string>()
  for (const page of manifest.pages) {
    if (page.html) htmlByUrl.set(page.url, stripHtmlNoise(page.html))
  }

  // Group issues by page_url
  const byPage = new Map<string, RawIssue[]>()
  for (const issue of rawIssues) {
    const list = byPage.get(issue.page_url) || []
    list.push(issue)
    byPage.set(issue.page_url, list)
  }

  const startTime = Date.now()
  const totalTokens = emptyTokens()
  let totalCost = 0

  const pagePromises = Array.from(byPage.entries()).map(async ([pageUrl, pageIssues]) => {
    const pageHtml = htmlByUrl.get(pageUrl)
    if (!pageHtml) {
      // No HTML for this page — keep all issues confirmed at 0.5 confidence
      return pageIssues.map(issue => ({
        ...issue,
        confirmed: true,
        confidence: 0.5,
        evidence: 'Page HTML not available for verification',
      }))
    }

    const truncatedHtml = pageHtml.length > 20000
      ? pageHtml.substring(0, pageHtml.lastIndexOf('>', 20000)) + '\n[truncated]'
      : pageHtml

    const issueList = pageIssues
      .map((issue, i) => `${i}. [${issue.category}] ${issue.issue_description}`)
      .join('\n')

    const prompt = `You are verifying content audit findings against the actual HTML source.

For each issue below, examine the page HTML and determine:
- confirmed: true if you find clear supporting evidence in the HTML
- confirmed: false if you cannot find evidence or the claim appears incorrect
- confidence: 0.0-1.0 (how certain you are)
- evidence: brief quote from the HTML that supports or refutes the finding

Be skeptical. Only confirm true if the evidence is unambiguous.

Page: ${pageUrl}

HTML:
${truncatedHtml}

Issues to verify:
${issueList}

Return ONLY valid JSON in this exact format with no other text:
{
  "verifications": [
    {"index": 0, "confirmed": true, "confidence": 0.95, "evidence": "quote from HTML"},
    {"index": 1, "confirmed": false, "confidence": 0.9, "evidence": "text not found in HTML"}
  ]
}`

    const params: any = {
      model: MODEL,
      input: prompt,
      max_output_tokens: 4000,
      text: { format: { type: 'text' } },
      reasoning: { effort: 'low', summary: null },
      store: true,
    }

    let response: any
    try {
      response = await openai.responses.create(params)
    } catch (err) {
      console.warn(`  [checker] page ${pageUrl} failed:`, err)
      return pageIssues.map(issue => ({
        ...issue, confirmed: true, confidence: 0.5, evidence: 'Checker call failed',
      }))
    }

    // Poll for completion
    let finalCheckerResponse = response
    let checkerStatus = response.status as string
    let checkerAttempts = 0
    while ((checkerStatus === 'queued' || checkerStatus === 'in_progress') && checkerAttempts < 120) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      finalCheckerResponse = await openai.responses.retrieve(response.id)
      checkerStatus = finalCheckerResponse.status as string
      checkerAttempts++
    }

    const outputText = (finalCheckerResponse.output_text || '').trim()
    const usage = (finalCheckerResponse as any).usage || {}
    totalTokens.input += usage.input_tokens || 0
    totalTokens.output += usage.output_tokens || 0
    totalTokens.reasoning += usage.output_tokens_details?.reasoning_tokens || usage.output_token_details?.reasoning || 0
    totalTokens.cacheRead += usage.input_tokens_details?.cached_tokens || usage.input_token_details?.cache_read || 0
    if (typeof response.total_cost === 'number') totalCost += response.total_cost

    let verifications: Array<{ index: number; confirmed: boolean; confidence: number; evidence: string }> = []
    try {
      // Strip markdown code fences if present
      const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(cleaned)
      verifications = parsed?.verifications || []
    } catch {
      console.warn(`  [checker] JSON parse failed for ${pageUrl} — keeping all issues`)
      return pageIssues.map(issue => ({
        ...issue, confirmed: true, confidence: 0.5, evidence: 'Checker parse error',
      }))
    }

    return pageIssues.map((issue, i) => {
      const v = verifications.find(v => v.index === i)
      return {
        ...issue,
        confirmed: v?.confirmed ?? true,
        confidence: v?.confidence ?? 0.5,
        evidence: v?.evidence ?? '',
      }
    })
  })

  const results = await Promise.allSettled(pagePromises)
  const allVerified: VerifiedIssue[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') allVerified.push(...r.value)
  }

  return { issues: allVerified, tokens: totalTokens, costUsd: totalCost, durationMs: Date.now() - startTime }
}

// ── Site Runner ────────────────────────────────────────────────────────────

async function runSite(domain: string): Promise<SiteResult> {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`Site: ${domain}`)
  console.log('='.repeat(70))

  // Step 1: Crawl (shared between variants)
  console.log('Crawling...')
  const crawlStart = Date.now()
  const manifest = await extractWithFirecrawl(domain, 'PAID')
  const crawlDurationMs = Date.now() - crawlStart
  const pagesToAudit = getAuditedUrls(manifest)
  console.log(`Crawled ${pagesToAudit.length} pages in ${(crawlDurationMs / 1000).toFixed(1)}s`)

  // Step 2: Build both manifest text formats
  const manifestHtml = formatFirecrawlForPrompt(manifest)
  const manifestMarkdown = formatFirecrawlForPromptMarkdown(manifest)
  console.log(`Manifest sizes — HTML: ${(manifestHtml.length / 1000).toFixed(0)}k chars | MD: ${(manifestMarkdown.length / 1000).toFixed(0)}k chars`)

  // Step 3: Run both audit passes in parallel
  console.log('\nRunning audit passes (HTML + Markdown in parallel)...')
  const [auditA, auditB] = await Promise.all([
    runAuditPass(manifestHtml, pagesToAudit, domain, 'html'),
    runAuditPass(manifestMarkdown, pagesToAudit, domain, 'markdown'),
  ])
  console.log(`Audit A (HTML): ${auditA.issues.length} raw issues in ${(auditA.durationMs / 1000).toFixed(1)}s`)
  console.log(`Audit B (MD):   ${auditB.issues.length} raw issues in ${(auditB.durationMs / 1000).toFixed(1)}s`)

  // Step 4: Run both checker passes in parallel
  console.log('\nRunning checker passes...')
  const [checkerA, checkerB] = await Promise.all([
    runCheckerPass(auditA.issues, manifest),
    runCheckerPass(auditB.issues, manifest),
  ])

  const verifiedA = checkerA.issues.filter(i => i.confirmed)
  const verifiedB = checkerB.issues.filter(i => i.confirmed)
  console.log(`Checker A: ${verifiedA.length}/${auditA.issues.length} confirmed in ${(checkerA.durationMs / 1000).toFixed(1)}s`)
  console.log(`Checker B: ${verifiedB.length}/${auditB.issues.length} confirmed in ${(checkerB.durationMs / 1000).toFixed(1)}s`)

  return {
    domain,
    pagesAudited: pagesToAudit.length,
    crawlDurationMs,
    variantA: {
      format: 'html',
      auditDurationMs: auditA.durationMs,
      checkerDurationMs: checkerA.durationMs,
      auditTokens: auditA.tokens,
      checkerTokens: checkerA.tokens,
      auditCostUsd: auditA.costUsd,
      checkerCostUsd: checkerA.costUsd,
      rawIssues: auditA.issues,
      verifiedIssues: verifiedA,
    },
    variantB: {
      format: 'markdown',
      auditDurationMs: auditB.durationMs,
      checkerDurationMs: checkerB.durationMs,
      auditTokens: auditB.tokens,
      checkerTokens: checkerB.tokens,
      auditCostUsd: auditB.costUsd,
      checkerCostUsd: checkerB.costUsd,
      rawIssues: auditB.issues,
      verifiedIssues: verifiedB,
    },
  }
}

// ── Output ─────────────────────────────────────────────────────────────────

function printVariantSummary(label: string, v: VariantResult) {
  const dropCount = v.rawIssues.length - v.verifiedIssues.length
  const dropRate = v.rawIssues.length > 0
    ? ((dropCount / v.rawIssues.length) * 100).toFixed(0)
    : '0'
  const auditTotal = v.auditTokens.input + v.auditTokens.output
  const checkerTotal = v.checkerTokens.input + v.checkerTokens.output
  const avgConf = v.verifiedIssues.length > 0
    ? (v.verifiedIssues.reduce((sum, i) => sum + i.confidence, 0) / v.verifiedIssues.length).toFixed(2)
    : 'n/a'

  console.log(`\n  ${label}`)
  console.log(`  Audit:    ${(v.auditDurationMs / 1000).toFixed(1)}s | tokens: ${auditTotal} (reasoning: ${v.auditTokens.reasoning}) | cost: $${v.auditCostUsd.toFixed(4)}`)
  console.log(`  Checker:  ${(v.checkerDurationMs / 1000).toFixed(1)}s | tokens: ${checkerTotal} (reasoning: ${v.checkerTokens.reasoning}) | cost: $${v.checkerCostUsd.toFixed(4)}`)
  console.log(`  Total:    tokens: ${auditTotal + checkerTotal} | cost: $${(v.auditCostUsd + v.checkerCostUsd).toFixed(4)}`)
  console.log(`  Issues:   ${v.rawIssues.length} raw → ${v.verifiedIssues.length} verified (${dropCount} dropped, ${dropRate}%)`)
  console.log(`  Avg conf: ${avgConf}`)
}

function printResults(results: SiteResult[]) {
  console.log(`\n${'='.repeat(70)}`)
  console.log('RESULTS SUMMARY')
  console.log('='.repeat(70))

  for (const r of results) {
    console.log(`\n── ${r.domain} (${r.pagesAudited} pages, crawl: ${(r.crawlDurationMs / 1000).toFixed(1)}s) ──`)
    printVariantSummary('Variant A — HTML audit + HTML checker', r.variantA)
    printVariantSummary('Variant B — Markdown audit + HTML checker', r.variantB)
  }

  // Print all verified issues per site
  console.log(`\n${'='.repeat(70)}`)
  console.log('VERIFIED ISSUES')
  console.log('='.repeat(70))

  for (const r of results) {
    for (const [label, v] of [['A (HTML audit)', r.variantA], ['B (Markdown audit)', r.variantB]] as [string, VariantResult][]) {
      console.log(`\n── ${r.domain} — ${label} ──`)
      if (v.verifiedIssues.length === 0) {
        console.log('  (no issues)')
        continue
      }
      v.verifiedIssues.forEach((issue, i) => {
        console.log(`  ${i + 1}. [${(issue.severity || 'N/A').toUpperCase()}] [${issue.category}] conf:${issue.confidence.toFixed(2)}`)
        console.log(`     ${issue.issue_description}`)
        console.log(`     Page: ${issue.page_url}`)
        if (issue.evidence) console.log(`     Evidence: ${issue.evidence.substring(0, 120)}`)
      })
    }
  }
}

// ── Entry Point ────────────────────────────────────────────────────────────

async function main() {
  console.log('Two-pass audit test')
  console.log(`Model: ${MODEL} | Sites: ${SITES.length}`)
  console.log(`Variants: HTML audit vs Markdown audit (both checked with HTML checker)\n`)

  const results: SiteResult[] = []
  for (const site of SITES) {
    const r = await runSite(site)
    results.push(r)
  }

  printResults(results)

  const filename = `test-two-pass-results-${Date.now()}.json`
  fs.writeFileSync(filename, JSON.stringify(results, null, 2))
  console.log(`\nSaved: ${filename}`)
}

main().catch(e => { console.error(e); process.exit(1) })
