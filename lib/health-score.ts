import { AuditRun } from "@/types/fortress"
import { supabaseAdmin } from "./supabase-admin"
import { Issue } from "@/types/fortress"

/**
 * Health score calculation result
 */
export interface HealthScoreResult {
  score: number // 0-100
  metrics: {
    totalActive: number
    totalCritical: number // critical-severity issues
    bySeverity: {
      low: number
      medium: number
      critical: number
    }
    criticalPages: number
    pagesWithIssues: number
  }
}

/**
 * Calculate health score for a single audit
 *
 * Formula: 100 - (low×0.5 + medium×2 + critical×4) - (criticalPages×5)
 * - Excludes ignored/resolved issues (only counts active)
 * - Critical pages = pages with at least one critical-severity issue
 * - Score clamped to 0-100
 * - Counts issues, not instances; calibrated so a few criticals don’t tank the score
 *
 * @param audit - Audit run (issues queried from issues table)
 * @returns Health score result with metrics
 */
export async function calculateHealthScore(
  audit: AuditRun
): Promise<HealthScoreResult> {
  // Query issues from issues table (only active issues)
  const { data: issuesData, error } = await (supabaseAdmin as any)
    .from('issues')
    .select('severity, status, page_url')
    .eq('audit_id', audit.id)
    .eq('status', 'active')  // Only active issues

  if (error) {
    console.error('[HealthScore] Error fetching issues:', error)
    throw error
  }

  const issues: Issue[] = (issuesData || []) as Issue[]

  // If no issues found, return empty score
  if (!issues || issues.length === 0) {
    return {
      score: 100,
      metrics: {
        totalActive: 0,
        totalCritical: 0,
        bySeverity: { low: 0, medium: 0, critical: 0 },
        criticalPages: 0,
        pagesWithIssues: 0,
      },
    }
  }

  // Count issues by severity
  const bySeverity = {
    low: 0,
    medium: 0,
    critical: 0,
  }
  
  // Track unique pages with issues
  const pagesWithIssuesSet = new Set<string>()
  
  // Track unique critical pages (pages with critical-severity issues)
  const criticalPagesSet = new Set<string>()
  
  issues.forEach((issue: Issue) => {
    // Count by severity
    if (issue.severity === 'critical') {
      bySeverity.critical++
    } else if (issue.severity === 'medium') {
      bySeverity.medium++
    } else {
      bySeverity.low++
    }
    
    // Extract unique pages from page_url
    if (issue.page_url) {
      try {
        const url = new URL(issue.page_url)
        const pagePath = url.pathname || '/'
        pagesWithIssuesSet.add(pagePath)
        
        // If critical severity, mark page as critical
        if (issue.severity === 'critical') {
          criticalPagesSet.add(pagePath)
        }
      } catch (e) {
        console.warn('[HealthScore] Invalid URL in page_url:', issue.page_url)
      }
    }
  })
  
  const totalActive = issues.length
  const totalCritical = bySeverity.critical
  const criticalPages = criticalPagesSet.size
  const pagesWithIssues = pagesWithIssuesSet.size
  
  // Apply formula: 100 - (low×0.5 + medium×2 + critical×4) - (criticalPages×5)
  let score = 100
  score -= bySeverity.low * 0.5
  score -= bySeverity.medium * 2
  score -= bySeverity.critical * 4
  score -= criticalPages * 5

  // Clamp to 1-100 (minimum 1 if issues exist, can be 100 if no issues)
  score = Math.max(0, Math.min(100, score))
  
  return {
    score,
    metrics: {
      totalActive,
      totalCritical,
      bySeverity,
      criticalPages,
      pagesWithIssues,
    },
  }
}

// Removed: calculateHealthScoreFromGroups - no longer needed with simplified model

/**
 * Calculate health score for multiple audits (aggregated)
 * 
 * This aggregates metrics across multiple audits for a domain.
 * Useful for calculating overall health score across audit history.
 * Counts issues, not instances.
 * 
 * @param audits - Array of audit runs
 * @returns Aggregated health score result
 */
