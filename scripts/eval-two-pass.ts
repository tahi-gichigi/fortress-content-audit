/**
 * eval-two-pass.ts
 *
 * Evaluation harness: compares old audit pipeline (precision prompt + regex filter)
 * against new two-pass pipeline (liberal prompt + model checker).
 *
 * Run with: npx tsx scripts/eval-two-pass.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as fs from 'fs'
import { extractWithFirecrawl, formatFirecrawlForPrompt, formatPagesForChecker, getAuditedUrls, type AuditManifest } from '../lib/firecrawl-adapter'
import { buildCategoryAuditPrompt, buildLiberalCategoryAuditPrompt, buildCheckerPrompt } from '../lib/audit-prompts'
import { createTracedOpenAIClient } from '../lib/langsmith-openai'
import { applyCheckerDecisions, type RawIssue, type CheckerVerification } from '../lib/checker-decisions'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVAL_SITES = [
  'https://secondhome.io',
  'https://justcancel.io',
  'https://youform.com',
  'https://seline.so',
]

const CATEGORIES: Array<'Language' | 'Facts & Consistency' | 'Links & Formatting'> = [
  'Language',
  'Facts & Consistency',
  'Links & Formatting',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SiteMetrics {
  site: string
  pagesAudited: number
  old: {
    raw: number
    filtered: number
    dropRate: number
  }
  new: {
    raw: number
    filtered: number
    dropRate: number
    avgConfidence: number
    confHistogram: { '0.7-0.79': number; '0.8-0.89': number; '0.9+': number }
  }
  newDiscoveries: any[]
  droppedByChecker: any[]
  stable: any[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Inlined verifyIssuesAgainstHtml (not exported from lib/audit.ts)
// ---------------------------------------------------------------------------

function verifyIssuesAgainstHtml(issues: any[], manifest: AuditManifest): any[] {
  const htmlByUrl = new Map<string, string>()
  for (const page of manifest.pages) {
    if (page.html) htmlByUrl.set(page.url, page.html.toLowerCase())
  }
  const verified: any[] = []
  for (const issue of issues) {
    const quotedStrings = [...issue.issue_description.matchAll(/['"]([^'"]{3,})['"]/g)].map((m: RegExpMatchArray) => m[1])
    if (quotedStrings.length === 0) { verified.push(issue); continue }
    const rawPageHtml = htmlByUrl.get(issue.page_url)
    if (!rawPageHtml) { verified.push(issue); continue }
    const pageHtml = rawPageHtml.replace(/<!--[\s\S]*?-->/g, '')
    const existsInHtml = (qs: string): boolean => {
      const escaped = qs.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(?:^|[\\s>/"'\\t])${escaped}(?:$|[\\s</"'\\t.,;:!?)])`, 'i')
      return regex.test(pageHtml)
    }
    if (quotedStrings.every(existsInHtml)) verified.push(issue)
  }
  return verified
}

// ---------------------------------------------------------------------------
// runCheckerPassLocal — calls the checker model per page
// ---------------------------------------------------------------------------

async function runCheckerPassLocal(issues: any[], manifest: AuditManifest, openai: any): Promise<any[]> {
  if (issues.length === 0) return []

  // Group issues by category — gives checker cross-page visibility
  const byCategory = new Map<string, any[]>()
  for (const issue of issues) {
    const list = byCategory.get(issue.category) || []
    list.push(issue)
    byCategory.set(issue.category, list)
  }

  const BATCH_SIZE = 50

  const categoryResults = await Promise.all(Array.from(byCategory.entries()).map(async ([category, categoryIssues]) => {
    // Collect pages with issues in this category — checker gets same full HTML as auditor
    const pageUrls = new Set<string>(categoryIssues.map((i: any) => i.page_url))
    const htmlContext = formatPagesForChecker(manifest, pageUrls)
    console.log(`  [checker] ${category}: ${categoryIssues.length} issues across ${pageUrls.size} pages`)

    // Batch if >50 issues
    const batches: any[][] = []
    for (let i = 0; i < categoryIssues.length; i += BATCH_SIZE) {
      batches.push(categoryIssues.slice(i, i + BATCH_SIZE))
    }

    const batchResults = await Promise.all(batches.map(async (batchIssues) => {
      const prompt = buildCheckerPrompt(htmlContext, batchIssues, category)

      // ~150 tokens per verification entry; floor at 4000, cap at 16000
      const maxOutputTokens = Math.min(16000, Math.max(4000, batchIssues.length * 150))

      let response: any
      try {
        response = await openai.responses.create({
          model: 'gpt-5.1-2025-11-13',
          input: prompt,
          max_output_tokens: maxOutputTokens,
          text: { format: { type: 'text' } },
          reasoning: { effort: 'low', summary: null },
          store: true,
        })
      } catch (err) {
        console.error(`  [checker] API error for ${category}:`, err)
        return batchIssues.map((i: any) => ({ ...i, evidence: 'Checker failed', confidence: 0.5 }))
      }

      // Poll for async responses (gpt-5.1 may queue)
      let finalResponse = response
      let status = response.status as string
      let attempts = 0
      while ((status === 'queued' || status === 'in_progress') && attempts < 120) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        finalResponse = await openai.responses.retrieve(response.id)
        status = finalResponse.status as string
        attempts++
      }

      if (status === 'queued' || status === 'in_progress') {
        console.error(`  [polling timeout] after ${attempts}s, status still: ${status}`)
        return batchIssues.map((i: any) => ({ ...i, evidence: 'Polling timeout', confidence: 0.5 }))
      }

      const outputText = (finalResponse.output_text || '').trim()
      let verifications: CheckerVerification[] = []
      try {
        const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const parsed = JSON.parse(cleaned)
        verifications = parsed?.verifications || []
      } catch (err) {
        console.error(`  [parse error in checker for ${category}] ${err}\n  Output: ${outputText.substring(0, 300)}`)
        return batchIssues.map((i: any) => ({ ...i, evidence: 'Parse error', confidence: 0.5 }))
      }

      return applyCheckerDecisions(batchIssues as RawIssue[], verifications)
    }))

    return batchResults.flat()
  }))

  return categoryResults.flat()
}

// ---------------------------------------------------------------------------
// runCategoryAudit — runs one precision or liberal prompt and parses JSON
// ---------------------------------------------------------------------------

async function runCategoryAudit(prompt: string, openai: any): Promise<any[]> {
  const response = await openai.responses.create({
    model: 'gpt-5.1-2025-11-13',
    input: prompt,
    max_output_tokens: 8000,
    text: { format: { type: 'text' } },
    reasoning: { effort: 'low', summary: null },
    store: true,
  })

  // Poll if response is async
  let finalResponse = response
  let status = response.status as string
  let attempts = 0
  while ((status === 'queued' || status === 'in_progress') && attempts < 240) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    finalResponse = await openai.responses.retrieve(response.id)
    status = finalResponse.status as string
    attempts++
  }

  if (status === 'queued' || status === 'in_progress') {
    console.error(`  [polling timeout] after ${attempts}s, status still: ${status}`)
    return []
  }

  const outputText = (finalResponse.output_text || '').trim()
  try {
    const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned)
    return parsed?.issues || []
  } catch (err) {
    console.error(`  [parse error in category audit] ${err}\n  Output: ${outputText.substring(0, 300)}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Issue matching — compare by page_url + description word overlap
// ---------------------------------------------------------------------------

function issuesMatch(a: any, b: any): boolean {
  if (a.page_url !== b.page_url) return false
  const shorter = a.issue_description.length < b.issue_description.length ? a.issue_description : b.issue_description
  const longer = a.issue_description.length >= b.issue_description.length ? a.issue_description : b.issue_description
  const words = shorter.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3)
  if (words.length === 0) return false
  const longerWords = new Set(longer.toLowerCase().split(/\s+/))
  const matchCount = words.filter((w: string) => longerWords.has(w)).length
  return matchCount / words.length >= 0.6
}

// ---------------------------------------------------------------------------
// Compute confidence histogram
// ---------------------------------------------------------------------------

function buildConfHistogram(issues: any[]): { '0.7-0.79': number; '0.8-0.89': number; '0.9+': number } {
  const hist = { '0.7-0.79': 0, '0.8-0.89': 0, '0.9+': 0 }
  for (const issue of issues) {
    const c = issue.confidence ?? 0
    if (c >= 0.9) hist['0.9+']++
    else if (c >= 0.8) hist['0.8-0.89']++
    else if (c >= 0.7) hist['0.7-0.79']++
  }
  return hist
}

// ---------------------------------------------------------------------------
// Per-site evaluation
// ---------------------------------------------------------------------------

async function evalSite(domain: string, openai: any): Promise<SiteMetrics> {
  const warnings: string[] = []

  console.log(`\n${'═'.repeat(42)}`)
  console.log(`Site: ${domain}`)
  console.log('═'.repeat(42))

  // Step 1: crawl once
  console.log('  Crawling...')
  let manifest: AuditManifest
  try {
    manifest = await extractWithFirecrawl(domain, 'PAID')
  } catch (err) {
    console.error(`  Crawl failed: ${err}`)
    // Return empty metrics so the harness continues to next site
    return {
      site: domain,
      pagesAudited: 0,
      old: { raw: 0, filtered: 0, dropRate: 0 },
      new: { raw: 0, filtered: 0, dropRate: 0, avgConfidence: 0, confHistogram: { '0.7-0.79': 0, '0.8-0.89': 0, '0.9+': 0 } },
      newDiscoveries: [],
      droppedByChecker: [],
      stable: [],
      warnings: ['Crawl failed — site skipped'],
    }
  }

  const manifestText = formatFirecrawlForPrompt(manifest)
  const urlsToAudit = getAuditedUrls(manifest)
  const pagesAudited = urlsToAudit.length

  console.log(`  ${pagesAudited} pages audited`)

  // Log HTML truncation info
  for (const page of manifest.pages) {
    if (page.html && page.html.length > 30000) {
      console.log(`  [HTML truncation] ${page.url}: ${page.html.length} chars — checker sees truncated HTML`)
    }
  }

  // Log link validation passthrough
  if (manifest.linkValidationIssues && manifest.linkValidationIssues.length > 0) {
    console.log(`  Link validation issues (bypass checker): ${manifest.linkValidationIssues.length}`)
  }

  // Step 2: run all 6 category prompts in parallel (3 old + 3 new)
  console.log('  Running audit prompts (old + new, all categories in parallel)...')

  const oldPrompts = CATEGORIES.map(cat =>
    buildCategoryAuditPrompt(cat, urlsToAudit, manifestText, '', '')
  )
  const newPrompts = CATEGORIES.map(cat =>
    buildLiberalCategoryAuditPrompt(cat, urlsToAudit, manifestText, '', '')
  )

  const [oldRawResults, newRawResults] = await Promise.all([
    Promise.all(oldPrompts.map(p => runCategoryAudit(p, openai))),
    Promise.all(newPrompts.map(p => runCategoryAudit(p, openai))),
  ])

  const oldRaw = oldRawResults.flat()
  const newRaw = newRawResults.flat()

  console.log(`  Old raw: ${oldRaw.length} | New raw: ${newRaw.length}`)

  // Step 3: filter both pipelines
  const oldFiltered = verifyIssuesAgainstHtml(oldRaw, manifest)
  const newFiltered = await runCheckerPassLocal(newRaw, manifest, openai)

  console.log(`  Old filtered: ${oldFiltered.length} | New filtered: ${newFiltered.length}`)

  // Step 4: compute metrics
  const oldDropRate = oldRaw.length > 0 ? 1 - oldFiltered.length / oldRaw.length : 0
  const newDropRate = newRaw.length > 0 ? 1 - newFiltered.length / newRaw.length : 0

  const avgConfidence = newFiltered.length > 0
    ? newFiltered.reduce((sum: number, i: any) => sum + (i.confidence ?? 0), 0) / newFiltered.length
    : 0

  const confHistogram = buildConfHistogram(newFiltered)

  // Step 5: diff
  const newDiscoveries = newFiltered.filter((ni: any) => !oldFiltered.some((oi: any) => issuesMatch(oi, ni)))
  const droppedByChecker = oldFiltered.filter((oi: any) => !newFiltered.some((ni: any) => issuesMatch(oi, ni)))
  const stable = oldFiltered.filter((oi: any) => newFiltered.some((ni: any) => issuesMatch(oi, ni)))

  // Step 6: edge case checks
  if (newFiltered.length === 0 && pagesAudited > 0) {
    warnings.push('filtered_new=0 on a real site — suspicious')
  }
  if (newDropRate >= 0.9) {
    warnings.push(`drop_rate_new=${newDropRate.toFixed(2)} — checker may be overcorrecting`)
  }
  if (newDropRate === 0 && newRaw.length > 0) {
    warnings.push('drop_rate_new=0 — checker did nothing (liberal=precision?)')
  }
  if (avgConfidence < 0.6 && newFiltered.length > 0) {
    warnings.push(`avg_confidence=${avgConfidence.toFixed(2)} — systematically uncertain`)
  }
  // Step 7: print summary for this site
  console.log(`\n${'═'.repeat(42)}`)
  console.log(`Site: ${domain} (${pagesAudited} pages)`)
  console.log('═'.repeat(42))
  console.log(`\nOLD pipeline:  ${oldRaw.length} raw → ${oldFiltered.length} filtered  (${(oldDropRate * 100).toFixed(0)}% drop, regex)`)
  console.log(`NEW pipeline:  ${newRaw.length} raw → ${newFiltered.length} filtered (${(newDropRate * 100).toFixed(0)}% drop, checker)`)
  console.log(`\nAvg confidence:  ${avgConfidence.toFixed(2)}`)
  console.log(`Conf histogram:  0.7-0.79: ${confHistogram['0.7-0.79']} | 0.8-0.89: ${confHistogram['0.8-0.89']} | 0.9+: ${confHistogram['0.9+']}`)
  console.log(`\nNew discoveries (in new, not old):   ${newDiscoveries.length} issues`)
  newDiscoveries.slice(0, 5).forEach((issue: any, idx: number) => {
    console.log(`  ${idx + 1}. [${issue.category}/${issue.severity}/${(issue.confidence ?? 0).toFixed(2)}] ${issue.issue_description}`)
    if (issue.evidence) console.log(`     Evidence: ${issue.evidence}`)
  })
  console.log(`Dropped by checker (in old, not new): ${droppedByChecker.length} issues`)
  droppedByChecker.slice(0, 5).forEach((issue: any, idx: number) => {
    console.log(`  ${idx + 1}. [${issue.category}] ${issue.issue_description}`)
  })
  console.log(`Stable (in both): ${stable.length} issues`)

  for (const w of warnings) {
    console.log(`\n⚠ WARNING: ${w}`)
  }

  return {
    site: domain,
    pagesAudited,
    old: {
      raw: oldRaw.length,
      filtered: oldFiltered.length,
      dropRate: oldDropRate,
    },
    new: {
      raw: newRaw.length,
      filtered: newFiltered.length,
      dropRate: newDropRate,
      avgConfidence,
      confHistogram,
    },
    newDiscoveries,
    droppedByChecker,
    stable,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const openai = createTracedOpenAIClient()
  const results: SiteMetrics[] = []

  // Run sites sequentially to avoid rate limits
  for (const site of EVAL_SITES) {
    try {
      const metrics = await evalSite(site, openai)
      results.push(metrics)
    } catch (err) {
      console.error(`\nUnhandled error for ${site}:`, err)
      results.push({
        site,
        pagesAudited: 0,
        old: { raw: 0, filtered: 0, dropRate: 0 },
        new: { raw: 0, filtered: 0, dropRate: 0, avgConfidence: 0, confHistogram: { '0.7-0.79': 0, '0.8-0.89': 0, '0.9+': 0 } },
        newDiscoveries: [],
        droppedByChecker: [],
        stable: [],
        warnings: [`Unhandled error: ${String(err)}`],
      })
    }
  }

  // Aggregate summary
  const validResults = results.filter(r => r.pagesAudited > 0)
  const summary = {
    totalSites: results.length,
    avgDropRateOld: validResults.length > 0
      ? validResults.reduce((s, r) => s + r.old.dropRate, 0) / validResults.length
      : 0,
    avgDropRateNew: validResults.length > 0
      ? validResults.reduce((s, r) => s + r.new.dropRate, 0) / validResults.length
      : 0,
    avgConfidence: validResults.length > 0
      ? validResults.reduce((s, r) => s + r.new.avgConfidence, 0) / validResults.length
      : 0,
    totalNewDiscoveries: results.reduce((s, r) => s + r.newDiscoveries.length, 0),
    totalDroppedByChecker: results.reduce((s, r) => s + r.droppedByChecker.length, 0),
  }

  // Final summary block
  console.log(`\n${'═'.repeat(42)}`)
  console.log('LangSmith traces — check manually:')
  console.log('  Project: aicontentaudit')
  console.log('  Expected: 3 audit calls + 3 checker calls per site (one per category)')
  console.log('  URL: https://smith.langchain.com/o/[org]/projects/aicontentaudit')
  console.log('═'.repeat(42))

  // Save JSON
  const timestamp = Date.now()
  const outputPath = `eval-results-${timestamp}.json`
  fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), sites: results, summary }, null, 2))
  console.log(`Results saved to: ${outputPath}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
