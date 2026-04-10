/**
 * compare-pipelines.ts - Head-to-head comparison of compressed HTML vs annotated text pipelines.
 *
 * Crawls a domain (or uses cached HTML), runs both extraction pipelines through
 * the same auditor + checker passes, then produces a grading-ready markdown file
 * with per-pipeline issue tables and a deduped union table for manual verdict.
 *
 * Usage:
 *   npx tsx scripts/compare-pipelines.ts secondhome.io
 *   npx tsx scripts/compare-pipelines.ts seline.so        # uses cached HTML if <24h old
 *
 * Output: docs/evals/YYYY-MM-DD-<domain>-comparison.md
 *
 * Requires: OPENAI_API_KEY, LANGSMITH_API_KEY, LANGSMITH_TRACING=true, FIRECRAWL_API_KEY
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

import { extractWithFirecrawl, formatFirecrawlForPrompt, formatPagesForChecker, getAuditedUrls, type AuditManifest } from '../lib/firecrawl-adapter'
import { buildLiberalCategoryAuditPrompt, buildCheckerPrompt } from '../lib/audit-prompts'
import { createTracedOpenAIClient } from '../lib/langsmith-openai'
import { applyCheckerDecisions, type RawIssue, type CheckerVerification } from '../lib/checker-decisions'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Word overlap threshold for deduplication. Two issues on the same page with
 *  >= this fraction of shared words are considered the same finding. */
const DEDUP_THRESHOLD = 0.6

const AUDIT_CATEGORIES = ['Language', 'Facts & Consistency', 'Formatting'] as const
const MODEL = 'gpt-5.1-2025-11-13'
const CACHE_DIR = path.join(__dirname, '.eval-cache')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditIssue {
  page_url: string
  category: string
  issue_description: string
  severity: string
  suggested_fix: string
  evidence?: string
  confidence?: number
}

interface PipelineResult {
  name: string
  issues: AuditIssue[]
  durationMs: number
  rawIssueCount: number
}

type PipelineMode = 'compressed-html' | 'annotated-text'

interface UnionRow {
  page_url: string
  category: string
  description: string
  foundBy: 'HTML only' | 'Text only' | 'Both'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseDomain(): string {
  const domain = process.argv[2]
  if (!domain) {
    console.error('Usage: npx tsx scripts/compare-pipelines.ts <domain>')
    console.error('Example: npx tsx scripts/compare-pipelines.ts secondhome.io')
    process.exit(1)
  }
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// Cache helpers (same format as eval-quality.ts)
// ---------------------------------------------------------------------------

function getCachePath(domain: string): string {
  return path.join(CACHE_DIR, `${domain.replace(/[^a-z0-9]/gi, '_')}.json`)
}

function loadCachedManifest(domain: string): AuditManifest | null {
  const cachePath = getCachePath(domain)
  if (!fs.existsSync(cachePath)) return null
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    // Fresh if less than 24h old
    if (Date.now() - cached.timestamp > 24 * 60 * 60 * 1000) {
      console.log(`  Cache expired for ${domain} (>24h old)`)
      return null
    }
    console.log(`  Using cached HTML for ${domain} (${new Date(cached.timestamp).toISOString()})`)
    return cached.manifest
  } catch {
    return null
  }
}

function saveCachedManifest(domain: string, manifest: AuditManifest): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(getCachePath(domain), JSON.stringify({ timestamp: Date.now(), manifest }, null, 2))
}

// ---------------------------------------------------------------------------
// Audit pipeline runner (auditor + checker, one mode at a time)
// ---------------------------------------------------------------------------

