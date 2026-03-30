import OpenAI from "openai"
import { z } from "zod"
import Logger from "./logger"
import { extractWithFirecrawl, formatFirecrawlForPrompt, formatPagesForChecker, countPagesFound, getDiscoveredPages, getAuditedUrls, type AuditManifest } from "./firecrawl-adapter"
import { buildMiniAuditPrompt, buildFullAuditPrompt, buildCategoryAuditPrompt, buildLiberalCategoryAuditPrompt, buildCheckerPrompt } from "./audit-prompts"
import { runBrandVoiceAuditPass, type BrandVoiceProfileForAudit } from "./brand-voice-audit"
import { createTracedOpenAIClient } from "./langsmith-openai"
import { applyCheckerDecisions, type CheckerVerification } from "./checker-decisions"

// ============================================================================
// Content Audit
// All tiers use GPT-5.1 with web_search with synchronous polling
// FREE: 4min max, 10 tool calls
// PAID: 7min max, 30 tool calls  
// ENTERPRISE: 10min max, 60 tool calls
// Note: background mode removed - it queued jobs with lower priority, causing 5x+ slower processing
// ============================================================================

// Audit tiers for cost/scope control
// Only difference between tiers is maxToolCalls (10/30/60)
export const AUDIT_TIERS = {
  // Vercel limits: Pro=300s (5min) without Fluid Compute, 800s with Fluid Compute; Enterprise=900s
  // Audits typically complete in ~2-4 minutes, but need buffer for 6-7min pro audits
  FREE: { maxToolCalls: 10, model: "gpt-5.1-2025-11-13" as const, maxPollSeconds: 240 }, // 4min max (safe for Pro without Fluid Compute)
  PAID: { maxToolCalls: 30, model: "gpt-5.1-2025-11-13" as const, maxPollSeconds: 420 }, // 7min max (requires Pro with Fluid Compute or Enterprise)
  ENTERPRISE: { maxToolCalls: 60, model: "gpt-5.1-2025-11-13" as const, maxPollSeconds: 600 }, // 10min max (requires Enterprise or Pro with Fluid Compute)
} as const

export type AuditTier = keyof typeof AUDIT_TIERS

// Prompt IDs removed - now using inline prompts with manifest integration
// See lib/audit-prompts.ts for prompt definitions

// Zod schemas for structured audit output (new prompt format)
const AUDIT_CATEGORIES = ["Language", "Facts & Consistency", "Formatting", "Brand voice", "Links"] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]
/** Categories run by category audit prompts (excludes Brand voice, which has its own pass) */
export type ContentAuditCategory = "Language" | "Facts & Consistency" | "Formatting"

const NewPromptIssueSchema = z.object({
  page_url: z.string(),
  category: z.enum(AUDIT_CATEGORIES),
  issue_description: z.string(),
  severity: z.enum(["low", "medium", "critical"]),
  suggested_fix: z.string(),
})

const NewPromptResultSchema = z.object({
  issues: z.array(NewPromptIssueSchema),
  total_issues: z.number().optional(),
  pages_with_issues: z.number().optional(),
  pages_audited: z.number().optional(),
})

// Legacy schemas removed - using new prompt format directly

const AuditResultSchema = z.object({
  issues: z.array(NewPromptIssueSchema),
  auditedUrls: z.array(z.string()).optional(),
  total_issues: z.number().optional(),
  pages_with_issues: z.number().optional(),
  pages_audited: z.number().optional(),
})

// Full audit result type (includes metadata)
export type AuditResult = {
  issues: Array<{
    page_url: string
    category: AuditCategory
    issue_description: string
    severity: 'low' | 'medium' | 'critical'
    suggested_fix: string
    /** HTML snippet from checker pass confirming the issue (Pro only) */
    evidence?: string
    /** Checker confidence score 0-1 (Pro only) */
    confidence?: number
    /** Verification status from checker pass */
    verification_status?: 'verified' | 'unverified' | 'parse_error'
  }>
  pagesAudited: number // Model's self-reported count of pages audited
  discoveredPages: string[] // All internal URLs found by Puppeteer
  /** @deprecated Unreliable - just tool call URLs, not what model audited */
  auditedUrls?: string[]
  total_issues?: number
  pages_with_issues?: number
  responseId?: string
  status?: "completed" | "in_progress" | "queued" | "failed"
  tier?: AuditTier
  modelDurationMs?: number // Time taken for model to respond (in milliseconds)
  rawStatus?: string // Raw status from OpenAI API
  /** Manifest text used for audit; set by parallel audit for brand voice pass */
  manifestText?: string
}

// Legacy JSON schema removed - using new prompt format with Zod validation

// Issue context types for deduplication
export interface IssueContext {
  page_url: string
  category: string
  issue_description: string
}

export interface AuditIssueContext {
  excluded: IssueContext[]
  active: IssueContext[]
}

// ============================================================================
// Post-audit verification: drop issues where quoted text doesn't exist in HTML
// Catches model hallucinations like "Book no" when the actual HTML says "Book now"
// ============================================================================

function verifyIssuesAgainstHtml(
  issues: AuditResult["issues"],
  manifest: AuditManifest
): AuditResult["issues"] {
  // Build a map of page URL -> HTML content for fast lookup
  const htmlByUrl = new Map<string, string>()
  for (const page of manifest.pages) {
    if (page.html) {
      // Store lowercase for case-insensitive matching
      htmlByUrl.set(page.url, page.html.toLowerCase())
    }
  }

  const verified: AuditResult["issues"] = []
  let dropped = 0

  for (const issue of issues) {
    // Extract all quoted strings (single or double) from the issue description
    // e.g. 'professionalism: "Book no" CTA truncated' -> ["Book no"]
    const quotedStrings = [...issue.issue_description.matchAll(/['"]([^'"]{3,})['"]/g)]
      .map(m => m[1])

    // If no quoted strings, keep the issue (nothing to verify)
    if (quotedStrings.length === 0) {
      verified.push(issue)
      continue
    }

    // Find the page HTML for this issue, stripping HTML comments so the filter
    // sees the same content as the model (which also has comments stripped)
    const rawPageHtml = htmlByUrl.get(issue.page_url)
    if (!rawPageHtml) {
      // Can't verify without HTML — keep the issue
      verified.push(issue)
      continue
    }

    const pageHtml = rawPageHtml.replace(/<!--[\s\S]*?-->/g, '')

    // Check if ALL quoted strings exist in the page HTML using word-boundary matching
    // This prevents "Book no" from matching inside "Book now"
    const existsInHtml = (qs: string): boolean => {
      const escaped = qs.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(?:^|[\\s>/"'\\t])${escaped}(?:$|[\\s</"'\\t.,;:!?)])`, 'i')
      return regex.test(pageHtml)
    }

    const allFound = quotedStrings.every(existsInHtml)
    if (allFound) {
      // Special case: zero-width / invisible character claims need regex verification
      const isZeroWidthClaim = /invisible character|zero.?width|hidden character|non.?printable/i.test(issue.issue_description)
      if (isZeroWidthClaim) {
        const rawHtml = htmlByUrl.get(issue.page_url) || ''
        const zwRegex = /[\u200B\u200C\u200D\uFEFF\u00AD\u200E\u200F\u2060\u2061-\u2064]/
        if (!zwRegex.test(rawHtml)) {
          Logger.warn(`[IssueVerification] Dropped zero-width false positive: "${issue.issue_description}" — no zero-width chars in HTML`)
          dropped++
          continue
        }
      }
      verified.push(issue)
    } else {
      const missing = quotedStrings.filter(qs => !existsInHtml(qs))
      Logger.warn(`[IssueVerification] Dropped hallucinated issue: "${issue.issue_description}" — quoted text not found in HTML: ${missing.map(s => `'${s}'`).join(', ')}`)
      dropped++
    }
  }

  if (dropped > 0) {
    Logger.info(`[IssueVerification] Dropped ${dropped}/${issues.length} issues (quoted text not in source HTML)`)
  }

  return verified
}

// ============================================================================
// Checker Pass: model-based verification for Pro two-pass pipeline
// Groups issues by page, one API call per page, drops unconfirmed findings
// ============================================================================


async function runCheckerPass(
  issues: AuditResult["issues"],
  manifest: AuditManifest,
  openai?: OpenAI
): Promise<AuditResult["issues"]> {
  if (issues.length === 0) return []

  const client = openai || createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 120000,
  })

  // Group issues by category — gives checker cross-page visibility.
  // "Brand voice" issues land here too; buildCheckerPrompt falls back to generic
  // verification criteria for that category, which is acceptable.
  const byCategory = new Map<string, AuditResult["issues"]>()
  for (const issue of issues) {
    const list = byCategory.get(issue.category) || []
    list.push(issue)
    byCategory.set(issue.category, list)
  }

  Logger.info(`[CheckerPass] Verifying ${issues.length} issues across ${byCategory.size} categories`)

  const BATCH_SIZE = 50

  const categoryPromises = Array.from(byCategory.entries()).map(async ([category, categoryIssues]) => {
    // Collect only the pages that have issues in this category.
    // Checker gets the same full cleaned HTML the auditor saw — no snippet extraction.
    const pageUrls = new Set(categoryIssues.map(i => i.page_url))
    const htmlContext = formatPagesForChecker(manifest, pageUrls)
    Logger.info(`[CheckerPass] ${category}: ${categoryIssues.length} issues across ${pageUrls.size} pages`)

    // Batch if >50 issues in one category
    const batches: AuditResult["issues"][] = []
    for (let i = 0; i < categoryIssues.length; i += BATCH_SIZE) {
      batches.push(categoryIssues.slice(i, i + BATCH_SIZE))
    }

    const batchResults = await Promise.all(batches.map(async (batchIssues) => {
      // Each batch gets the full HTML context for all pages in this category
      const prompt = buildCheckerPrompt(htmlContext, batchIssues, category)

      // ~150 tokens per verification entry; floor at 4000, cap at 16000
      const maxOutputTokens = Math.min(16000, Math.max(4000, batchIssues.length * 150))

      const params: any = {
        model: "gpt-5.1-2025-11-13",
        input: prompt,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: "text" } },
        reasoning: { effort: "low", summary: "auto" },
        store: true,
      }

      let response: any
      try {
        response = await client.responses.create(params)
      } catch (err) {
        Logger.warn(`[CheckerPass] API call failed for ${category}`, err instanceof Error ? err : undefined)
        return batchIssues.map(issue => ({ ...issue, evidence: 'Checker call failed', confidence: 0.5, verification_status: 'unverified' as const }))
      }

      // Poll for completion
      let finalResponse = response
      let status = response.status as string
      let attempts = 0
      while ((status === "queued" || status === "in_progress") && attempts < 120) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        finalResponse = await client.responses.retrieve(response.id)
        status = finalResponse.status as string
        attempts++
      }

      const outputText = (finalResponse.output_text || '').trim()

      let verifications: CheckerVerification[] = []
      try {
        const cleaned = outputText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const parsed = JSON.parse(cleaned)
        verifications = parsed?.verifications || []
      } catch {
        Logger.warn(`[CheckerPass] JSON parse failed for ${category} — keeping all issues as parse_error`)
        return batchIssues.map(issue => ({ ...issue, evidence: 'Checker parse error', confidence: 0.5, verification_status: 'parse_error' as const }))
      }

      // Apply checker decisions using pure filtering logic
      const verified = (applyCheckerDecisions(batchIssues, verifications) as AuditResult["issues"])
        .map(issue => ({ ...issue, verification_status: 'verified' as const }))

      // Log dropped issues
      for (let i = 0; i < batchIssues.length; i++) {
        const v = verifications.find(v => v.index === i)
        const confirmed = v?.confirmed ?? false
        const confidence = v?.confidence ?? 0.5
        if (!(confirmed === true || (confirmed === 'uncertain' && confidence >= 0.7))) {
          Logger.debug(`[CheckerPass] Dropped: "${batchIssues[i].issue_description}" (confirmed=${confirmed}, confidence=${confidence})`)
        }
      }

      Logger.debug(`[CheckerPass] ${category}: ${verified.length}/${batchIssues.length} issues passed`)
      return verified
    }))

    return batchResults.flat()
  })

  const results = await Promise.allSettled(categoryPromises)
  const allVerified: AuditResult["issues"] = []

  for (const r of results) {
    if (r.status === "fulfilled") {
      allVerified.push(...r.value)
    }
  }

  const dropped = issues.length - allVerified.length
  Logger.info(`[CheckerPass] Complete: ${allVerified.length}/${issues.length} issues passed (${dropped} dropped)`)
  return allVerified
}

