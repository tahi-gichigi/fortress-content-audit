/**
 * Brand voice issue detection pass for audits.
 * Uses stored config + voice summary; optional AI-writing red flags for long-form content.
 */

import OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import Logger from "./logger"
import { createTracedOpenAIClient } from "./langsmith-openai"

export interface BrandVoiceProfileForAudit {
  voice_summary: string | null
  readability_level: string | null
  formality: string | null
  locale: string | null
  flag_keywords: string[] | null
  ignore_keywords: string[] | null
  flag_ai_writing: boolean
  use_guidelines: boolean
}

export interface BrandVoiceIssue {
  page_url: string
  category: "Brand voice"
  issue_description: string
  severity: "low" | "medium" | "critical"
  suggested_fix: string
}

const RED_FLAGS_MD_PATH = path.join(process.cwd(), "red-flags-ai-writing.md")

function getRedFlagsContent(): string {
  try {
    return fs.readFileSync(RED_FLAGS_MD_PATH, "utf-8")
  } catch {
    return "(Red flags reference not found.)"
  }
}

/** Issue context shape (excluded/active) — matches AuditIssueContext from audit.ts without importing */
interface BrandVoiceIssueContext {
  excluded: Array<{ page_url: string; category: string; issue_description: string }>
  active: Array<{ page_url: string; category: string; issue_description: string }>
}

function buildBrandVoiceAuditPrompt(
  domainHostname: string,
  manifestText: string,
  discoveredPages: string[],
  profile: BrandVoiceProfileForAudit,
  pageLimit: number,
  issueContext?: BrandVoiceIssueContext
): string {
  const useGuidelines = profile.use_guidelines === true
  const ignoreList = Array.isArray(profile.ignore_keywords) ? profile.ignore_keywords : []
  const flagList = Array.isArray(profile.flag_keywords) ? profile.flag_keywords : []

  // Filter to Brand voice only for excluded/active blocks
  const excludedBrandVoice = issueContext?.excluded?.filter((i) => i.category === "Brand voice") ?? []
  const activeBrandVoice = issueContext?.active?.filter((i) => i.category === "Brand voice") ?? []
  const excludedBlock =
    excludedBrandVoice.length > 0
      ? `\n# Previously Resolved/Ignored Issues\nDO NOT report these again:\n${JSON.stringify(excludedBrandVoice)}\n`
      : ""
  const activeBlock =
    activeBrandVoice.length > 0
      ? `\n# Active Issues from Previous Audit\nVerify if these still exist:\n${JSON.stringify(activeBrandVoice)}\n`
      : ""

  const configLines: string[] = []
  if (profile.readability_level) configLines.push(`- Readability: ${profile.readability_level}`)
  if (profile.formality) configLines.push(`- Formality: ${profile.formality}`)
  if (profile.locale) configLines.push(`- Locale: ${profile.locale}`)
  if (useGuidelines && profile.voice_summary) {
    configLines.push(`- Voice summary: ${profile.voice_summary}`)
  } else if (useGuidelines) {
    configLines.push(`- Voice summary: (No voice summary set.)`)
  }

  const configBlock = configLines.length > 0 ? `# Configuration\n\n${configLines.join("\n")}\n\n---` : ""

  // Dedicated section for flag keywords (like ignored issues section in other prompts)
  const flagKeywordsBlock = flagList.length > 0
    ? `\n# Flag Keywords (User's Flag List)\n\nALWAYS flag these terms when they appear in copy:\n${flagList.map(kw => `- ${kw}`).join("\n")}\n\nIf any of these terms appear on a page, report a Brand voice issue citing "Flag keywords:" as the guideline.\n`
    : ""

  // Dedicated section for ignore keywords (like ignored issues section in other prompts)
  const ignoreKeywordsBlock = ignoreList.length > 0
    ? `\n# Allowed Terms (User's Ignore List)\n\nDO NOT flag or suggest changing these terms:\n${ignoreList.map(kw => `- ${kw}`).join("\n")}\n\nThese terms are explicitly allowed. Do not report issues about them, suggest varying their use, recommend replacing them with pronouns, or mention them negatively in any way.\n`
    : ""

  const instructionParts: string[] = [
    "Audit each page in the list below.",
    "Apply content checks: readability, formality, locale, and flagged terms.",
    "For every issue you report, state which guideline or setting the copy conflicts with: Readability, Formality, Locale, Voice summary, Flag keywords, or AI-writing. Do not flag things as bare opinion—tie each finding to a specific config item above.",
  ]
  if (useGuidelines) {
    instructionParts.push(
      "Also check that copy matches the intended voice (voice summary). Flag em dashes, overused phrases, and tone issues only when they clearly conflict with a stated guideline. Do not limit to long-form—homepage, landing, and product pages can have voice issues."
    )
  } else {
    instructionParts.push("Do not evaluate against brand voice guidelines; only apply the content checks above.")
  }

  let aiWritingBlock = ""
  if (profile.flag_ai_writing) {
    const redFlags = getRedFlagsContent()
    aiWritingBlock = `

# AI-writing detection (long-form content only)

Apply only on long-form content (blog posts, articles, about pages with significant copy). Do NOT flag short UI copy or product pages.
Raise AI-writing red flags only when you see **multiple, consistent** markers—not one-off signals. High confidence required.

Reference:
${redFlags}

If you find multiple consistent signs of AI-generated writing on a long-form page, add a Brand voice issue. Start the issue_description with "AI-writing:" and cite which red flag(s) apply, so it is clear the finding conflicts with the AI-writing guideline. If the content looks human or you see only one weak signal, do not flag.`
  }

  const pagesList = discoveredPages.slice(0, pageLimit).join(", ") || "homepage"

  return `# Task

You are auditing ${domainHostname} for **Brand voice** only. Use the manifest and open pages as needed.

${manifestText}

---

${configBlock}
# Instructions

${instructionParts.join(" ")}

Pages to audit: ${pagesList}
${aiWritingBlock}
${flagKeywordsBlock}
${ignoreKeywordsBlock}
${excludedBlock}
${activeBlock}
---

# Output format

- Category for every issue: exactly "Brand voice".
- issue_description: start with the **guideline or setting** the copy conflicts with, then the problem. Use the exact config name and value where relevant, e.g. "Readability (grade_6_8): …", "Formality (casual): …", "Voice summary (Friendly and clear): …", "Flag keywords: …", "Locale (en-US): …", "AI-writing: …". This makes it clear which config the finding refers to, not opinion.
- severity: "critical", "medium", or "low".
- suggested_fix: direct, actionable fix.

Return JSON only, no markdown fences:
- If issues found: { "issues": [ { "page_url", "category": "Brand voice", "issue_description", "severity", "suggested_fix" }, ... ], "total_issues", "pages_with_issues", "pages_audited" }
- If no issues: null
- If bot/firewall block: BOT_PROTECTION_OR_FIREWALL_BLOCKED`
}