async function runPipeline(
  mode: PipelineMode,
  manifest: AuditManifest,
  domain: string,
  openai: any,
): Promise<PipelineResult> {
  const start = Date.now()
  const useAnnotatedText = mode === 'annotated-text'

  // Format the crawled content using the specified pipeline mode
  const manifestText = formatFirecrawlForPrompt(manifest, { useAnnotatedText })
  const urlsToAudit = getAuditedUrls(manifest)

  console.log(`\n  [${mode}] Running auditor on ${urlsToAudit.length} pages...`)

  // Set LangSmith tags via env for tracing. The wrapOpenAI client picks these up.
  process.env.LANGSMITH_TAGS = `pipeline:${mode},domain:${domain}`

  // Step 1: Liberal auditor pass - all 3 categories in parallel
  const auditorPromises = AUDIT_CATEGORIES.map(async (category) => {
    const prompt = buildLiberalCategoryAuditPrompt(category, urlsToAudit, manifestText, '[]', '[]')
    const response = await openai.responses.create({
      model: MODEL,
      input: prompt,
      max_output_tokens: 8000,
      text: { format: { type: 'text' } },
      reasoning: null,
      store: true,
    })

    // Poll for completion
    let finalResponse = response
    let status = response.status as string
    let attempts = 0
    while ((status === 'queued' || status === 'in_progress') && attempts < 300) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      finalResponse = await openai.responses.retrieve(response.id)
      status = finalResponse.status as string
      attempts++
    }

    if (status !== 'completed' && status !== 'incomplete') {
      console.error(`  [${mode}] [auditor] ${category}: failed (status: ${status})`)
      return []
    }

    const outputText = (finalResponse.output_text || '').trim()
    try {
      const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(cleaned)
      return (parsed?.issues || []) as AuditIssue[]
    } catch {
      console.error(`  [${mode}] [auditor] ${category}: JSON parse failed`)
      return []
    }
  })

  const auditorResults = await Promise.all(auditorPromises)
  const rawIssues = auditorResults.flat()
  console.log(`  [${mode}] Auditor raw: ${rawIssues.length} issues`)

  // Step 2: Checker pass - verify issues against HTML
  if (rawIssues.length === 0) {
    // Clear tags
    delete process.env.LANGSMITH_TAGS
    return { name: mode, issues: [], durationMs: Date.now() - start, rawIssueCount: 0 }
  }

  const byCategory = new Map<string, AuditIssue[]>()
  for (const issue of rawIssues) {
    const list = byCategory.get(issue.category) || []
    list.push(issue)
    byCategory.set(issue.category, list)
  }

  const checkerPromises = Array.from(byCategory.entries()).map(async ([category, categoryIssues]) => {
    const pageUrls = new Set(categoryIssues.map(i => i.page_url))
    const htmlContext = formatPagesForChecker(manifest, pageUrls)
    const prompt = buildCheckerPrompt(htmlContext, categoryIssues, category)
    const maxOutputTokens = Math.min(16000, Math.max(4000, categoryIssues.length * 150))

    let response: any
    try {
      response = await openai.responses.create({
        model: MODEL,
        input: prompt,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'text' } },
        reasoning: { effort: 'medium', summary: 'auto' },
        store: true,
      })
    } catch {
      console.error(`  [${mode}] [checker] ${category}: API error - keeping all`)
      return categoryIssues
    }

    // Poll for completion
    let finalResponse = response
    let status = response.status as string
    let attempts = 0
    while ((status === 'queued' || status === 'in_progress') && attempts < 120) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      finalResponse = await openai.responses.retrieve(response.id)
      status = finalResponse.status as string
      attempts++
    }

    if (status !== 'completed') {
      console.error(`  [${mode}] [checker] ${category}: polling failed - keeping all`)
      return categoryIssues
    }

    const outputText = (finalResponse.output_text || '').trim()
    let verifications: CheckerVerification[] = []
    try {
      const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(cleaned)
      verifications = parsed?.verifications || []
    } catch {
      console.error(`  [${mode}] [checker] ${category}: JSON parse failed - keeping all`)
      return categoryIssues
    }

    return applyCheckerDecisions(categoryIssues as RawIssue[], verifications) as AuditIssue[]
  })

  const checkerResults = await Promise.all(checkerPromises)
  const verifiedIssues = checkerResults.flat()
  const durationMs = Date.now() - start

  console.log(`  [${mode}] Checker: ${verifiedIssues.length}/${rawIssues.length} survived (${(durationMs / 1000).toFixed(1)}s)`)

  // Clear tags
  delete process.env.LANGSMITH_TAGS

  return {
    name: mode,
    issues: verifiedIssues,
    durationMs,
    rawIssueCount: rawIssues.length,
  }
}

// ---------------------------------------------------------------------------
// Deduplication: fuzzy word overlap to identify same issue across pipelines
// ---------------------------------------------------------------------------

function getWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
  )
}