// ============================================================================
// Issue Context Functions (for deduplication)
// ============================================================================

import { supabaseAdmin } from "./supabase-admin"

/**
 * Get resolved/ignored issues for a domain (to exclude from new audit)
 * Returns most recent 50, includes page_url for location-aware matching
 */
export async function getExcludedIssues(
  userId: string,
  domain: string
): Promise<IssueContext[]> {
  try {
    // Get all audit IDs for this user+domain
    const { data: audits, error: auditsError } = await (supabaseAdmin as any)
      .from('brand_audit_runs')
      .select('id')
      .eq('user_id', userId)
      .eq('domain', domain)

    if (auditsError) {
      Logger.warn('[Audit] Error fetching audits for excluded issues', auditsError)
      return []
    }

    if (!audits?.length) return []

    // Get resolved/ignored issues, most recent first, cap at 50
    const { data: issues, error: issuesError } = await (supabaseAdmin as any)
      .from('issues')
      .select('page_url, category, issue_description')
      .in('audit_id', audits.map((a: any) => a.id))
      .in('status', ['resolved', 'ignored'])
      .order('updated_at', { ascending: false })
      .limit(50)

    if (issuesError) {
      Logger.warn('[Audit] Error fetching excluded issues', issuesError)
      return []
    }

    return issues || []
  } catch (error) {
    Logger.warn('[Audit] Unexpected error in getExcludedIssues', error instanceof Error ? error : undefined)
    return []
  }
}

/**
 * Get active issues from most recent completed audit (to verify still present)
 * Returns most recent 50, includes page_url for location context
 */
export async function getActiveIssues(
  userId: string,
  domain: string
): Promise<IssueContext[]> {
  try {
    // Get most recent completed audit for this domain
    const { data: latestAudit, error: auditError } = await (supabaseAdmin as any)
      .from('brand_audit_runs')
      .select('id')
      .eq('user_id', userId)
      .eq('domain', domain)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    // If no audit found or error (not PGRST116 which means no rows), return empty
    if (auditError && auditError.code !== 'PGRST116') {
      Logger.warn('[Audit] Error fetching latest audit', auditError)
      return []
    }

    if (!latestAudit?.id) return []

    // Get active issues from that audit, cap at 50
    const { data: issues, error: issuesError } = await (supabaseAdmin as any)
      .from('issues')
      .select('page_url, category, issue_description')
      .eq('audit_id', latestAudit.id)
      .eq('status', 'active')
      .order('severity', { ascending: false })
      .limit(50)

    if (issuesError) {
      Logger.warn('[Audit] Error fetching active issues', issuesError)
      return []
    }

    return issues || []
  } catch (error) {
    Logger.warn('[Audit] Unexpected error in getActiveIssues', error instanceof Error ? error : undefined)
    return []
  }
}

// ============================================================================
// Helper functions
// ============================================================================

// Extract domain hostname for filtering
function extractDomainHostname(domain: string): string {
  try {
    const url = new URL(domain.startsWith('http') ? domain : `https://${domain}`)
    return url.hostname
  } catch {
    return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  }
}

// Count opened pages from response output (for progress logging)
function extractOpenedPagesCount(response: any): number {
  if (!response?.output || !Array.isArray(response.output)) return 0
  const webSearchCalls = response.output.filter((item: any) => item.type === 'web_search_call')
  return webSearchCalls.filter((call: any) => call.action?.type === 'open_page' && call.action.url).length
}

// ============================================================================
// Parallel Mini Audit - FREE tier with 3 concurrent specialized models
// Runs Language, Facts & Consistency, and Formatting in parallel
// Uses low reasoning for 2x speed at 50% cost with better issue detection
// ============================================================================

// Internal type for category audit results
interface CategoryAuditResult {
  category: AuditCategory
  issues: Array<{
    page_url: string
    category: AuditCategory
    issue_description: string
    severity: 'low' | 'medium' | 'critical'
    suggested_fix: string
  }>
  openedPages: string[]
  pagesAudited: number
  durationMs: number
  status: "success" | "failed"
  error?: string
}

// Run a single category audit (Language, Facts & Consistency, Formatting only)
async function runCategoryAudit(
  category: ContentAuditCategory,
  urlsToAudit: string[],
  domainHostname: string,
  manifestText: string,
  issueContext?: AuditIssueContext,
  openai?: OpenAI,
  keywords?: { ignore?: string[]; flag?: string[] }
): Promise<CategoryAuditResult> {
  const startTime = Date.now()

  const client = openai || createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 300000,
  })

  // Build category-specific prompt with explicit URL list
  const excludedIssuesJson = issueContext?.excluded?.length
    ? JSON.stringify(issueContext.excluded.filter(i => i.category === category))
    : "[]"
  const activeIssuesJson = issueContext?.active?.length
    ? JSON.stringify(issueContext.active.filter(i => i.category === category))
    : "[]"

  const promptText = buildCategoryAuditPrompt(
    category,
    urlsToAudit,
    manifestText,
    excludedIssuesJson,
    activeIssuesJson,
    keywords?.ignore,
    keywords?.flag
  )

  // Calculate tool calls: need at least 1 per page to open + buffer for retries
  const toolCallsPerModel = Math.max(8, urlsToAudit.length + 3)

  // NOTE: temperature omitted — GPT-5.1 with reasoning enabled rejects non-default values (400 error)
  const params: any = {
    model: "gpt-5.1-2025-11-13",
    input: promptText,
    tools: [{
      type: "web_search",
      filters: {
        allowed_domains: [domainHostname]
      }
    }],
    max_tool_calls: toolCallsPerModel, // Dynamic: pages + buffer for retries
    max_output_tokens: 20000,
    include: ["web_search_call.action.sources"],
    text: {
      format: { type: "text" },
      verbosity: "low"
    },
    reasoning: {
      effort: "low", // Low reasoning for speed
      summary: null
    },
    store: true
  }

  Logger.debug(`[ParallelAudit] [${category}] Calling OpenAI API with ${toolCallsPerModel} max tool calls...`)
  const response = await client.responses.create(params)

  // Poll for completion
  let finalResponse = response
  let status = response.status as string
  let attempts = 0
  const maxAttempts = 240 // 4 minutes max

  while ((status === "queued" || status === "in_progress") && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    finalResponse = await client.responses.retrieve(response.id)
    status = finalResponse.status as string
    attempts++
  }

  const durationMs = Date.now() - startTime
  Logger.debug(`[ParallelAudit] [${category}] Completed with status: ${status} in ${(durationMs / 1000).toFixed(1)}s`)

  // Check for timeout or failure (accept "incomplete" for partial results at token limit)
  if (status !== "completed" && status !== "incomplete") {
    return {
      category,
      issues: [],
      openedPages: [],
      pagesAudited: 0,
      durationMs,
      status: "failed",
      error: `Model status: ${status}`
    }
  }

  // Extract opened pages from tool calls
  const openedPages: string[] = []
  if (Array.isArray(finalResponse.output)) {
    for (const item of finalResponse.output) {
      const action = (item as { type?: string; action?: { type?: string; url?: string } }).action
      if (item.type === 'web_search_call' && action?.type === 'open_page' && action.url) {
        openedPages.push(action.url)
      }
    }
  }

  // Parse output
  const outputText = finalResponse.output_text || ''

  // Check for bot protection
  if (outputText.trim() === "BOT_PROTECTION_OR_FIREWALL_BLOCKED") {
    return {
      category,
      issues: [],
      openedPages: [],
      pagesAudited: 0,
      durationMs,
      status: "failed",
      error: "Bot protection detected"
    }
  }

  // Parse JSON
  let issues: CategoryAuditResult['issues'] = []
  let pagesAudited = 0

  if (outputText && outputText.trim() !== 'null') {
    try {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        issues = (parsed.issues || []).map((issue: any) => ({
          ...issue,
          category // Ensure category is always set correctly
        }))
        pagesAudited = parsed.pages_audited || openedPages.length || 0
      }
    } catch (e) {
      Logger.warn(`[ParallelAudit] [${category}] Failed to parse JSON: ${e}`)
    }
  }

  return {
    category,
    issues,
    openedPages,
    pagesAudited,
    durationMs,
    status: "success"
  }
}