export async function runBrandVoiceAuditPass(
  domain: string,
  manifestText: string,
  discoveredPages: string[],
  profile: BrandVoiceProfileForAudit,
  options?: { tier?: 'FREE' | 'PAID' | 'ENTERPRISE'; openai?: OpenAI; issueContext?: BrandVoiceIssueContext }
): Promise<BrandVoiceIssue[]> {
  const { tier = 'FREE', openai: providedClient, issueContext } = options || {}
  const client = providedClient || createTracedOpenAIClient({ apiKey: process.env.OPENAI_API_KEY, timeout: 300000 })
  // Page limits and tool calls matching main audit models
  const pageLimit = tier === 'FREE' ? 5 : tier === 'PAID' ? 20 : 50
  const maxToolCalls = tier === 'FREE' ? 10 : tier === 'PAID' ? 15 : 30
  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`
  let domainHostname: string
  try {
    domainHostname = new URL(baseUrl).hostname
  } catch {
    domainHostname = domain
  }

  const promptText = buildBrandVoiceAuditPrompt(domainHostname, manifestText, discoveredPages, profile, pageLimit, issueContext)

  try {
    const response = await client.responses.create({
      model: "gpt-5.1-2025-11-13",
      input: promptText,
      tools: [{ type: "web_search", filters: { allowed_domains: [domainHostname] } }],
      max_tool_calls: maxToolCalls,
      max_output_tokens: 8000,
      text: { format: { type: "text" } },
      reasoning: { effort: "low", summary: null },
      store: true,
    } as any)

    let finalResponse = response
    let status = (finalResponse as any).status as string
    let attempts = 0
    while ((status === "queued" || status === "in_progress") && attempts < 180) {
      await new Promise((r) => setTimeout(r, 1000))
      finalResponse = await client.responses.retrieve((response as any).id)
      status = (finalResponse as any).status as string
      attempts++
    }

    if (status !== "completed" && status !== "incomplete") {
      Logger.warn("[BrandVoiceAudit] Model did not complete", { status })
      return []
    }

    const outputText = (finalResponse as any).output_text || ""
    if (outputText.trim() === "BOT_PROTECTION_OR_FIREWALL_BLOCKED") return []

    if (!outputText.trim() || outputText.trim() === "null") return []

    const jsonMatch = outputText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0])
    const issues = (parsed.issues || []) as Array<Record<string, unknown>>
    return issues
      .filter((i) => i && typeof i.page_url === "string" && typeof i.issue_description === "string")
      .map((i) => ({
        page_url: String(i.page_url),
        category: "Brand voice" as const,
        issue_description: String(i.issue_description),
        severity: (i.severity === "critical" || i.severity === "medium" ? i.severity : "low") as "low" | "medium" | "critical",
        suggested_fix: typeof i.suggested_fix === "string" ? i.suggested_fix : "",
      }))
  } catch (e) {
    Logger.warn("[BrandVoiceAudit] Error", e instanceof Error ? e.message : String(e))
    return []
  }
}
