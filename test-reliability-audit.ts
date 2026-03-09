#!/usr/bin/env npx tsx

/**
 * Reliability test: run mini audits on well-known sites, save results for verification.
 * Tests extraction quality, page count accuracy, and false positive rate.
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { parallelMiniAudit } from './lib/audit'
import { extractWithFirecrawl, countPagesFound, formatFirecrawlForPrompt } from './lib/firecrawl-adapter'
import { mapWebsite } from './lib/firecrawl-client'
import * as fs from 'fs/promises'

const SITES = [
  'linear.app',
  'cal.com',
  'resend.com',
  'dub.co',
  'stripe.com',
]

interface SiteTestResult {
  domain: string
  // Firecrawl extraction
  firecrawlMapUrlCount: number
  filteredPageCount: number
  pagesScraped: number
  // Audit results
  auditIssues: Array<{
    category: string
    severity: string
    description: string
    page_url: string
    fix: string
  }>
  auditScore: number
  // Timing
  extractionTimeMs: number
  auditTimeMs: number
  // Raw data for verification
  scrapedUrls: string[]
  sampleMarkdown: string // First 2000 chars of first page
  elementManifestSample: string // First 2000 chars
  error?: string
}

async function testSite(domain: string): Promise<SiteTestResult> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Testing: ${domain}`)
  console.log('='.repeat(60))

  const result: SiteTestResult = {
    domain,
    firecrawlMapUrlCount: 0,
    filteredPageCount: 0,
    pagesScraped: 0,
    auditIssues: [],
    auditScore: 0,
    extractionTimeMs: 0,
    auditTimeMs: 0,
    scrapedUrls: [],
    sampleMarkdown: '',
    elementManifestSample: '',
  }

  try {
    // Phase 1: Firecrawl map to get raw URL count
    console.log(`  [1/3] Mapping URLs...`)
    const mapStart = Date.now()
    const mapResults = await mapWebsite(domain)
    const rawUrls = mapResults.map(r => typeof r === 'string' ? r : (r.url || String(r)))
    result.firecrawlMapUrlCount = rawUrls.length
    console.log(`  Map: ${rawUrls.length} raw URLs (${((Date.now() - mapStart) / 1000).toFixed(1)}s)`)

    // Phase 2: Extract with Firecrawl (our pipeline)
    console.log(`  [2/3] Extracting content...`)
    const extractStart = Date.now()
    const manifest = await extractWithFirecrawl(domain, 'FREE')
    result.extractionTimeMs = Date.now() - extractStart
    result.filteredPageCount = countPagesFound(manifest)
    result.pagesScraped = manifest.pages.length
    result.scrapedUrls = manifest.pages.map(p => p.url)

    // Capture sample content for verification
    if (manifest.pages.length > 0) {
      result.sampleMarkdown = (manifest.pages[0].markdown || '').substring(0, 2000)
    }
    const promptText = formatFirecrawlForPrompt(manifest)
    // Extract element manifest section
    const manifestMatch = promptText.match(/\*\*Element Manifest.*?\n([\s\S]*?)---/)
    result.elementManifestSample = (manifestMatch?.[1] || '').substring(0, 2000)

    console.log(`  Extract: ${result.pagesScraped} pages scraped, ${result.filteredPageCount} total found (${(result.extractionTimeMs / 1000).toFixed(1)}s)`)

    // Phase 3: Run mini audit
    console.log(`  [3/3] Running mini audit...`)
    const auditStart = Date.now()
    const auditResult = await parallelMiniAudit(domain)
    result.auditTimeMs = Date.now() - auditStart
    result.auditScore = auditResult.healthScore || 0

    if (auditResult.issues) {
      result.auditIssues = auditResult.issues.map((i: any) => ({
        category: i.category,
        severity: i.severity,
        description: i.issue_description || i.description,
        page_url: i.page_url || '',
        fix: i.fix_recommendation || i.fix || '',
      }))
    }

    console.log(`  Audit: score=${result.auditScore}, issues=${result.auditIssues.length} (${(result.auditTimeMs / 1000).toFixed(1)}s)`)

    // Summary
    result.auditIssues.forEach(i => {
      console.log(`    [${i.severity}] ${i.category}: ${i.description.slice(0, 100)}`)
    })

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(`  ERROR: ${result.error}`)
  }

  return result
}

async function main() {
  console.log('Fortress Reliability Test')
  console.log(`Testing ${SITES.length} sites: ${SITES.join(', ')}`)
  console.log(`Started at: ${new Date().toISOString()}\n`)

  const results: SiteTestResult[] = []

  for (const domain of SITES) {
    const result = await testSite(domain)
    results.push(result)
  }

  // Summary table
  console.log(`\n\n${'='.repeat(80)}`)
  console.log('SUMMARY')
  console.log('='.repeat(80))
  console.log(`${'Site'.padEnd(20)} ${'Map URLs'.padStart(10)} ${'Filtered'.padStart(10)} ${'Scraped'.padStart(10)} ${'Issues'.padStart(8)} ${'Score'.padStart(7)}`)
  console.log('-'.repeat(80))

  for (const r of results) {
    console.log(
      `${r.domain.padEnd(20)} ${String(r.firecrawlMapUrlCount).padStart(10)} ${String(r.filteredPageCount).padStart(10)} ${String(r.pagesScraped).padStart(10)} ${String(r.auditIssues.length).padStart(8)} ${String(r.auditScore).padStart(7)}`
    )
  }

  // Save full results
  const filename = `reliability-test-${Date.now()}.json`
  await fs.writeFile(filename, JSON.stringify(results, null, 2))
  console.log(`\nFull results saved to ${filename}`)
}

main().catch(console.error)