// Retry wrapper for category audits
async function runCategoryAuditWithRetry(
  category: ContentAuditCategory,
  urlsToAudit: string[],
  domainHostname: string,
  manifestText: string,
  issueContext?: AuditIssueContext,
  openai?: OpenAI,
  keywords?: { ignore?: string[]; flag?: string[] }
): Promise<CategoryAuditResult> {
  try {
    return await runCategoryAudit(category, urlsToAudit, domainHostname, manifestText, issueContext, openai, keywords)
  } catch (error) {
    Logger.warn(`[ParallelAudit] [${category}] Failed, retrying once...`)
    // Wait 2s before retry
    await new Promise(resolve => setTimeout(resolve, 2000))
    try {
      return await runCategoryAudit(category, urlsToAudit, domainHostname, manifestText, issueContext, openai, keywords)
    } catch (retryError) {
      Logger.error(`[ParallelAudit] [${category}] Retry failed`, retryError instanceof Error ? retryError : undefined)
      return {
        category,
        issues: [],
        openedPages: [],
        pagesAudited: 0,
        durationMs: 0,
        status: "failed",
        error: retryError instanceof Error ? retryError.message : "Unknown error"
      }
    }
  }
}

/**
 * Deduplicate issues within a single audit run by (page_url, normalized description).
 * Keeps the higher-severity issue when duplicates are found.
 * Uses substring containment or >80% character overlap as similarity measure.
 */
function deduplicateIssues(issues: AuditResult['issues']): AuditResult['issues'] {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim()

  const isSimilar = (a: string, b: string): boolean => {
    const na = normalize(a)
    const nb = normalize(b)
    if (na === nb) return true
    if (na.includes(nb) || nb.includes(na)) return true
    // Jaccard-like character overlap: shared chars / max length
    const setA = new Set(na)
    const setB = new Set(nb)
    const shared = [...setA].filter(c => setB.has(c)).length
    const maxLen = Math.max(setA.size, setB.size)
    if (maxLen === 0) return true
    return shared / maxLen > 0.8
  }

  const severityRank: Record<string, number> = { critical: 3, medium: 2, low: 1 }

  const deduped: AuditResult['issues'] = []

  for (const issue of issues) {
    const existingIdx = deduped.findIndex(
      d => d.page_url === issue.page_url && isSimilar(d.issue_description, issue.issue_description)
    )
    if (existingIdx === -1) {
      deduped.push(issue)
    } else {
      // Keep higher severity
      const existingRank = severityRank[deduped[existingIdx].severity] ?? 0
      const newRank = severityRank[issue.severity] ?? 0
      if (newRank > existingRank) {
        deduped[existingIdx] = issue
      }
    }
  }

  const dropped = issues.length - deduped.length
  if (dropped > 0) {
    Logger.info(`[Dedup] Removed ${dropped} duplicate issues (${deduped.length} remaining)`)
  }

  return deduped
}

// Merge results from parallel audits
function mergeParallelResults(
  results: CategoryAuditResult[],
  discoveredPages: string[]
): { issues: AuditResult['issues'], pagesAudited: number, openedPages: string[] } {
  // Combine all issues
  const allIssues = results.flatMap(r => r.issues)

  // Dedupe pages across all models
  const uniquePages = new Set<string>()
  for (const result of results) {
    for (const page of result.openedPages) {
      // Normalize URL for deduplication
      const normalized = page.replace(/\/$/, "").toLowerCase()
      uniquePages.add(normalized)
    }
  }

  return {
    issues: allIssues,
    pagesAudited: uniquePages.size,
    openedPages: Array.from(uniquePages)
  }
}

/**
 * Parallel Mini Audit for FREE tier
 * Runs 3 specialized models simultaneously, one for each category
 * All models audit the SAME set of pre-selected pages for consistent tracking
 */
