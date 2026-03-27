/**
 * Pure filtering logic for the two-pass model checker.
 * Single source of truth — imported by both audit.ts and tests.
 *
 * No OpenAI, Supabase, or async imports.
 * The decision tree that determines which issues survive the checker pass.
 */

export type Severity = 'critical' | 'medium' | 'low'

export interface RawIssue {
  page_url: string
  category: string
  issue_description: string
  severity: Severity
  suggested_fix: string
}

export interface CheckerVerification {
  index: number
  confirmed: boolean | 'uncertain'
  confidence: number
  severity?: string
  evidence: string
}

export interface CheckedIssue extends RawIssue {
  evidence: string
  confidence: number
}

/**
 * Apply checker decisions to filter and enrich raw issues.
 *
 * Decision tree:
 * - Keep if confirmed=true
 * - Keep if confirmed='uncertain' and confidence >= 0.7
 * - Drop everything else
 *
 * For passing issues:
 * - Attach evidence and confidence
 * - Update severity if checker provided a valid one
 * - Preserve all other fields
 *
 * For missing verifications (no verification found for an index):
 * - Default confirmed to false (fail-safe), confidence to 0.5
 * - evidence defaults to ''
 */
export function applyCheckerDecisions(issues: RawIssue[], verifications: CheckerVerification[]): CheckedIssue[] {
  const result: CheckedIssue[] = []
  for (let i = 0; i < issues.length; i++) {
    const v = verifications.find(v => v.index === i)
    const confirmed = v?.confirmed ?? false
    const confidence = v?.confidence ?? 0.5

    // Keep if: confirmed true, OR uncertain with confidence >= 0.7
    if (confirmed === true || (confirmed === 'uncertain' && confidence >= 0.7)) {
      const issue = { ...issues[i] }
      // Checker assigns final severity if provided and valid
      if (v?.severity && ['critical', 'medium', 'low'].includes(v.severity)) {
        issue.severity = v.severity as Severity
      }
      // Attach checker metadata
      result.push({ ...issue, evidence: v?.evidence ?? '', confidence })
    }
  }
  return result
}