function wordOverlap(a: string, b: string): number {
  const wordsA = getWords(a)
  const wordsB = getWords(b)
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let shared = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++
  }
  // Use the smaller set as denominator so short descriptions aren't penalized
  return shared / Math.min(wordsA.size, wordsB.size)
}

/** Normalize URL to compare page identity across pipelines */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname.replace(/\/$/, '') || '/'
  } catch {
    return url.replace(/\/$/, '')
  }
}

function buildUnionTable(htmlIssues: AuditIssue[], textIssues: AuditIssue[]): UnionRow[] {
  const union: UnionRow[] = []

  // Track which text issues have been matched
  const matchedTextIndices = new Set<number>()

  // For each HTML issue, check if there's a matching text issue
  for (const hi of htmlIssues) {
    const hiPath = normalizeUrl(hi.page_url)
    let found = false

    for (let ti = 0; ti < textIssues.length; ti++) {
      if (matchedTextIndices.has(ti)) continue
      const te = textIssues[ti]
      const tePath = normalizeUrl(te.page_url)

      // Same page + high description overlap = same issue
      if (hiPath === tePath && wordOverlap(hi.issue_description, te.issue_description) >= DEDUP_THRESHOLD) {
        union.push({
          page_url: hi.page_url,
          category: hi.category,
          description: hi.issue_description,
          foundBy: 'Both',
        })
        matchedTextIndices.add(ti)
        found = true
        break
      }
    }

    if (!found) {
      union.push({
        page_url: hi.page_url,
        category: hi.category,
        description: hi.issue_description,
        foundBy: 'HTML only',
      })
    }
  }

  // Add unmatched text issues
  for (let ti = 0; ti < textIssues.length; ti++) {
    if (matchedTextIndices.has(ti)) continue
    union.push({
      page_url: textIssues[ti].page_url,
      category: textIssues[ti].category,
      description: textIssues[ti].issue_description,
      foundBy: 'Text only',
    })
  }

  return union
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function extractPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function escapeCell(text: string): string {
  // Escape pipes and trim for markdown table cells
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}

function generateMarkdown(
  domain: string,
  htmlResult: PipelineResult,
  textResult: PipelineResult,
  pagesAudited: number,
  unionRows: UnionRow[],
): string {
  const date = new Date().toISOString().slice(0, 10)
  const langsmithBase = process.env.LANGSMITH_ENDPOINT || 'https://smith.langchain.com'
  const project = process.env.LANGSMITH_PROJECT || 'default'

  let md = `# Pipeline Comparison: ${domain}\n`
  md += `**Date:** ${date}\n`
  md += `**Model:** ${MODEL} (both pipelines)\n`
  md += `**Pages audited:** ${pagesAudited}\n\n`

  // Summary table
  md += `## Summary\n`
  md += `| Metric | Compressed HTML | Annotated Text |\n`
  md += `|---|---|---|\n`
  md += `| Total issues | ${htmlResult.issues.length} | ${textResult.issues.length} |\n`
  md += `| Raw (pre-checker) | ${htmlResult.rawIssueCount} | ${textResult.rawIssueCount} |\n`
  md += `| Duration | ${(htmlResult.durationMs / 1000).toFixed(1)}s | ${(textResult.durationMs / 1000).toFixed(1)}s |\n`
  md += `| LangSmith run | [compressed-html](${langsmithBase}/o/default/projects/p/${encodeURIComponent(project)}?tag=pipeline%3Acompressed-html) | [annotated-text](${langsmithBase}/o/default/projects/p/${encodeURIComponent(project)}?tag=pipeline%3Aannotated-text) |\n\n`

  // Compressed HTML issues table
  md += `## Compressed HTML Issues\n`
  if (htmlResult.issues.length === 0) {
    md += `No issues found.\n\n`
  } else {
    md += `| # | Page | Category | Description | Severity | Evidence |\n`
    md += `|---|---|---|---|---|---|\n`
    htmlResult.issues.forEach((issue, i) => {
      md += `| ${i + 1} | ${extractPath(issue.page_url)} | ${issue.category} | ${escapeCell(issue.issue_description)} | ${issue.severity} | ${escapeCell(issue.evidence || issue.suggested_fix || '')} |\n`
    })
    md += `\n`
  }

  // Annotated Text issues table
  md += `## Annotated Text Issues\n`
  if (textResult.issues.length === 0) {
    md += `No issues found.\n\n`
  } else {
    md += `| # | Page | Category | Description | Severity | Evidence |\n`
    md += `|---|---|---|---|---|---|\n`
    textResult.issues.forEach((issue, i) => {
      md += `| ${i + 1} | ${extractPath(issue.page_url)} | ${issue.category} | ${escapeCell(issue.issue_description)} | ${issue.severity} | ${escapeCell(issue.evidence || issue.suggested_fix || '')} |\n`
    })
    md += `\n`
  }

  // Union table for grading
  md += `## Union (for grading)\n`
  md += `| # | Page | Category | Description | Found by | Verdict |\n`
  md += `|---|---|---|---|---|---|\n`
  unionRows.forEach((row, i) => {
    md += `| ${i + 1} | ${extractPath(row.page_url)} | ${row.category} | ${escapeCell(row.description)} | ${row.foundBy} | ___ |\n`
  })
  md += `\nVerdict options: real / FP / debatable\n`

  return md
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const domain = parseDomain()

  console.log(`\nPipeline Comparison: ${domain}`)
  console.log('='.repeat(50))

  // Step 1: Crawl or load from cache
  console.log('\nStep 1: Getting site content...')
  let manifest = loadCachedManifest(domain)

  if (!manifest) {
    console.log(`  Crawling ${domain} via Firecrawl...`)
    manifest = await extractWithFirecrawl(`https://${domain}`, 'PAID')
    saveCachedManifest(domain, manifest)
    console.log(`  Crawled ${manifest.pages.length} pages, cached to ${getCachePath(domain)}`)
  } else {
    console.log(`  Loaded ${manifest.pages.length} pages from cache`)
  }

  const urlsToAudit = getAuditedUrls(manifest)
  console.log(`  Pages to audit: ${urlsToAudit.length}`)

  // Create traced OpenAI client
  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 450000,
  })

  // Step 2: Run compressed HTML pipeline
  console.log('\nStep 2: Running compressed HTML pipeline...')
  const htmlResult = await runPipeline('compressed-html', manifest, domain, openai)

  // Step 3: Run annotated text pipeline
  console.log('\nStep 3: Running annotated text pipeline...')
  const textResult = await runPipeline('annotated-text', manifest, domain, openai)

  // Step 4: Build union table and output markdown
  console.log('\nStep 4: Generating comparison report...')
  const unionRows = buildUnionTable(htmlResult.issues, textResult.issues)

  const markdown = generateMarkdown(domain, htmlResult, textResult, urlsToAudit.length, unionRows)

  // Write output
  const evalsDir = path.join(__dirname, '..', 'docs', 'evals')
  if (!fs.existsSync(evalsDir)) fs.mkdirSync(evalsDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const outputPath = path.join(evalsDir, `${date}-${domain.replace(/[^a-z0-9]/gi, '-')}-comparison.md`)
  fs.writeFileSync(outputPath, markdown)

  // Print summary
  console.log('\n' + '='.repeat(50))
  console.log('RESULTS')
  console.log('='.repeat(50))
  console.log(`Compressed HTML: ${htmlResult.issues.length} issues (${htmlResult.rawIssueCount} raw) in ${(htmlResult.durationMs / 1000).toFixed(1)}s`)
  console.log(`Annotated Text:  ${textResult.issues.length} issues (${textResult.rawIssueCount} raw) in ${(textResult.durationMs / 1000).toFixed(1)}s`)
  console.log(`Union rows:      ${unionRows.length} (Both: ${unionRows.filter(r => r.foundBy === 'Both').length}, HTML only: ${unionRows.filter(r => r.foundBy === 'HTML only').length}, Text only: ${unionRows.filter(r => r.foundBy === 'Text only').length})`)
  console.log(`\nOutput: ${outputPath}`)

  // Print LangSmith links
  const langsmithBase = process.env.LANGSMITH_ENDPOINT || 'https://smith.langchain.com'
  const project = process.env.LANGSMITH_PROJECT || 'default'
  console.log(`\nLangSmith runs:`)
  console.log(`  Compressed HTML: ${langsmithBase}/o/default/projects/p/${encodeURIComponent(project)}?tag=pipeline%3Acompressed-html`)
  console.log(`  Annotated Text:  ${langsmithBase}/o/default/projects/p/${encodeURIComponent(project)}?tag=pipeline%3Aannotated-text`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