export async function parallelMiniAudit(
  domain: string,
  issueContext?: AuditIssueContext,
  runId?: string,
  options?: { includeLongformFullAudit?: boolean; brandVoice?: { profile: BrandVoiceProfileForAudit } }
): Promise<AuditResult> {
  // Normalize domain URL
  const normalizedDomain = normalizeDomain(domain)
  const domainHostname = extractDomainHostname(normalizedDomain)

  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 300000, // 5min timeout
  })

  try {
    Logger.info(`[ParallelAudit] Starting parallel audit for ${normalizedDomain}`)
    const startTime = Date.now()

    // Extract content using Firecrawl (bot-protected crawling)
    Logger.debug(`[ParallelAudit] Crawling website with Firecrawl...`)
    const firecrawlManifest = await extractWithFirecrawl(
      normalizedDomain,
      'FREE',
      options?.includeLongformFullAudit ?? false
    )
    const manifestText = formatFirecrawlForPrompt(firecrawlManifest)
    const pagesFound = countPagesFound(firecrawlManifest)
    const discoveredPagesList = getDiscoveredPages(firecrawlManifest)
    const pagesToAudit = getAuditedUrls(firecrawlManifest)
    Logger.debug(`[ParallelAudit] Firecrawl extraction complete (${firecrawlManifest.pages.length} pages crawled, ${pagesFound} URLs discovered)`)

    // Store pages_found in database immediately
    if (runId && pagesFound > 0) {
      try {
        await supabaseAdmin
          .from('brand_audit_runs')
          .update({ pages_found: pagesFound })
          .eq('id', runId)
        Logger.debug(`[ParallelAudit] Updated pages_found: ${pagesFound}`)
      } catch (err) {
        Logger.warn('[ParallelAudit] Failed to update pages_found', err instanceof Error ? err : undefined)
      }
    }

    // Firecrawl already selected pages during crawl (limit configured in extractWithFirecrawl)
    Logger.info(`[ParallelAudit] Auditing ${pagesToAudit.length} pages: ${pagesToAudit.slice(0, 3).join(', ')}${pagesToAudit.length > 3 ? '...' : ''}`)

    // Keywords from brand voice profile (shared by category models and brand voice)
    const ignoreKeywords = options?.brandVoice?.profile?.ignore_keywords ?? []
    const flagKeywords = options?.brandVoice?.profile?.flag_keywords ?? []
    const keywords =
      (Array.isArray(ignoreKeywords) && ignoreKeywords.length > 0) || (Array.isArray(flagKeywords) && flagKeywords.length > 0)
        ? { ignore: Array.isArray(ignoreKeywords) ? ignoreKeywords : [], flag: Array.isArray(flagKeywords) ? flagKeywords : [] }
        : undefined

    // Run category audits and optionally brand voice in parallel
    const categoryPromises = [
      runCategoryAuditWithRetry("Language", pagesToAudit, domainHostname, manifestText, issueContext, openai, keywords),
      runCategoryAuditWithRetry("Facts & Consistency", pagesToAudit, domainHostname, manifestText, issueContext, openai, keywords),
      runCategoryAuditWithRetry("Formatting", pagesToAudit, domainHostname, manifestText, issueContext, openai, keywords),
    ]

    const brandVoicePromise = options?.brandVoice
      ? runBrandVoiceAuditPass(normalizedDomain, manifestText, pagesToAudit, options.brandVoice.profile, { tier: "FREE", openai, issueContext })
      : null
    const allPromises = brandVoicePromise
      ? [...categoryPromises, brandVoicePromise]
      : categoryPromises
    Logger.info(`[ParallelAudit] Running ${allPromises.length} parallel audits on ${pagesToAudit.length} pages...`)
    const results = await Promise.allSettled(allPromises)

    // Collect successful category results
    const successfulResults: CategoryAuditResult[] = []
    const failedCategories: string[] = []
    const categoryResultCount = categoryPromises.length
    const brandVoiceIndex = categoryResultCount

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (i < categoryResultCount) {
        // Category audit results
        if (result.status === "fulfilled" && (result as PromiseFulfilledResult<CategoryAuditResult>).value.status === "success") {
          const value = (result as PromiseFulfilledResult<CategoryAuditResult>).value
          successfulResults.push(value)
          Logger.debug(`[ParallelAudit] ${value.category}: ${value.issues.length} issues in ${(value.durationMs / 1000).toFixed(1)}s`)
        } else if (result.status === "fulfilled") {
          const value = (result as PromiseFulfilledResult<CategoryAuditResult>).value
          failedCategories.push(`${value.category} (${value.error || "unknown"})`)
          Logger.warn(`[ParallelAudit] ${value.category} failed: ${value.error}`)
        } else {
          failedCategories.push(`unknown (${(result as PromiseRejectedResult).reason})`)
          Logger.error(`[ParallelAudit] Category audit rejected`, (result as PromiseRejectedResult).reason instanceof Error ? (result as PromiseRejectedResult).reason : undefined)
        }
      } else if (i === brandVoiceIndex) {
        // Brand voice result
        if (result.status === "fulfilled") {
          const bvIssues = (result as PromiseFulfilledResult<AuditResult["issues"]>).value
          Logger.debug(`[ParallelAudit] Content checks (readability/AI/voice): ${bvIssues.length} issues`)
        } else {
          Logger.warn(`[ParallelAudit] Content checks failed:`, (result as PromiseRejectedResult).reason)
        }
      }
    }

    // Check if all category audits failed (brand voice is optional)
    if (successfulResults.length === 0) {
      throw new Error(`All parallel audits failed: ${failedCategories.join(", ")}`)
    }

    // Merge category results
    const { issues: categoryIssues } = mergeParallelResults(successfulResults, discoveredPagesList)

    // Extract brand voice issues
    const brandVoiceIssues =
      brandVoicePromise && results[brandVoiceIndex]?.status === "fulfilled"
        ? (results[brandVoiceIndex] as PromiseFulfilledResult<AuditResult["issues"]>).value
        : []

    // Merge all issues: category + brand voice + link validation
    const linkValidationIssues = firecrawlManifest.linkValidationIssues || []
    const mergedForDedup = [...categoryIssues, ...brandVoiceIssues]
    // Dedup before verification pass
    const dedupedIssues = deduplicateIssues(mergedForDedup)
    const unverifiedIssues = dedupedIssues
    // Verify model-generated issues against source HTML, then add link validation (already verified by crawler)
    const issues = [...verifyIssuesAgainstHtml(unverifiedIssues, firecrawlManifest), ...linkValidationIssues]
    const totalDurationMs = Date.now() - startTime

    Logger.info(`[ParallelAudit] Completed: ${issues.length} issues from ${successfulResults.length}/${categoryResultCount} categories${brandVoicePromise ? " + content checks" : ""} in ${(totalDurationMs / 1000).toFixed(1)}s`)
    Logger.info(`[ParallelAudit] Pages audited: ${pagesToAudit.length} (exact)`)
    if (failedCategories.length > 0) {
      Logger.warn(`[ParallelAudit] Partial results - failed categories: ${failedCategories.join(", ")}`)
    }

    return {
      issues,
      pagesAudited: pagesToAudit.length, // EXACT count from pre-selected URLs
      discoveredPages: discoveredPagesList,
      auditedUrls: pagesToAudit, // EXACT list of audited URLs
      status: "completed",
      tier: "FREE",
      modelDurationMs: totalDurationMs,
      manifestText,
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[ParallelAudit] ❌ Full error:`, error.message)
      console.error(`[ParallelAudit] Stack:`, error.stack)
    } else {
      console.error(`[ParallelAudit] ❌ Unknown error:`, error)
    }
    Logger.error(`[ParallelAudit] Error`, error instanceof Error ? error : undefined)
    throw handleAuditError(error)
  }
}

// ============================================================================
// Parallel Pro Audit - PAID tier with 3 concurrent specialized models
// Same approach as parallelMiniAudit but with more pages (20 vs 5)
// ============================================================================

/**
 * Parallel Pro Audit for PAID tier
 * Runs 3 specialized models simultaneously, one for each category
 * All models audit the SAME set of pre-selected pages for consistent tracking
 */
export async function parallelProAudit(
  domain: string,
  issueContext?: AuditIssueContext,
  runId?: string,
  options?: { includeLongformFullAudit?: boolean; brandVoice?: { profile: BrandVoiceProfileForAudit } }
): Promise<AuditResult> {
  // Normalize domain URL
  const normalizedDomain = normalizeDomain(domain)
  const domainHostname = extractDomainHostname(normalizedDomain)

  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 450000, // 7.5min timeout for Pro
  })

  try {
    Logger.info(`[ParallelProAudit] Starting parallel Pro audit for ${normalizedDomain}`)
    const startTime = Date.now()

    // Extract content using Firecrawl (bot-protected crawling)
    Logger.debug(`[ParallelProAudit] Crawling website with Firecrawl...`)
    const firecrawlManifest = await extractWithFirecrawl(
      normalizedDomain,
      'PAID',
      options?.includeLongformFullAudit ?? false
    )
    const manifestText = formatFirecrawlForPrompt(firecrawlManifest)
    const pagesFound = countPagesFound(firecrawlManifest)
    const discoveredPagesList = getDiscoveredPages(firecrawlManifest)
    const pagesToAudit = getAuditedUrls(firecrawlManifest)
    Logger.debug(`[ParallelProAudit] Firecrawl extraction complete (${firecrawlManifest.pages.length} pages crawled, ${pagesFound} URLs discovered)`)

    // Store pages_found in database immediately
    if (runId && pagesFound > 0) {
      try {
        await supabaseAdmin
          .from('brand_audit_runs')
          .update({ pages_found: pagesFound })
          .eq('id', runId)
        Logger.debug(`[ParallelProAudit] Updated pages_found: ${pagesFound}`)
      } catch (err) {
        Logger.warn('[ParallelProAudit] Failed to update pages_found', err instanceof Error ? err : undefined)
      }
    }

    // Firecrawl already selected pages during crawl (limit configured in extractWithFirecrawl)
    Logger.info(`[ParallelProAudit] Auditing ${pagesToAudit.length} pages: ${pagesToAudit.slice(0, 5).join(', ')}${pagesToAudit.length > 5 ? '...' : ''}`)

    // Keywords from brand voice profile (shared by category models and brand voice)
    const ignoreKeywordsPro = options?.brandVoice?.profile?.ignore_keywords ?? []
    const flagKeywordsPro = options?.brandVoice?.profile?.flag_keywords ?? []
    const keywordsPro =
      (Array.isArray(ignoreKeywordsPro) && ignoreKeywordsPro.length > 0) || (Array.isArray(flagKeywordsPro) && flagKeywordsPro.length > 0)
        ? { ignore: Array.isArray(ignoreKeywordsPro) ? ignoreKeywordsPro : [], flag: Array.isArray(flagKeywordsPro) ? flagKeywordsPro : [] }
        : undefined

    // Run category audits and optionally brand voice in parallel
    const categoryPromisesPro = [
      runCategoryAuditWithRetryPro("Language", pagesToAudit, domainHostname, manifestText, issueContext, openai, keywordsPro),
      runCategoryAuditWithRetryPro("Facts & Consistency", pagesToAudit, domainHostname, manifestText, issueContext, openai, keywordsPro),
      runCategoryAuditWithRetryPro("Formatting", pagesToAudit, domainHostname, manifestText, issueContext, openai, keywordsPro),
    ]

    const brandVoicePromisePro = options?.brandVoice
      ? runBrandVoiceAuditPass(normalizedDomain, manifestText, pagesToAudit, options.brandVoice.profile, { tier: "PAID", openai, issueContext })
      : null
    const allPromisesPro = brandVoicePromisePro
      ? [...categoryPromisesPro, brandVoicePromisePro]
      : categoryPromisesPro
    Logger.info(`[ParallelProAudit] Running ${allPromisesPro.length} parallel audits on ${pagesToAudit.length} pages...`)
    const resultsPro = await Promise.allSettled(allPromisesPro)

    // Collect successful category results
    const successfulResultsPro: CategoryAuditResult[] = []
    const failedCategoriesPro: string[] = []
    const categoryResultCountPro = categoryPromisesPro.length
    const brandVoiceIndexPro = categoryResultCountPro

    for (let i = 0; i < resultsPro.length; i++) {
      const result = resultsPro[i]
      if (i < categoryResultCountPro) {
        // Category audit results
        if (result.status === "fulfilled" && (result as PromiseFulfilledResult<CategoryAuditResult>).value.status === "success") {
          const value = (result as PromiseFulfilledResult<CategoryAuditResult>).value
          successfulResultsPro.push(value)
          Logger.debug(`[ParallelProAudit] ${value.category}: ${value.issues.length} issues in ${(value.durationMs / 1000).toFixed(1)}s`)
        } else if (result.status === "fulfilled") {
          const value = (result as PromiseFulfilledResult<CategoryAuditResult>).value
          failedCategoriesPro.push(`${value.category} (${value.error || "unknown"})`)
          Logger.warn(`[ParallelProAudit] ${value.category} failed: ${value.error}`)
        } else {
          failedCategoriesPro.push(`unknown (${(result as PromiseRejectedResult).reason})`)
          Logger.error(`[ParallelProAudit] Category audit rejected`, (result as PromiseRejectedResult).reason instanceof Error ? (result as PromiseRejectedResult).reason : undefined)
        }
      } else if (i === brandVoiceIndexPro) {
        // Brand voice result
        if (result.status === "fulfilled") {
          const bvIssues = (result as PromiseFulfilledResult<AuditResult["issues"]>).value
          Logger.debug(`[ParallelProAudit] Content checks (readability/AI/voice): ${bvIssues.length} issues`)
        } else {
          Logger.warn(`[ParallelProAudit] Content checks failed:`, (result as PromiseRejectedResult).reason)
        }
      }
    }

    if (successfulResultsPro.length === 0) {
      throw new Error(`All parallel audits failed: ${failedCategoriesPro.join(", ")}`)
    }

    const { issues: categoryIssuesPro } = mergeParallelResults(successfulResultsPro, discoveredPagesList)

    // Extract brand voice issues
    const brandVoiceIssuesPro =
      brandVoicePromisePro && resultsPro[brandVoiceIndexPro]?.status === "fulfilled"
        ? (resultsPro[brandVoiceIndexPro] as PromiseFulfilledResult<AuditResult["issues"]>).value
        : []

    // Merge all issues: category + brand voice + link validation
    const linkValidationIssuesPro = firecrawlManifest.linkValidationIssues || []
    const mergedForDedupPro = [...categoryIssuesPro, ...brandVoiceIssuesPro]
    // Dedup BEFORE checker pass to reduce checker token cost
    const unverifiedIssuesPro = deduplicateIssues(mergedForDedupPro)
    // Two-pass verification: model checker replaces regex filter for Pro tier
    // Brand voice issues are also run through the checker for consistency
    const checkedIssues = await runCheckerPass(unverifiedIssuesPro, firecrawlManifest, openai)
    // Link validation issues are already verified by crawler — add after checker
    const issues = [...checkedIssues, ...linkValidationIssuesPro]
    const totalDurationMs = Date.now() - startTime

    Logger.info(`[ParallelProAudit] Completed: ${issues.length} issues from ${successfulResultsPro.length}/${categoryResultCountPro} categories${brandVoicePromisePro ? " + content checks" : ""} in ${(totalDurationMs / 1000).toFixed(1)}s`)
    Logger.info(`[ParallelProAudit] Pages audited: ${pagesToAudit.length} (exact)`)
    if (failedCategoriesPro.length > 0) {
      Logger.warn(`[ParallelProAudit] Partial results - failed categories: ${failedCategoriesPro.join(", ")}`)
    }

    return {
      issues,
      pagesAudited: pagesToAudit.length, // EXACT count from pre-selected URLs
      discoveredPages: discoveredPagesList,
      auditedUrls: pagesToAudit, // EXACT list of audited URLs
      status: "completed",
      tier: "PAID",
      modelDurationMs: totalDurationMs,
      manifestText,
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[ParallelProAudit] ❌ Full error:`, error.message)
      console.error(`[ParallelProAudit] Stack:`, error.stack)
    } else {
      console.error(`[ParallelProAudit] ❌ Unknown error:`, error)
    }
    Logger.error(`[ParallelProAudit] Error`, error instanceof Error ? error : undefined)
    throw handleAuditError(error)
  }
}

