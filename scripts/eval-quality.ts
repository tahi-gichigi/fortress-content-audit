/**
 * eval-quality.ts — LangSmith eval harness for audit quality measurement.
 *
 * Runs the production two-pass audit pipeline on benchmark sites, compares
 * output against curated ground truth (scripts/eval-ground-truth.json), and
 * scores precision/recall/severity accuracy via LangSmith experiments.
 *
 * Ground truth sources:
 *   - QA testing (Notion 2c265922, 7edda1f2)
 *   - Production eval runs (docs/eval-baseline.md)
 *
 * Metrics tracked per-site:
 *   - Recall:            known issues found / total known issues
 *   - Precision:         real issues / total issues reported (1 - false positive rate)
 *   - Severity accuracy: correct severity / total matched issues
 *   - False positive rate: issues matching known FP patterns / total reported
 *
 * Summary metrics (across all sites):
 *   - Weighted recall, weighted precision, mean severity accuracy
 *
 * Usage:
 *   npx tsx scripts/eval-quality.ts                    # all benchmark sites
 *   npx tsx scripts/eval-quality.ts --site seline.so   # single site
 *   npx tsx scripts/eval-quality.ts --dry-run           # skip LangSmith, print locally
 *   npx tsx scripts/eval-quality.ts --no-crawl          # use cached HTML from last run
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
import { Client } from 'langsmith'
import { evaluate, type EvaluatorT, type SummaryEvaluatorT } from 'langsmith/evaluation'
import { extractWithFirecrawl, formatFirecrawlForPrompt, formatPagesForChecker, getAuditedUrls, type AuditManifest } from '../lib/firecrawl-adapter'
import { buildLiberalCategoryAuditPrompt, buildCheckerPrompt } from '../lib/audit-prompts'
import { createTracedOpenAIClient } from '../lib/langsmith-openai'
import { applyCheckerDecisions, type RawIssue, type CheckerVerification } from '../lib/checker-decisions'

// ---------------------------------------------------------------------------
// Ground truth types
// ---------------------------------------------------------------------------

interface GroundTruthIssue {
  id: string
  description: string
  matchPatterns: string[]
  category: string
  expectedSeverity: string
  page_url_pattern: string
  source: string
}

interface FalsePositivePattern {
  id: string
  pattern: string
  reason: string
}

interface GroundTruthSite {
  domain: string
  tier: string
  notes: string
  knownIssues: GroundTruthIssue[]
  falsePositivePatterns: FalsePositivePattern[]
}

interface GroundTruth {
  _meta: { description: string; lastUpdated: string; sources: string[] }
  sites: GroundTruthSite[]
}

// ---------------------------------------------------------------------------
// Audit output types
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

// ---------------------------------------------------------------------------
// Match result types (for detailed reporting)
// ---------------------------------------------------------------------------

interface MatchResult {
  groundTruthId: string
  groundTruthDescription: string
  found: boolean
  matchedIssue?: AuditIssue
  severityCorrect?: boolean
}

interface FPMatchResult {
  fpId: string
  pattern: string
  reason: string
  matchedIssues: AuditIssue[]
}

interface SiteEvalResult {
  domain: string
  pagesAudited: number
  totalIssuesReported: number
  // Ground truth matching
  recall: number
  recallDetails: MatchResult[]
  knownIssuesFound: number
  knownIssuesTotal: number
  // Precision
  precision: number
  falsePositiveRate: number
  falsePositiveDetails: FPMatchResult[]
  falsePositivesDetected: number
  // Severity
  severityAccuracy: number
  // Raw issues for inspection
  allIssues: AuditIssue[]
  // Cost
  estimatedCost: number
  // Timing
  durationMs: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIT_CATEGORIES = ['Language', 'Facts & Consistency', 'Formatting'] as const
const DATASET_NAME = 'content-audit-quality'
const CACHE_DIR = path.join(__dirname, '.eval-cache')

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2)
  const flags = {
    site: undefined as string | undefined,
    dryRun: false,
    noCrawl: false,
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site' && args[i + 1]) {
      flags.site = args[i + 1]
      i++
    }
    if (args[i] === '--dry-run') flags.dryRun = true
    if (args[i] === '--no-crawl') flags.noCrawl = true
  }

  return flags
}

// ---------------------------------------------------------------------------
// Ground truth loading
// ---------------------------------------------------------------------------

function loadGroundTruth(): GroundTruth {
  const gtPath = path.join(__dirname, 'eval-ground-truth.json')
  if (!fs.existsSync(gtPath)) {
    throw new Error(`Ground truth file not found: ${gtPath}`)
  }
  return JSON.parse(fs.readFileSync(gtPath, 'utf-8'))
}

// ---------------------------------------------------------------------------
// HTML cache (avoids re-crawling on repeated eval runs)
// ---------------------------------------------------------------------------

function getCachePath(domain: string): string {
  return path.join(CACHE_DIR, `${domain.replace(/[^a-z0-9]/gi, '_')}.json`)
}

function loadCachedManifest(domain: string): AuditManifest | null {
  const cachePath = getCachePath(domain)
  if (!fs.existsSync(cachePath)) return null
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    // Cache is valid for 24h
    if (Date.now() - cached.timestamp > 24 * 60 * 60 * 1000) return null
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
// Issue matching: does an audit issue match a ground truth entry?
// ---------------------------------------------------------------------------

function matchesGroundTruth(issue: AuditIssue, gt: GroundTruthIssue): boolean {
  // Category must match (with flexible naming)
  const catMap: Record<string, string[]> = {
    'Language': ['Language'],
    'Facts & Consistency': ['Facts & Consistency', 'Facts'],
    'Formatting': ['Formatting'],
  }
  const allowedCats = catMap[gt.category] || [gt.category]
  if (!allowedCats.includes(issue.category)) return false

  // If ground truth specifies a page URL pattern, check it
  if (gt.page_url_pattern) {
    if (!issue.page_url.includes(gt.page_url_pattern)) return false
  }

  // Check if any match pattern appears in the issue description or the issue's quoted text
  const desc = issue.issue_description.toLowerCase()
  const fix = (issue.suggested_fix || '').toLowerCase()
  const evidence = (issue.evidence || '').toLowerCase()

  for (const pattern of gt.matchPatterns) {
    const p = pattern.toLowerCase()
    if (desc.includes(p) || fix.includes(p) || evidence.includes(p)) {
      return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// False positive detection: does an audit issue match a known FP pattern?
// ---------------------------------------------------------------------------

function matchesFalsePositive(issue: AuditIssue, fp: FalsePositivePattern): boolean {
  const desc = issue.issue_description.toLowerCase()
  const fix = (issue.suggested_fix || '').toLowerCase()
  const combined = `${desc} ${fix}`

  // FP patterns use | as OR separator
  const subPatterns = fp.pattern.split('|').map(s => s.trim().toLowerCase())
  return subPatterns.some(p => {
    // Support basic regex-like patterns
    try {
      const regex = new RegExp(p, 'i')
      return regex.test(combined)
    } catch {
      // If not valid regex, do substring match
      return combined.includes(p)
    }
  })
}

// ---------------------------------------------------------------------------
// Run audit pipeline on a single site (production-equivalent)
// ---------------------------------------------------------------------------

async function runAuditPipeline(
  domain: string,
  manifest: AuditManifest,
  openai: any,
): Promise<{ issues: AuditIssue[]; durationMs: number; estimatedCost: number }> {
  const start = Date.now()

  const manifestText = formatFirecrawlForPrompt(manifest)
  const urlsToAudit = getAuditedUrls(manifest)
  const noExcluded = '[]'
  const noActive = '[]'

  console.log(`  Running audit: ${urlsToAudit.length} pages, 3 categories`)

  // Step 1: Liberal auditor pass — all 3 categories in parallel
  const auditorPromises = AUDIT_CATEGORIES.map(async (category) => {
    const prompt = buildLiberalCategoryAuditPrompt(category, urlsToAudit, manifestText, noExcluded, noActive)
    const response = await openai.responses.create({
      model: 'gpt-5.1-2025-11-13',
      input: prompt,
      max_output_tokens: 8000,
      text: { format: { type: 'text' } },
      reasoning: { effort: 'low', summary: 'auto' },
      store: true,
    })

    // Poll for async responses
    let finalResponse = response
    let status = response.status as string
    let attempts = 0
    while ((status === 'queued' || status === 'in_progress') && attempts < 240) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      finalResponse = await openai.responses.retrieve(response.id)
      status = finalResponse.status as string
      attempts++
    }

    if (status !== 'completed') {
      console.error(`  [auditor] ${category}: polling failed after ${attempts}s (status: ${status})`)
      return []
    }

    const outputText = (finalResponse.output_text || '').trim()
    try {
      const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(cleaned)
      return (parsed?.issues || []) as AuditIssue[]
    } catch (err) {
      console.error(`  [auditor] ${category}: JSON parse failed`)
      return []
    }
  })

  const auditorResults = await Promise.all(auditorPromises)
  const rawIssues = auditorResults.flat()
  console.log(`  Auditor raw: ${rawIssues.length} issues`)

  // Step 2: Checker pass — group by category, verify against HTML
  if (rawIssues.length === 0) {
    return { issues: [], durationMs: Date.now() - start, estimatedCost: 0 }
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
        model: 'gpt-5.1-2025-11-13',
        input: prompt,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'text' } },
        reasoning: { effort: 'low', summary: 'auto' },
        store: true,
      })
    } catch (err) {
      console.error(`  [checker] ${category}: API error`)
      return categoryIssues // keep all on checker failure
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
      console.error(`  [checker] ${category}: polling failed (status: ${status})`)
      return categoryIssues // keep all on timeout
    }

    const outputText = (finalResponse.output_text || '').trim()
    let verifications: CheckerVerification[] = []
    try {
      const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(cleaned)
      verifications = parsed?.verifications || []
    } catch {
      console.error(`  [checker] ${category}: JSON parse failed — keeping all`)
      return categoryIssues
    }

    return applyCheckerDecisions(categoryIssues as RawIssue[], verifications) as AuditIssue[]
  })

  const checkerResults = await Promise.all(checkerPromises)
  const verifiedIssues = checkerResults.flat()
  const durationMs = Date.now() - start

  console.log(`  Checker: ${verifiedIssues.length}/${rawIssues.length} survived`)

  // Rough cost estimate: ~$0.10/auditor call + ~$0.15/checker call
  // 3 auditor + 3 checker = ~$0.75/site
  const estimatedCost = 0.10 * AUDIT_CATEGORIES.length + 0.15 * byCategory.size

  return { issues: verifiedIssues, durationMs, estimatedCost }
}

// ---------------------------------------------------------------------------
// Evaluate a single site against ground truth
// ---------------------------------------------------------------------------

function evaluateSite(
  gt: GroundTruthSite,
  issues: AuditIssue[],
  pagesAudited: number,
  durationMs: number,
  estimatedCost: number,
): SiteEvalResult {
  // --- Recall: how many known issues did we find? ---
  const recallDetails: MatchResult[] = gt.knownIssues.map(gtIssue => {
    const matched = issues.find(i => matchesGroundTruth(i, gtIssue))
    return {
      groundTruthId: gtIssue.id,
      groundTruthDescription: gtIssue.description,
      found: !!matched,
      matchedIssue: matched,
      severityCorrect: matched ? matched.severity === gtIssue.expectedSeverity : undefined,
    }
  })

  const knownIssuesFound = recallDetails.filter(r => r.found).length
  const knownIssuesTotal = gt.knownIssues.length
  const recall = knownIssuesTotal > 0 ? knownIssuesFound / knownIssuesTotal : 1

  // --- False positive detection ---
  const falsePositiveDetails: FPMatchResult[] = gt.falsePositivePatterns.map(fp => {
    const matched = issues.filter(i => matchesFalsePositive(i, fp))
    return {
      fpId: fp.id,
      pattern: fp.pattern,
      reason: fp.reason,
      matchedIssues: matched,
    }
  })

  const falsePositivesDetected = falsePositiveDetails.reduce((sum, fp) => sum + fp.matchedIssues.length, 0)
  const falsePositiveRate = issues.length > 0 ? falsePositivesDetected / issues.length : 0
  const precision = 1 - falsePositiveRate

  // --- Severity accuracy (among matched issues) ---
  const matchedWithSeverity = recallDetails.filter(r => r.found && r.severityCorrect !== undefined)
  const severityCorrect = matchedWithSeverity.filter(r => r.severityCorrect).length
  const severityAccuracy = matchedWithSeverity.length > 0 ? severityCorrect / matchedWithSeverity.length : 1

  return {
    domain: gt.domain,
    pagesAudited,
    totalIssuesReported: issues.length,
    recall,
    recallDetails,
    knownIssuesFound,
    knownIssuesTotal,
    precision,
    falsePositiveRate,
    falsePositiveDetails,
    falsePositivesDetected,
    severityAccuracy,
    allIssues: issues,
    estimatedCost,
    durationMs,
  }
}

// ---------------------------------------------------------------------------
// Console reporting
// ---------------------------------------------------------------------------

function printSiteResult(result: SiteEvalResult): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${result.domain}`)
  console.log(`${'='.repeat(60)}`)
  console.log(`  Pages audited:      ${result.pagesAudited}`)
  console.log(`  Issues reported:    ${result.totalIssuesReported}`)
  console.log(`  Duration:           ${(result.durationMs / 1000).toFixed(1)}s`)
  console.log(`  Estimated cost:     $${result.estimatedCost.toFixed(2)}`)
  console.log()
  console.log(`  RECALL:             ${(result.recall * 100).toFixed(0)}% (${result.knownIssuesFound}/${result.knownIssuesTotal} known issues found)`)
  console.log(`  PRECISION:          ${(result.precision * 100).toFixed(0)}% (${result.falsePositivesDetected} false positives in ${result.totalIssuesReported} issues)`)
  console.log(`  SEVERITY ACCURACY:  ${(result.severityAccuracy * 100).toFixed(0)}%`)

  // Print recall details
  if (result.knownIssuesTotal > 0) {
    console.log(`\n  Known issues:`)
    for (const detail of result.recallDetails) {
      const status = detail.found ? 'FOUND' : 'MISSED'
      const severity = detail.severityCorrect === true ? 'sev-ok' :
        detail.severityCorrect === false ? 'sev-wrong' : ''
      console.log(`    ${status.padEnd(7)} [${detail.groundTruthId}] ${detail.groundTruthDescription} ${severity}`)
    }
  }

  // Print false positive hits
  if (result.falsePositivesDetected > 0) {
    console.log(`\n  False positives triggered:`)
    for (const fp of result.falsePositiveDetails.filter(f => f.matchedIssues.length > 0)) {
      console.log(`    [${fp.fpId}] ${fp.reason}`)
      for (const issue of fp.matchedIssues) {
        console.log(`      -> "${issue.issue_description.substring(0, 80)}..."`)
      }
    }
  }
}

function printSummary(results: SiteEvalResult[]): void {
  const valid = results.filter(r => r.pagesAudited > 0)
  if (valid.length === 0) {
    console.log('\nNo valid results to summarize.')
    return
  }

  // Weighted averages (weight by number of ground truth items for recall,
  // by number of issues for precision)
  const totalKnown = valid.reduce((s, r) => s + r.knownIssuesTotal, 0)
  const totalFound = valid.reduce((s, r) => s + r.knownIssuesFound, 0)
  const weightedRecall = totalKnown > 0 ? totalFound / totalKnown : 1

  const totalIssues = valid.reduce((s, r) => s + r.totalIssuesReported, 0)
  const totalFP = valid.reduce((s, r) => s + r.falsePositivesDetected, 0)
  const weightedPrecision = totalIssues > 0 ? 1 - totalFP / totalIssues : 1

  const meanSeverity = valid.reduce((s, r) => s + r.severityAccuracy, 0) / valid.length
  const totalCost = valid.reduce((s, r) => s + r.estimatedCost, 0)
  const totalDuration = valid.reduce((s, r) => s + r.durationMs, 0)

  console.log(`\n${'='.repeat(60)}`)
  console.log('  SUMMARY')
  console.log(`${'='.repeat(60)}`)
  console.log(`  Sites evaluated:    ${valid.length}`)
  console.log(`  Total issues:       ${totalIssues}`)
  console.log(`  Total duration:     ${(totalDuration / 1000).toFixed(0)}s`)
  console.log(`  Total cost:         $${totalCost.toFixed(2)}`)
  console.log()
  console.log(`  WEIGHTED RECALL:    ${(weightedRecall * 100).toFixed(0)}% (${totalFound}/${totalKnown})`)
  console.log(`  WEIGHTED PRECISION: ${(weightedPrecision * 100).toFixed(0)}% (${totalFP} FP in ${totalIssues})`)
  console.log(`  MEAN SEVERITY ACC:  ${(meanSeverity * 100).toFixed(0)}%`)
}

// ---------------------------------------------------------------------------
// LangSmith integration: create dataset + run experiment
// ---------------------------------------------------------------------------

async function createOrUpdateDataset(
  client: Client,
  groundTruth: GroundTruth,
  sitesToEval: GroundTruthSite[],
): Promise<string> {
  // Try to find existing dataset
  let datasetId: string | undefined
  try {
    const datasets = client.listDatasets({ datasetName: DATASET_NAME })
    for await (const ds of datasets) {
      if (ds.name === DATASET_NAME) {
        datasetId = ds.id
        break
      }
    }
  } catch {
    // Dataset doesn't exist yet
  }

  // Create dataset if it doesn't exist
  if (!datasetId) {
    const ds = await client.createDataset(DATASET_NAME, {
      description: `Ground truth for content audit quality evaluation. Sources: ${groundTruth._meta.sources.join(', ')}`,
    })
    datasetId = ds.id
    console.log(`Created LangSmith dataset: ${DATASET_NAME} (${datasetId})`)
  } else {
    console.log(`Using existing LangSmith dataset: ${DATASET_NAME} (${datasetId})`)
  }

  // Upsert examples — one per site
  for (const site of sitesToEval) {
    await client.createExamples({
      inputs: [{ domain: site.domain, tier: site.tier, notes: site.notes }],
      outputs: [{
        knownIssues: site.knownIssues,
        falsePositivePatterns: site.falsePositivePatterns,
      }],
      datasetId,
    })
  }

  return datasetId
}

// Per-example evaluators: score each site's audit against its ground truth
function buildEvaluators(): EvaluatorT[] {
  // Evaluators use the new object-parameter signature: { run, example, inputs, outputs, referenceOutputs }
  // All fields are optional in our destructuring — we only need outputs + referenceOutputs
  const recallEvaluator: EvaluatorT = (args: any) => {
    const { outputs, referenceOutputs } = args
    if (!outputs || !referenceOutputs) {
      return { key: 'recall', score: 0, comment: 'Missing outputs or reference' }
    }

    const issues: AuditIssue[] = outputs.issues || []
    const knownIssues: GroundTruthIssue[] = referenceOutputs.knownIssues || []

    if (knownIssues.length === 0) {
      return { key: 'recall', score: 1, comment: 'No known issues to check' }
    }

    let found = 0
    const missed: string[] = []
    for (const gt of knownIssues) {
      if (issues.some(i => matchesGroundTruth(i, gt))) {
        found++
      } else {
        missed.push(`${gt.id}: ${gt.description}`)
      }
    }

    const recall = found / knownIssues.length
    return {
      key: 'recall',
      score: recall,
      comment: missed.length > 0 ? `Missed: ${missed.join('; ')}` : 'All known issues found',
    }
  }

  const precisionEvaluator: EvaluatorT = (args: any) => {
    const { outputs, referenceOutputs } = args
    if (!outputs || !referenceOutputs) {
      return { key: 'precision', score: 0, comment: 'Missing outputs or reference' }
    }

    const issues: AuditIssue[] = outputs.issues || []
    const fpPatterns: FalsePositivePattern[] = referenceOutputs.falsePositivePatterns || []

    if (issues.length === 0) {
      return { key: 'precision', score: 1, comment: 'No issues reported' }
    }

    let fpCount = 0
    const fpHits: string[] = []
    for (const fp of fpPatterns) {
      const matched = issues.filter(i => matchesFalsePositive(i, fp))
      fpCount += matched.length
      if (matched.length > 0) {
        fpHits.push(`${fp.id}: ${matched.length} match(es)`)
      }
    }

    const precision = 1 - fpCount / issues.length
    return {
      key: 'precision',
      score: Math.max(0, precision),
      comment: fpHits.length > 0 ? `FP: ${fpHits.join('; ')}` : 'No known false positives triggered',
    }
  }

  const severityEvaluator: EvaluatorT = (args: any) => {
    const { outputs, referenceOutputs } = args
    if (!outputs || !referenceOutputs) {
      return { key: 'severity_accuracy', score: 0, comment: 'Missing outputs or reference' }
    }

    const issues: AuditIssue[] = outputs.issues || []
    const knownIssues: GroundTruthIssue[] = referenceOutputs.knownIssues || []

    let correct = 0
    let total = 0
    for (const gt of knownIssues) {
      const matched = issues.find(i => matchesGroundTruth(i, gt))
      if (matched) {
        total++
        if (matched.severity === gt.expectedSeverity) correct++
      }
    }

    const accuracy = total > 0 ? correct / total : 1
    return {
      key: 'severity_accuracy',
      score: accuracy,
      comment: `${correct}/${total} matched issues have correct severity`,
    }
  }

  const issueCountEvaluator: EvaluatorT = (args: any) => {
    const count = (args.outputs?.issues || []).length
    return { key: 'issue_count', score: count, comment: `${count} issues reported` }
  }

  return [recallEvaluator, precisionEvaluator, severityEvaluator, issueCountEvaluator]
}

// Summary evaluators: aggregate across all sites
function buildSummaryEvaluators(): SummaryEvaluatorT[] {
  const summaryEvaluator: SummaryEvaluatorT = ({ runs, examples, inputs, outputs, referenceOutputs }) => {
    const refs = referenceOutputs || []
    const outs = outputs || []

    let totalKnown = 0
    let totalFound = 0
    let totalIssues = 0
    let totalFP = 0

    for (let i = 0; i < outs.length; i++) {
      const issues: AuditIssue[] = outs[i]?.issues || []
      const knownIssues: GroundTruthIssue[] = refs[i]?.knownIssues || []
      const fpPatterns: FalsePositivePattern[] = refs[i]?.falsePositivePatterns || []

      totalKnown += knownIssues.length
      totalFound += knownIssues.filter(gt => issues.some(iss => matchesGroundTruth(iss, gt))).length
      totalIssues += issues.length
      for (const fp of fpPatterns) {
        totalFP += issues.filter(iss => matchesFalsePositive(iss, fp)).length
      }
    }

    return {
      results: [
        {
          key: 'weighted_recall',
          score: totalKnown > 0 ? totalFound / totalKnown : 1,
          comment: `${totalFound}/${totalKnown} across all sites`,
        },
        {
          key: 'weighted_precision',
          score: totalIssues > 0 ? Math.max(0, 1 - totalFP / totalIssues) : 1,
          comment: `${totalFP} FP in ${totalIssues} issues`,
        },
      ],
    }
  }

  return [summaryEvaluator]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseArgs()
  const groundTruth = loadGroundTruth()

  // Filter sites
  let sitesToEval = groundTruth.sites
  if (flags.site) {
    sitesToEval = sitesToEval.filter(s => s.domain === flags.site)
    if (sitesToEval.length === 0) {
      console.error(`Site "${flags.site}" not found in ground truth. Available: ${groundTruth.sites.map(s => s.domain).join(', ')}`)
      process.exit(1)
    }
  }

  console.log(`\nContent Audit Quality Eval`)
  console.log(`Sites: ${sitesToEval.map(s => s.domain).join(', ')}`)
  console.log(`Ground truth: ${groundTruth._meta.lastUpdated}`)
  console.log(`Dry run: ${flags.dryRun}`)
  console.log()

  const openai = createTracedOpenAIClient()
  const results: SiteEvalResult[] = []

  // Run audits sequentially to avoid rate limits
  for (const site of sitesToEval) {
    console.log(`\n--- ${site.domain} ---`)

    // Crawl or load from cache
    let manifest: AuditManifest
    if (flags.noCrawl) {
      const cached = loadCachedManifest(site.domain)
      if (!cached) {
        console.log(`  No cache found for ${site.domain} — skipping (use without --no-crawl to crawl)`)
        continue
      }
      manifest = cached
      console.log(`  Using cached HTML (${manifest.pages.length} pages)`)
    } else {
      console.log(`  Crawling ${site.domain}...`)
      try {
        manifest = await extractWithFirecrawl(site.domain, site.tier as 'PAID' | 'FREE')
        saveCachedManifest(site.domain, manifest)
      } catch (err) {
        console.error(`  Crawl failed for ${site.domain}: ${err}`)
        continue
      }
    }

    const urlsToAudit = getAuditedUrls(manifest)
    console.log(`  ${urlsToAudit.length} pages to audit`)

    // Run the full pipeline
    const { issues, durationMs, estimatedCost } = await runAuditPipeline(site.domain, manifest, openai)

    // Evaluate against ground truth
    const result = evaluateSite(site, issues, urlsToAudit.length, durationMs, estimatedCost)
    results.push(result)
    printSiteResult(result)
  }

  // Print summary
  printSummary(results)

  // Save results locally
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
  const outputPath = path.join(__dirname, `eval-quality-${timestamp}.json`)
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    groundTruthVersion: groundTruth._meta.lastUpdated,
    sites: results.map(r => ({
      domain: r.domain,
      pagesAudited: r.pagesAudited,
      totalIssues: r.totalIssuesReported,
      recall: r.recall,
      precision: r.precision,
      severityAccuracy: r.severityAccuracy,
      falsePositiveRate: r.falsePositiveRate,
      knownIssuesFound: r.knownIssuesFound,
      knownIssuesTotal: r.knownIssuesTotal,
      falsePositivesDetected: r.falsePositivesDetected,
      estimatedCost: r.estimatedCost,
      durationMs: r.durationMs,
      recallDetails: r.recallDetails,
      falsePositiveDetails: r.falsePositiveDetails.filter(f => f.matchedIssues.length > 0),
      allIssues: r.allIssues,
    })),
    summary: {
      sitesEvaluated: results.length,
      weightedRecall: results.reduce((s, r) => s + r.knownIssuesFound, 0) /
        Math.max(1, results.reduce((s, r) => s + r.knownIssuesTotal, 0)),
      weightedPrecision: 1 - results.reduce((s, r) => s + r.falsePositivesDetected, 0) /
        Math.max(1, results.reduce((s, r) => s + r.totalIssuesReported, 0)),
      meanSeverityAccuracy: results.length > 0
        ? results.reduce((s, r) => s + r.severityAccuracy, 0) / results.length
        : 0,
      totalCost: results.reduce((s, r) => s + r.estimatedCost, 0),
      totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    },
  }, null, 2))
  console.log(`\nResults saved to: ${outputPath}`)

  // LangSmith experiment (unless dry run)
  if (!flags.dryRun && process.env.LANGSMITH_API_KEY) {
    console.log('\nPushing to LangSmith experiment...')

    const lsClient = new Client({
      apiKey: process.env.LANGSMITH_API_KEY,
      apiUrl: process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com',
    })

    const datasetId = await createOrUpdateDataset(lsClient, groundTruth, sitesToEval)

    // Build a target function: takes dataset input (domain), returns audit output
    // We pre-computed results, so this just looks them up
    const resultsByDomain = new Map(results.map(r => [r.domain, r]))

    const target = async (input: { domain: string }) => {
      const result = resultsByDomain.get(input.domain)
      if (!result) return { issues: [], error: 'Site not evaluated' }
      return {
        issues: result.allIssues,
        pagesAudited: result.pagesAudited,
        totalIssues: result.totalIssuesReported,
        durationMs: result.durationMs,
        estimatedCost: result.estimatedCost,
      }
    }

    try {
      const experimentResults = await evaluate(target, {
        data: DATASET_NAME,
        evaluators: buildEvaluators(),
        summaryEvaluators: buildSummaryEvaluators(),
        experimentPrefix: 'content-audit-quality',
        description: `Audit quality eval: ${sitesToEval.map(s => s.domain).join(', ')} | GT: ${groundTruth._meta.lastUpdated}`,
        maxConcurrency: 1,
        client: lsClient,
      })

      // Consume the async iterator to ensure all results are processed
      for await (const row of experimentResults) {
        // Results are being processed
      }

      console.log(`\nLangSmith experiment: ${experimentResults.experimentName}`)
      console.log(`View at: https://smith.langchain.com`)
    } catch (err) {
      console.error(`LangSmith experiment failed:`, err)
      console.log('Results are still saved locally.')
    }
  } else if (flags.dryRun) {
    console.log('\nDry run — skipping LangSmith experiment')
  } else {
    console.log('\nLANGSMITH_API_KEY not set — skipping experiment')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