export async function calculateAggregatedHealthScore(
  audits: AuditRun[]
): Promise<HealthScoreResult> {
  // Aggregate metrics across all audits
  const bySeverity = {
    low: 0,
    medium: 0,
    critical: 0,
  }
  
  const pagesWithIssuesSet = new Set<string>()
  const criticalPagesSet = new Set<string>()
  
  // Query all issues for all audits (only active)
  // Filter out audits without IDs to prevent UUID errors
  const auditIds = audits.map(a => a.id).filter((id): id is string => !!id)
  
  // If no valid audit IDs, return empty score
  if (auditIds.length === 0) {
    return {
      score: 100,
      metrics: {
        totalActive: 0,
        totalCritical: 0,
        bySeverity: { low: 0, medium: 0, critical: 0 },
        criticalPages: 0,
        pagesWithIssues: 0,
      },
    }
  }
  
  const { data: allIssues, error } = await (supabaseAdmin as any)
    .from('issues')
    .select('severity, status, page_url')
    .in('audit_id', auditIds)
    .eq('status', 'active')

  if (error) {
    console.error('[HealthScore] Error fetching issues:', error)
    throw error
  }

  // If no issues found, return empty score
  if (!allIssues || allIssues.length === 0) {
    return {
      score: 100,
      metrics: {
        totalActive: 0,
        totalCritical: 0,
        bySeverity: { low: 0, medium: 0, critical: 0 },
        criticalPages: 0,
        pagesWithIssues: 0,
      },
    }
  }

  // Process issues
  (allIssues || []).forEach((issue: Issue) => {
    // Count by severity
    if (issue.severity === 'critical') {
      bySeverity.critical++
    } else if (issue.severity === 'medium') {
      bySeverity.medium++
    } else {
      bySeverity.low++
    }
    
    // Extract unique pages from page_url
    if (issue.page_url) {
      try {
        const url = new URL(issue.page_url)
        const pagePath = url.pathname || '/'
        pagesWithIssuesSet.add(pagePath)
        
        if (issue.severity === 'critical') {
          criticalPagesSet.add(pagePath)
        }
      } catch (e) {
        console.warn('[HealthScore] Invalid URL in page_url:', issue.page_url)
      }
    }
  })
  
  const totalActive = allIssues.length
  const totalCritical = bySeverity.critical
  const criticalPages = criticalPagesSet.size
  const pagesWithIssues = pagesWithIssuesSet.size
  
  // Apply formula (same as single-audit: fairer so few criticals don’t tank score)
  let score = 100
  score -= bySeverity.low * 0.5
  score -= bySeverity.medium * 2
  score -= bySeverity.critical * 4
  score -= criticalPages * 5

  // Clamp to 1-100 (minimum 1 if issues exist, can be 100 if no issues)
  score = Math.max(0, Math.min(100, score))
  
  return {
    score,
    metrics: {
      totalActive,
      totalCritical,
      bySeverity,
      criticalPages,
      pagesWithIssues,
    },
  }
}

// Removed: calculateAggregatedHealthScoreFromGroups - no longer needed with simplified model

/**
 * Get Tailwind text color class for health score
 * @param score - Health score (0-100)
 * @returns Tailwind text color class
 */
export function getHealthScoreTextColor(score: number): string {
  if (score >= 95) return 'text-green-600'
  if (score >= 80) return 'text-yellow-600'
  if (score >= 50) return 'text-orange-600'
  return 'text-destructive'
}

/**
 * Get RGB color value for health score (for charts/gradients)
 * @param score - Health score (0-100)
 * @returns RGB color string
 */
export function getHealthScoreColor(score: number): string {
  if (score >= 95) return 'rgb(22 163 74)' // green-600
  if (score >= 80) return 'rgb(202 138 4)' // yellow-600
  if (score >= 50) return 'rgb(234 88 12)' // orange-600
  return 'rgb(220 38 38)' // red-600 (destructive)
}