// Run a single category audit for Pro tier (more tool calls)
async function runCategoryAuditPro(
  category: ContentAuditCategory,
  urlsToAudit: string[],
  domainHostname: string,
  manifestText: string,
  issueContext?: AuditIssueContext,
  openai?: OpenAI,
  keywords?: { ignore?: string[]; flag?: string[] }
): Promise<CategoryAuditResult> {
  const startTime = Date.now()

  const client = openai || createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 450000, // 7.5min for Pro
  })

  // Build category-specific prompt with explicit URL list
  const excludedIssuesJson = issueContext?.excluded?.length
    ? JSON.stringify(issueContext.excluded.filter(i => i.category === category))
    : "[]"
  const activeIssuesJson = issueContext?.active?.length
    ? JSON.stringify(issueContext.active.filter(i => i.category === category))
    : "[]"

  // Liberal prompt: optimized for recall, checker will filter false positives
  const promptText = buildLiberalCategoryAuditPrompt(
    category,
    urlsToAudit,
    manifestText,
    excludedIssuesJson,
    activeIssuesJson,
    keywords?.ignore,
    keywords?.flag
  )

  // Pro auditor uses gpt-5.1: stable, consistent output across runs.
  // gpt-5-mini was tested (ADR-003) and rejected due to high run-to-run variance
  // in issue count and category distribution — unacceptable for a quality-first product.
  // reasoning: null disables reasoning (not needed for high-recall auditing pass).
  const params: any = {
    model: "gpt-5.1-2025-11-13",
    input: promptText,
    tools: [{
      type: "web_search",
      filters: {
        allowed_domains: [domainHostname]
      }
    }],
    max_tool_calls: 15, // Pro tier: 15 tool calls per model (vs 4 for Free)
    max_output_tokens: 20000,
    include: ["web_search_call.action.sources"],
    text: {
      format: { type: "text" },
    },
    reasoning: null, // No reasoning for audit pass — checker handles quality gate
    store: true
  }

  Logger.debug(`[ParallelProAudit] [${category}] Calling OpenAI API...`)
  let response: any
  try {
    response = await client.responses.create(params)
  } catch (err: any) {
    // If reasoning:null is rejected by the API, fall back to lowest effort
    if (err?.message?.includes('reasoning') || err?.status === 400) {
      Logger.warn(`[ParallelProAudit] [${category}] reasoning:null rejected, falling back to effort:low`)
      params.reasoning = { effort: "low", summary: null }
      response = await client.responses.create(params)
    } else {
      throw err
    }
  }

  // Poll for completion with longer timeout for Pro
  let finalResponse = response
  let status = response.status as string
  let attempts = 0
  const maxAttempts = 420 // 7 minutes max for Pro

  while ((status === "queued" || status === "in_progress") && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    finalResponse = await client.responses.retrieve(response.id)
    status = finalResponse.status as string
    attempts++
  }

  const durationMs = Date.now() - startTime
  Logger.debug(`[ParallelProAudit] [${category}] Completed with status: ${status} in ${(durationMs / 1000).toFixed(1)}s`)

  // Check for timeout or failure (accept "incomplete" for partial results at token limit)
  if (status !== "completed" && status !== "incomplete") {
    return {
      category,
      issues: [],
      openedPages: [],
      pagesAudited: 0,
      durationMs,
      status: "failed",
      error: `Model status: ${status}`
    }
  }

  // Extract opened pages from tool calls
  const openedPages: string[] = []
  if (Array.isArray(finalResponse.output)) {
    for (const item of finalResponse.output) {
      const action = (item as { type?: string; action?: { type?: string; url?: string } }).action
      if (item.type === 'web_search_call' && action?.type === 'open_page' && action.url) {
        openedPages.push(action.url)
      }
    }
  }

  // Parse output
  const outputText = finalResponse.output_text || ''

  // Check for bot protection
  if (outputText.trim() === "BOT_PROTECTION_OR_FIREWALL_BLOCKED") {
    return {
      category,
      issues: [],
      openedPages: [],
      pagesAudited: 0,
      durationMs,
      status: "failed",
      error: "Bot protection detected"
    }
  }

  // Parse JSON
  let issues: CategoryAuditResult['issues'] = []
  let pagesAudited = 0

  if (outputText && outputText.trim() !== 'null') {
    try {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        issues = (parsed.issues || []).map((issue: any) => ({
          ...issue,
          category // Ensure category is always set correctly
        }))
        pagesAudited = parsed.pages_audited || openedPages.length || 0
      }
    } catch (e) {
      Logger.warn(`[ParallelProAudit] [${category}] Failed to parse JSON: ${e}`)
    }
  }

  return {
    category,
    issues,
    openedPages,
    pagesAudited,
    durationMs,
    status: "success"
  }
}

// Retry wrapper for Pro category audits
async function runCategoryAuditWithRetryPro(
  category: ContentAuditCategory,
  urlsToAudit: string[],
  domainHostname: string,
  manifestText: string,
  issueContext?: AuditIssueContext,
  openai?: OpenAI,
  keywords?: { ignore?: string[]; flag?: string[] }
): Promise<CategoryAuditResult> {
  try {
    return await runCategoryAuditPro(category, urlsToAudit, domainHostname, manifestText, issueContext, openai, keywords)
  } catch (error) {
    Logger.warn(`[ParallelProAudit] [${category}] Failed, retrying once...`)
    // Wait 2s before retry
    await new Promise(resolve => setTimeout(resolve, 2000))
    try {
      return await runCategoryAuditPro(category, urlsToAudit, domainHostname, manifestText, issueContext, openai, keywords)
    } catch (retryError) {
      Logger.error(`[ParallelProAudit] [${category}] Retry failed`, retryError instanceof Error ? retryError : undefined)
      return {
        category,
        issues: [],
        openedPages: [],
        pagesAudited: 0,
        durationMs: 0,
        status: "failed",
        error: retryError instanceof Error ? retryError.message : "Unknown error"
      }
    }
  }
}

// ============================================================================
// Full Audit - Paid/Enterprise tier (GPT-5.1 with web_search, synchronous)
// ============================================================================
export async function auditSite(
  domain: string,
  tier: AuditTier = "PAID",
  issueContext?: AuditIssueContext,
  runId?: string,
  options?: { includeLongformFullAudit?: boolean }
): Promise<AuditResult> {
  // Type guard: FREE tier should use parallelMiniAudit() instead
  if (tier === 'FREE') {
    Logger.warn(`[AuditSite] FREE tier should use parallelMiniAudit(), not auditSite(). Falling back.`)
    return parallelMiniAudit(domain, issueContext, runId, { includeLongformFullAudit: options?.includeLongformFullAudit })
  }
  
  const tierConfig = AUDIT_TIERS[tier]

  // Normalize domain URL
  const normalizedDomain = normalizeDomain(domain)
  const domainHostname = extractDomainHostname(normalizedDomain)

  // Timeout supports 7min pro audits with buffer
  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 450000, // 7.5min
  })

  try {
    Logger.info(`[AuditSite] Starting GPT-5.1 web_search audit for ${normalizedDomain} (tier: ${tier}, synchronous mode)`)
    const modelStartTime = Date.now()

    // Extract content using Firecrawl (bot-protected crawling)
    Logger.debug(`[AuditSite] Crawling website with Firecrawl...`)
    const firecrawlManifest = await extractWithFirecrawl(normalizedDomain, tier === 'PAID' || (tier as string) === 'PRO' ? 'PAID' : 'FREE')
    const manifestText = formatFirecrawlForPrompt(firecrawlManifest)
    const pagesFound = countPagesFound(firecrawlManifest)
    const discoveredPagesList = getDiscoveredPages(firecrawlManifest)
    Logger.debug(`[AuditSite] Firecrawl extraction complete (${firecrawlManifest.pages.length} pages crawled, ${pagesFound} URLs discovered)`)

    // Store pages_found in database immediately
    if (runId && pagesFound > 0) {
      try {
        await supabaseAdmin
          .from('brand_audit_runs')
          .update({ pages_found: pagesFound })
          .eq('id', runId)
        Logger.debug(`[AuditSite] Updated pages_found: ${pagesFound}`)
      } catch (err) {
        Logger.warn('[AuditSite] Failed to update pages_found', err instanceof Error ? err : undefined)
        // Non-fatal - continue audit even if update fails
      }
    }

    // Build inline prompt with manifest
    const excludedIssuesJson = issueContext?.excluded?.length
      ? JSON.stringify(issueContext.excluded)
      : "[]"
    const activeIssuesJson = issueContext?.active?.length
      ? JSON.stringify(issueContext.active)
      : "[]"

    const promptText = buildFullAuditPrompt(
      normalizedDomain,
      manifestText,
      excludedIssuesJson,
      activeIssuesJson,
      options?.includeLongformFullAudit ?? false
    )

    // NOTE: temperature omitted — GPT-5.1 with reasoning enabled rejects non-default values (400 error)
    const params: any = {
      model: tierConfig.model,
      input: promptText,
      tools: [{
        type: "web_search",
        filters: {
          allowed_domains: [domainHostname]
        }
      }],
      max_tool_calls: tierConfig.maxToolCalls,
      max_output_tokens: 20000,
      include: ["web_search_call.action.sources"],
      text: {
        format: { type: "text" },
        verbosity: "low"
      },
      reasoning: {
        effort: "medium",
        summary: null
      },
      store: true,
      // Synchronous mode processes immediately (typically completes in 2-4 minutes)
    }
    
    // Create response with retry for transient errors (timeouts, rate limits)
    let response: any
    const maxCreateRetries = 2
    for (let attempt = 1; attempt <= maxCreateRetries; attempt++) {
      try {
        response = await openai.responses.create(params)
        break
      } catch (createError) {
        const isTimeout = createError instanceof Error && createError.message.includes('timed out')
        const isRateLimit = createError instanceof Error && createError.message.includes('rate')
        const isRetryable = isTimeout || isRateLimit
        
        if (isRetryable && attempt < maxCreateRetries) {
          const waitMs = attempt * 5000 // 5s, 10s backoff
          Logger.warn(`[AuditSite] Retryable error on attempt ${attempt}, waiting ${waitMs/1000}s...`, {
            error: createError instanceof Error ? createError.message : 'Unknown'
          })
          await new Promise(resolve => setTimeout(resolve, waitMs))
          continue
        }
        
        Logger.error(`[AuditSite] Error creating response`, createError instanceof Error ? createError : undefined, {
          params: JSON.stringify(params, null, 2),
          attempt
        })
        throw createError
      }
    }
    
    // Poll for completion with tier-specific timeout
    let status = response.status as string
    let finalResponse = response
    let pollCount = 0
    let consecutiveErrors = 0
    const maxPollSeconds = tierConfig.maxPollSeconds
    const pollIntervalMs = 2000 // Poll every 2 seconds
    const maxPollCount = Math.ceil(maxPollSeconds / (pollIntervalMs / 1000))
    const maxConsecutiveErrors = 5
    
    while ((status === "queued" || status === "in_progress") && pollCount < maxPollCount) {
      const pollStartTime = Date.now()
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      pollCount++
      
      let retrieveDuration = 0
      try {
        // Use a separate client with longer timeout for retrieve calls to avoid timeout issues
        const retrieveClient = createTracedOpenAIClient({
          apiKey: process.env.OPENAI_API_KEY,
          timeout: 30000, // 30s should be plenty for a simple status check
        })
        finalResponse = await retrieveClient.responses.retrieve(response.id)
        retrieveDuration = Date.now() - pollStartTime
        status = finalResponse.status as string
        consecutiveErrors = 0 // Reset on success
        
        // Log if retrieve call is slow (indicates network/API issues)
        if (retrieveDuration > 5000) {
          Logger.warn(`[AuditSite] Slow retrieve call: ${retrieveDuration}ms (responseId: ${response.id})`)
        }
      } catch (pollError) {
        consecutiveErrors++
        retrieveDuration = Date.now() - pollStartTime
        const elapsedSeconds = pollCount * (pollIntervalMs / 1000)
        Logger.warn(`[AuditSite] Poll error at ${elapsedSeconds}s (${consecutiveErrors}/${maxConsecutiveErrors}, retrieve took ${retrieveDuration}ms)`, { 
          error: pollError instanceof Error ? pollError.message : 'Unknown',
          responseId: response.id
        })
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(`Audit polling failed after ${consecutiveErrors} consecutive errors`)
        }
        continue
      }
      
      // Log progress every 15 polls (~30 seconds)
      if (pollCount % 15 === 0) {
        const elapsedSeconds = pollCount * (pollIntervalMs / 1000)
        const openedPages = extractOpenedPagesCount(finalResponse)
        Logger.info(`[AuditSite] Polling: ${status} (${elapsedSeconds}s / ${maxPollSeconds}s max, ${openedPages} pages opened, retrieve: ${retrieveDuration}ms)`)
      }
    }
    
    const pollSeconds = pollCount * (pollIntervalMs / 1000)
    
    const modelDurationMs = Date.now() - modelStartTime
    
    // Check if we timed out
    if (status === "queued" || status === "in_progress") {
      Logger.error(`[AuditSite] Audit timed out after ${pollSeconds}s (max: ${maxPollSeconds}s)`)
      throw new Error(`Audit timed out after ${Math.round(pollSeconds / 60)} minutes. The site may be too large or slow to audit.`)
    }
    
    if (status !== "completed" && status !== "incomplete") {
      throw new Error(`Audit failed with status: ${status}`)
    }
    
    // Extract output text
    let outputText = finalResponse.output_text || ''
    
    // If output_text not directly available, try to extract from output array
    if (!outputText && Array.isArray(finalResponse.output)) {
      const messageItems = finalResponse.output.filter((item: any) => item.type === 'message' && (item as any).content && Array.isArray((item as any).content))
      for (const message of messageItems.reverse()) {
        const content = (message as any).content
        const textItems = content.filter((item: any) => item.type === 'output_text' && item.text)
        if (textItems.length > 0) {
          outputText = textItems[textItems.length - 1].text
          break
        }
      }
    }
    
    if (!outputText) {
      throw new Error("GPT-5.1 returned empty response")
    }
    
    // Extract opened pages for auditedUrls and count tool calls
    const openedPages: string[] = []
    let toolCallsUsed = 0
    if (finalResponse.output && Array.isArray(finalResponse.output)) {
      const webSearchCalls = finalResponse.output.filter((item: any) => item.type === 'web_search_call')
      toolCallsUsed = webSearchCalls.length
      webSearchCalls.forEach((call: any) => {
        if (call.action?.type === 'open_page' && call.action.url) {
          openedPages.push(call.action.url)
        }
      })
    }
    
    Logger.info(`[AuditSite] Tool calls used: ${toolCallsUsed}/${tierConfig.maxToolCalls} (${openedPages.length} pages opened)`)
    
    // Check for bot protection string response (not JSON)
    const trimmedOutput = outputText.trim()
    if (trimmedOutput === "BOT_PROTECTION_OR_FIREWALL_BLOCKED") {
      Logger.warn(`[AuditSite] ⚠️ Bot protection detected by model`)
      throw new Error("Bot protection detected. Remove firewall/bot protection to crawl this site.")
    }
    
    // Try to parse JSON from output
    let parsed: any
    try {
      // Check for null response (no issues found)
      if (trimmedOutput === "null" || trimmedOutput === "null\n") {
        parsed = { issues: [], total_issues: 0, pages_with_issues: 0, pages_audited: openedPages.length || 0 }
      } else {
        const jsonMatch = outputText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0])
        } else {
          // Fallback: transform plain text to JSON
          const structuredOutput = await transformToStructuredJSON(outputText, normalizedDomain)
          parsed = JSON.parse(structuredOutput)
        }
      }
    } catch (parseError) {
      // Transform plain text to JSON
      const structuredOutput = await transformToStructuredJSON(outputText, normalizedDomain)
      parsed = JSON.parse(structuredOutput)
    }
    
    // Validate with Zod schema
    const validated = AuditResultSchema.parse(parsed)
    
    // Use opened pages for auditedUrls if available, otherwise extract from issues
    const auditedUrls = openedPages.length > 0 
      ? openedPages 
      : validated.issues.length > 0
        ? [...new Set(validated.issues.map((issue: any) => issue.page_url))]
        : []
    
    // Detect bot protection: if response completed quickly but no pages were opened
    // This indicates the site is blocking automated access
    const hasBotProtection = openedPages.length === 0 && auditedUrls.length === 0 && modelDurationMs < 5000
    if (hasBotProtection) {
      Logger.warn(`[AuditSite] ⚠️ Bot protection detected: Completed in ${modelDurationMs}ms with 0 pages opened. Site may be blocking automated access.`)
      // Check output text for bot protection indicators, or if no issues found (likely blocked)
      const outputShowsBotProtection = outputText && detectBotProtection(outputText)
      const noIssuesFound = validated.issues.length === 0
      
      // If bot protection indicators found OR no pages opened and no issues, throw error
      if (outputShowsBotProtection || (noIssuesFound && modelDurationMs < 3000)) {
        throw new Error("Bot protection detected. Remove firewall/bot protection to crawl this site.")
      }
    }
    
    // Calculate pagesAudited from response or opened pages
    const pagesAudited = validated.pages_audited 
      ?? openedPages.length 
      ?? (auditedUrls.length > 0 ? auditedUrls.length : 1)
    
    Logger.info(`[AuditSite] ✅ Complete: ${validated.issues.length} issues, ${pagesAudited} pages audited, ${auditedUrls.length} URLs (tier: ${tier})`)
    
    return {
      issues: validated.issues,
      pagesAudited,
      discoveredPages: discoveredPagesList,
      auditedUrls, // Deprecated: unreliable, just tool call URLs
      status: "completed",
      tier,
      modelDurationMs,
    }
  } catch (error) {
    Logger.error(`[AuditSite] Error`, error instanceof Error ? error : undefined)
    throw handleAuditError(error)
  }
}

// ============================================================================
// Poll audit status (legacy - kept for backward compatibility)
// ============================================================================
export async function pollAuditStatus(responseId: string, tier?: AuditTier): Promise<AuditResult> {
  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000,
  })

  try {
    // Poll response status - supports queued/in_progress/completed states (legacy only)
    const response = await openai.responses.retrieve(responseId)

    // Check both "queued" and "in_progress" states (cast to string for SDK type compat)
    const status = response.status as string
    if (status === "queued" || status === "in_progress") {
      // Try to extract progress info from partial response if available
      let auditedUrls: string[] = []
      let issues: any[] = []
      
      if (response.output_text) {
        try {
          const partial = JSON.parse(response.output_text)
          if (Array.isArray(partial.auditedUrls)) {
            auditedUrls = partial.auditedUrls
          }
          // Extract issues count from partial response if available
          if (Array.isArray(partial.issues)) {
            issues = partial.issues
          }
        } catch {
          // Ignore parse errors for partial responses
        }
      }
      
      // Calculate pagesAudited from auditedUrls (accurate count from opened pages)
      const pagesAudited = auditedUrls.length > 0 ? auditedUrls.length : 0
      
      return {
        issues,
        pagesAudited,
        discoveredPages: [],
        auditedUrls,
        responseId,
        status: status === "queued" ? "queued" : "in_progress",
        rawStatus: status,
      }
    }

    if (status === "completed" || (status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens")) {
      // Handle both completed and incomplete (max_output_tokens) statuses
      const isIncomplete = status === "incomplete"
      
      // Extract output_text first (may be in message.content)
      let outputText = response.output_text
      if (!outputText && Array.isArray(response.output)) {
        const messageItems = (response.output as any[]).filter((item: any) => item.type === 'message' && Array.isArray(item.content))
        for (const message of messageItems.reverse()) {
          const textItems = (message.content as any[]).filter((item: any) => item.type === 'output_text' && item.text)
          if (textItems.length > 0) {
            outputText = textItems[textItems.length - 1].text
            break
          }
        }
      }
      
      // Transform plain text to structured JSON if needed
      if (outputText && !outputText.trim().startsWith('{')) {
        outputText = await transformToStructuredJSON(outputText, '')
        response.output_text = outputText
      } else if (!outputText && isIncomplete) {
        // If incomplete with no output_text, create empty structure
        response.output_text = JSON.stringify({ issues: [], auditedUrls: [] })
      } else if (outputText) {
        // Update response with extracted text
        response.output_text = outputText
      }
      
      const result = parseAuditResponse(response, tier || "PAID")
      // Extract actual crawled URLs from response output
      const actualCrawledUrls = extractCrawledUrls(response)
      if (actualCrawledUrls.length > 0) {
        result.auditedUrls = actualCrawledUrls
      }
      
      return result
    }

    // Failed or cancelled
    console.error(`[Audit] Job failed or cancelled (${status}): ${responseId}`)
    console.error(`[Audit] Full response:`, JSON.stringify(response, null, 2))
    
    // Check if failure is due to model issues
    const error = response.error as any
    if (error?.code === 'model_not_found' || error?.message?.includes('verified')) {
      console.error(`[Audit] Model error during execution. Error: ${error?.message}`)
      throw new Error("The audit failed due to a model issue. Please try again in a few minutes.")
    }
    
    throw new Error(`Audit job failed with status: ${status}. ${error?.message || 'Please try again.'}`)
  } catch (error) {
    // Error will be logged by handleAuditError, so we don't duplicate here
    throw handleAuditError(error)
  }
}

// ============================================================================
// Transform plain text audit output to structured JSON using GPT-4o
// ============================================================================
async function transformToStructuredJSON(plainText: string, domain: string): Promise<string> {
  if (!plainText || plainText.trim().length === 0) {
    return JSON.stringify({ issues: [], auditedUrls: [] })
  }
  
  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000, // 30s timeout for tight pipeline
  })

  const systemPrompt = `You are a JSON transformer. Convert audit findings from plain text to structured JSON. Extract real URLs and data from the text - never use placeholder or example values.`

  const userPrompt = `Convert this audit report to JSON. Extract all real URLs and data from the text:

${plainText}

Return ONLY valid JSON matching this exact structure:
{
  "issues": [
    {
      "page_url": "<actual URL from text>",
      "category": "Language|Facts & Consistency|Formatting",
      "issue_description": "impact_word: concise problem description",
      "severity": "low|medium|critical",
      "suggested_fix": "Direct, actionable fix"
    }
  ],
  "total_issues": <number>,
  "pages_with_issues": <number>,
  "pages_audited": <number>
}

CRITICAL RULES:
- Extract real URLs from the text - never use placeholders like "example.com"
- Format issue_description as "impact_word: description" (e.g., "professionalism: typo found")
- If no issues found, return null (JSON null value)
- Return ONLY valid JSON, no markdown code blocks
- If the text mentions "${domain}", use that as the base URL`

  try {
    const transformStart = Date.now()
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1, // Lower temperature for more consistent transformation
      response_format: { type: "json_object" },
      max_tokens: 4000, // Limit to ensure fast response
    })

    const transformed = response.choices[0]?.message?.content
    if (!transformed) {
      throw new Error("Transformation returned empty response")
    }

    // Validate it's valid JSON
    try {
      JSON.parse(transformed)
    } catch (parseError) {
      console.error(`[Transform] Invalid JSON returned, attempting to clean...`)
      const cleaned = cleanJsonResponse(transformed)
      JSON.parse(cleaned) // Validate cleaned version
      return cleaned
    }

    return transformed
  } catch (error) {
    console.error(`[Transform] ❌ Error:`, error instanceof Error ? error.message : error)
    // Don't fallback - throw error to fail fast in tight pipeline
    throw new Error(`Failed to transform audit output: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// ============================================================================
// Intelligent Page Selection
// Uses fast model to select most important pages to audit
// ============================================================================

/**
 * Select best pages to audit from discovered URLs
 * Uses GPT-4.1-mini for fast, intelligent page selection
 * @param discoveredUrls All URLs found on the site
 * @param domain The domain being audited
 * @param tier FREE (5 pages) or PAID (20 pages)
 * @returns Array of URLs to audit
 */
async function selectPagesToAudit(
  discoveredUrls: string[],
  domain: string,
  tier: 'FREE' | 'PAID',
  includeLongformFullAudit: boolean
): Promise<string[]> {
  const targetCount = tier === 'FREE' ? 5 : 20

  // Always include homepage
  const homepage = discoveredUrls.find(u => {
    try {
      return new URL(u).pathname === '/' || new URL(u).pathname === ''
    } catch {
      return false
    }
  }) || `https://${domain}`

  const candidateUrls = includeLongformFullAudit
    ? discoveredUrls
    : discoveredUrls.filter((u) => !isLongformUrl(u))
  const urlsForSelection = candidateUrls.length > 0 ? candidateUrls : discoveredUrls

  // If we have fewer URLs than target, use all of them
  if (urlsForSelection.length <= targetCount) {
    Logger.info(`[PageSelection] Using all ${urlsForSelection.length} discovered URLs (≤${targetCount} target)`)
    return urlsForSelection.length > 0 ? urlsForSelection : [homepage]
  }

  const openai = createTracedOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000, // 30s timeout for quick selection
  })

  try {
    Logger.debug(`[PageSelection] Selecting ${targetCount} pages from ${urlsForSelection.length} discovered URLs`)

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{
        role: "user",
        content: `Pick the ${targetCount} most important pages to audit for content quality from this website.

CRITICAL: You MUST ONLY select URLs from the "Available URLs" list below. Do NOT make up or guess URLs.

Prioritize in order:
1. Homepage (always include)
2. Pricing/plans page (if one exists in the list)
3. About/company page (if one exists in the list)
4. Key product/feature pages
5. Contact/support page (if one exists in the list)
6. ${includeLongformFullAudit ? "Blog posts (1-2 max)" : "Avoid blog/article/resource pages unless no other pages are available"}
7. Other high-value marketing pages

Return ONLY a JSON object with this exact format: {"urls": ["url1", "url2", ...]}
Do not include any explanation or other text.
Only include URLs that appear in the list below.

Available URLs:
${urlsForSelection.join('\n')}`
      }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 2000
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      Logger.warn('[PageSelection] Empty response from model, falling back to first N URLs')
      return [homepage, ...urlsForSelection.filter(u => u !== homepage).slice(0, targetCount - 1)]
    }

    const result = JSON.parse(content)
    const selectedUrls = result.urls || []

    if (selectedUrls.length === 0) {
      Logger.warn('[PageSelection] No URLs selected by model, falling back to first N URLs')
      return [homepage, ...discoveredUrls.filter(u => u !== homepage).slice(0, targetCount - 1)]
    }

    // CRITICAL: Validate that selected URLs actually exist in discovered URLs
    // Prevents model from hallucinating URLs based on priority list (e.g., /pricing, /contact)
    const normalizeForComparison = (url: string) => {
      try {
        const parsed = new URL(url)
        return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '').toLowerCase()
      } catch {
        return url.replace(/\/$/, '').toLowerCase()
      }
    }

    const normalizedDiscoveredUrls = urlsForSelection.map(normalizeForComparison)
    const validUrls: string[] = []
    const hallucinatedUrls: string[] = []

    for (const url of selectedUrls) {
      const normalized = normalizeForComparison(url)
      if (normalizedDiscoveredUrls.includes(normalized)) {
        validUrls.push(url)
      } else {
        hallucinatedUrls.push(url)
      }
    }

    // Log hallucinated URLs for debugging
    if (hallucinatedUrls.length > 0) {
      Logger.warn(`[PageSelection] Model hallucinated ${hallucinatedUrls.length} URLs not in discovered list: ${hallucinatedUrls.join(', ')}`)
    }

    // If all URLs were hallucinated, fall back to default selection
    if (validUrls.length === 0) {
      Logger.warn('[PageSelection] All selected URLs were hallucinated, falling back to first N URLs')
      return [homepage, ...urlsForSelection.filter(u => u !== homepage).slice(0, targetCount - 1)]
    }

    // Ensure homepage is included
    if (!validUrls.includes(homepage)) {
      validUrls.unshift(homepage)
      if (validUrls.length > targetCount) {
        validUrls.pop()
      }
    }

    Logger.info(`[PageSelection] Selected ${validUrls.length} valid pages to audit (filtered ${hallucinatedUrls.length} hallucinated URLs)`)
    return validUrls
  } catch (error) {
    Logger.warn('[PageSelection] Error selecting pages, falling back to first N URLs', error instanceof Error ? error : undefined)
    // Fallback: homepage + first N-1 other URLs
    return [homepage, ...urlsForSelection.filter(u => u !== homepage).slice(0, targetCount - 1)]
  }
}

// ============================================================================
// Helper functions
// ============================================================================

const LONGFORM_PATH_PATTERNS = [
  /\/blog(\/|$)/i,
  /\/articles?(\/|$)/i,
  /\/news(\/|$)/i,
  /\/insights(\/|$)/i,
  /\/resources(\/|$)/i,
  /\/guides?(\/|$)/i,
  /\/case-studies?(\/|$)/i,
  /\/posts?(\/|$)/i,
]

export function isLongformUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`)
    const path = parsed.pathname || "/"
    return LONGFORM_PATH_PATTERNS.some((pattern) => pattern.test(path))
  } catch {
    return false
  }
}

// Normalize domain to proper URL format
function normalizeDomain(domain: string): string {
  let url = domain.trim()
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`
  }
  try {
    const parsed = new URL(url)
    return parsed.origin
  } catch {
    throw new Error(`Invalid domain: ${domain}`)
  }
}

// Extract domain from URL for filtering (removes http/https, returns domain only)
function extractDomainForFilter(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    return parsed.hostname // Returns just the domain, e.g., "vercel.com"
  } catch {
    // Fallback: try to extract domain manually
    const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/)
    return match ? match[1] : url
  }
}

// Validation helper removed - Zod schema handles validation

// Clean JSON response - remove markdown code blocks and extract valid JSON
// Similar to lib/openai.ts cleanResponse() but optimized for audit responses
function cleanJsonResponse(text: string): string {
  // Remove markdown code block syntax if it exists
  text = text.replace(/```(json|markdown)?\n?/g, "").replace(/```\n?/g, "")
  
  // Remove any leading/trailing whitespace
  text = text.trim()
  
  // Find the start of JSON (either [ or {)
  const jsonStart = Math.min(
    text.indexOf('[') >= 0 ? text.indexOf('[') : Infinity,
    text.indexOf('{') >= 0 ? text.indexOf('{') : Infinity
  )
  
  if (jsonStart < Infinity) {
    // Try to parse from this point
    let jsonText = text.substring(jsonStart)
    
    // Try to find valid JSON by attempting to parse progressively smaller substrings
    // This handles cases where there's trailing text after the JSON
    for (let i = jsonText.length; i > 0; i--) {
      try {
        const candidate = jsonText.substring(0, i)
        const parsed = JSON.parse(candidate)
        // If parse succeeds, re-stringify to clean format
        return JSON.stringify(parsed)
      } catch (e) {
        // Continue trying shorter substrings
      }
    }
    
    // If we couldn't find valid JSON, fall back to regex extraction
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/)
    const objectMatch = jsonText.match(/\{[\s\S]*\}/)
    
    if (arrayMatch) {
      return arrayMatch[0]
    } else if (objectMatch) {
      return objectMatch[0]
    }
  }
  
  // Fallback to original text if no JSON found
  return text
}

// Extract actual crawled URLs from Deep Research response output
// Extracts URLs from:
// 1. open_page actions (pages actually opened)
// 2. sources field (all URLs consulted during web search)
function extractCrawledUrls(response: any): string[] {
  const crawledUrls = new Set<string>()
  
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      // Extract URLs from web_search_call items that actually opened a page
      if (item.type === 'web_search_call' && item.action?.type === 'open_page') {
        const url = item.action?.url
        if (url && typeof url === 'string') {
          const cleanUrl = url.trim()
          if (cleanUrl && cleanUrl.startsWith('http') && !cleanUrl.includes('#:~:text=')) {
            const normalized = cleanUrl.replace(/\/+$/, '')
            crawledUrls.add(normalized)
          }
        }
      }
      
      // Extract URLs from sources field (all URLs consulted during web search)
      if (item.type === 'web_search_call' && item.action?.sources) {
        const sources = item.action.sources
        if (Array.isArray(sources)) {
          sources.forEach((source: any) => {
            // Sources can be objects with url field or strings
            const sourceUrl = typeof source === 'string' ? source : source.url || source
            if (sourceUrl && typeof sourceUrl === 'string') {
              const cleanUrl = sourceUrl.trim()
              if (cleanUrl && cleanUrl.startsWith('http') && !cleanUrl.includes('#:~:text=')) {
                const normalized = cleanUrl.replace(/\/+$/, '')
                crawledUrls.add(normalized)
              }
            }
          })
        }
      }
    }
  }
  
  return Array.from(crawledUrls).sort()
}


// Check if response indicates bot protection/firewall
function detectBotProtection(text: string): boolean {
  if (!text) return false
  
  const lowerText = text.toLowerCase()
  const botProtectionIndicators = [
    'cloudflare',
    'checking your browser',
    'please verify you are human',
    'verify you are human',
    'access denied',
    'bot protection',
    'firewall',
    'challenge page',
    'security check',
    'ddos protection',
    'just a moment',
    'ray id',
    'cf-ray',
    'unusual traffic',
    'automated access',
    'captcha',
    'recaptcha',
    'hcaptcha',
  ]
  
  return botProtectionIndicators.some(indicator => lowerText.includes(indicator))
}

// Parse and validate audit response from OpenAI
function parseAuditResponse(response: any, tier: AuditTier): AuditResult {
  // Extract output_text - SDK may provide it directly or we need to extract from output array
  let rawOutput = response.output_text
  
  // If output_text not directly available, try to extract from output array
  // GPT-5.1 responses have structure: output[] -> message -> content[] -> output_text
  if (!rawOutput && Array.isArray(response.output)) {
    // Find message items with content
    const messageItems = response.output.filter((item: any) => item.type === 'message' && Array.isArray(item.content))
    for (const message of messageItems.reverse()) { // Check from last to first
      const textItems = message.content.filter((item: any) => item.type === 'output_text' && item.text)
      if (textItems.length > 0) {
        // Use the last output_text item from the last message (final response)
        rawOutput = textItems[textItems.length - 1].text
        break
      }
    }
  }
  
  if (!rawOutput) {
    console.error("[Audit] Response missing output_text")
    console.error("[Audit] Response structure:", JSON.stringify({
      has_output_text: !!response.output_text,
      output_array_length: Array.isArray(response.output) ? response.output.length : 0,
      output_types: Array.isArray(response.output) ? response.output.map((item: any) => item.type).slice(-5) : []
    }))
    throw new Error("AI model returned empty response. Please try again.")
  }

  // Check for bot protection indicators in response
  if (detectBotProtection(rawOutput)) {
    throw new Error("Bot protection detected. Remove firewall/bot protection to crawl this site.")
  }

  let parsed: any
  
  // Attempt 1: Direct JSON parse
  try {
    parsed = JSON.parse(rawOutput)
  } catch (parseError) {
    // Attempt 2: Clean markdown and try again
    try {
      const cleaned = cleanJsonResponse(rawOutput)
      parsed = JSON.parse(cleaned)
    } catch (secondParseError) {
      console.error(`[Audit] JSON parse error:`, secondParseError instanceof Error ? secondParseError.message : "Unknown")
      console.error(`[Audit] Raw output (first 500 chars):`, rawOutput.substring(0, 500))
      throw new Error("AI model returned invalid JSON. Please try again.")
    }
  }

  // Validate with Zod schema
  let validated
  try {
    validated = AuditResultSchema.parse(parsed)
  } catch (zodError) {
    console.error("[Audit] Schema validation error:", zodError instanceof Error ? zodError.message : "Unknown")
    console.error("[Audit] Parsed JSON:", JSON.stringify(parsed, null, 2).substring(0, 1000))
    throw new Error("AI model returned data in unexpected format. Please try again.")
  }

  // Extract actual crawled URLs from response output (more accurate than text parsing)
  const actualCrawledUrls = extractCrawledUrls(response)
  const auditedUrls = actualCrawledUrls.length > 0 ? actualCrawledUrls : (Array.isArray(validated.auditedUrls) ? validated.auditedUrls : [])
  
  // Calculate pagesAudited from actual crawled URLs (accurate count)
  const pagesAudited = actualCrawledUrls.length > 0 ? actualCrawledUrls.length : (auditedUrls.length > 0 ? auditedUrls.length : 0)

  return {
    issues: validated.issues,
    pagesAudited,
    discoveredPages: actualCrawledUrls.length > 0 ? actualCrawledUrls : auditedUrls,
    auditedUrls,
    responseId: response.id,
    status: "completed",
    tier,
  }
}

// Extract OpenAI request ID from error message for logging
function extractRequestId(errorMessage: string): string | null {
  const match = errorMessage.match(/req_[a-z0-9]+/i)
  return match ? match[0] : null
}

// Map OpenAI errors to user-friendly messages
// Attaches originalError property so route handler can store raw error in DB for debugging
function handleAuditError(error: unknown): Error & { originalError?: string } {
  const rawMessage = error instanceof Error ? error.message : String(error)

  const sanitized = _sanitizeAuditError(error)
  // Attach raw message for DB debugging (only when message was actually changed)
  if (sanitized.message !== rawMessage) {
    ;(sanitized as Error & { originalError?: string }).originalError = rawMessage
  }
  return sanitized as Error & { originalError?: string }
}

function _sanitizeAuditError(error: unknown): Error {
  if (!(error instanceof Error)) {
    Logger.error("[Audit] Unknown error type", undefined, { error: String(error) })
    return new Error("Audit generation failed. Please try again.")
  }

  const msg = error.message.toLowerCase()

  // Detect OpenAI 500 errors with request IDs and help.openai.com references
  const isOpenAI500Error = (msg.includes("500") || msg.includes("error occurred while processing")) &&
                           (msg.includes("help.openai.com") || msg.includes("request id req_") || /req_[a-z0-9]+/i.test(error.message))

  if (isOpenAI500Error) {
    const requestId = extractRequestId(error.message)
    Logger.error("[Audit] OpenAI 500 error", error, {
      requestId,
      ...(process.env.NODE_ENV === 'development' ? { stack: error.stack } : {})
    })
    return new Error("Our AI service encountered a temporary issue. Please try again in a moment.")
  }

  // Log original error for debugging - simplified for expected errors
  const isExpectedError = msg.includes('bot protection') ||
                         msg.includes('daily limit') ||
                         msg.includes('invalid domain') ||
                         msg.includes('rate_limit') ||
                         msg.includes('429')

  if (isExpectedError) {
    Logger.error(`[Audit] ${error.message}`)
  } else {
    Logger.error(`[Audit] Error: ${error.message}`, error, {
      name: error.name,
      ...(process.env.NODE_ENV === 'development' ? { stack: error.stack } : {})
    })
  }

  // Bot protection detection (check first before other errors)
  if (detectBotProtection(msg)) {
    return new Error("Bot protection detected. Remove firewall/bot protection to crawl this site.")
  }

  // Rate limits
  if (msg.includes("rate_limit") || msg.includes("429")) {
    return new Error("AI service is temporarily overloaded. Please wait a moment and try again.")
  }

  // Auth errors
  if (msg.includes("401") || msg.includes("invalid_api_key") || msg.includes("authentication")) {
    Logger.error("[Audit] API key error - check OPENAI_API_KEY")
    return new Error("AI service authentication failed. Please contact support.")
  }

  // Timeout
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("aborted")) {
    return new Error("Request timed out. The site may be too large. Please try again.")
  }

  // Network
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) {
    return new Error("Network error connecting to AI service. Please check your connection.")
  }

  // Content filter
  if (msg.includes("content-filter") || msg.includes("content_policy")) {
    return new Error("Content was blocked by safety filters. Try a different URL.")
  }

  // Model unavailable
  if (msg.includes("model") && (msg.includes("not found") || msg.includes("unavailable"))) {
    return new Error("AI model is temporarily unavailable. Please try again in a few minutes.")
  }

  // Pass through our custom errors (including bot protection error)
  if (msg.includes("bot protection") || msg.includes("ai model") || msg.includes("ai service") || msg.includes("invalid domain")) {
    return error
  }

  // Fallback - sanitize any remaining OpenAI errors
  if (error.message && error.message.length > 0) {
    if (msg.includes("help.openai.com") || /req_[a-z0-9]+/i.test(error.message)) {
      const requestId = extractRequestId(error.message)
      Logger.error("[Audit] Unhandled OpenAI error", error, {
        requestId,
        ...(process.env.NODE_ENV === 'development' ? { stack: error.stack } : {})
      })
      return new Error("Our AI service encountered an issue. Please try again in a moment.")
    }

    return new Error("Audit generation failed. Please try again.")
  }

  return new Error("Audit generation failed. Please try again.")
}