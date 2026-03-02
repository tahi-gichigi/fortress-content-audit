import { Database } from './database.types'

// Application-specific types for Fortress

// Audit preset selection (intent picker before audit starts)
export type AuditPreset = 'quick' | 'full' | 'custom'

// Audits
export type AuditRun = Database['public']['Tables']['brand_audit_runs']['Row']

// Legacy AuditIssue interface (kept for backward compatibility)
export interface AuditIssue {
  category: string
  severity: 'high' | 'medium' | 'low'
  issue: string
  recommendation: string
  url?: string
  snippet?: string
}

// New simplified Issue matching issues table
export type IssueStatus = 'active' | 'ignored' | 'resolved'

export type IssueCategory = 'Language' | 'Facts & Consistency' | 'Links & Formatting' | 'Brand voice'

export interface Issue {
  id: string
  audit_id: string
  page_url: string
  category: IssueCategory
  issue_description: string
  severity: 'low' | 'medium' | 'critical'
  suggested_fix: string
  status: IssueStatus
  created_at: string
  updated_at: string
}

export interface AuditResult {
  issues: AuditIssue[]
  score?: number
}

// Plans
export type PlanType = 'free' | 'pro' // 'Tier 1' | 'Tier 2' in UI

export type UserProfile = Database['public']['Tables']['profiles']['Row'] & {
  plan: PlanType
}

// Issue State Management - now handled by status column on issues table
// Legacy: IssueState kept for backward compatibility during migration
export type IssueState = 'active' | 'ignored' | 'resolved' // Deprecated, use IssueStatus

export interface AuditIssuesJson {
  issues?: Array<{
    page_url: string
    category: IssueCategory
    issue_description: string
    severity: 'low' | 'medium' | 'critical'
    suggested_fix: string
  }>
  groups?: Array<{  // Legacy format, kept for backward compatibility
    title: string
    severity: 'low' | 'medium' | 'high'
    impact: string
    fix: string
    examples: Array<{ url: string; snippet: string }>
    count: number
  }>
  auditedUrls?: string[]
  total_issues?: number
  pages_with_issues?: number
  pages_audited?: number
  // Note: issues now stored in issues table, issues_json kept as backup/legacy
}

// Advanced Generators
export interface GeneratedKeyword {
  keyword: string
  relevance: number
  volume?: string
}

export interface GeneratedRule {
  rule: string
  example_good: string
  example_bad: string
}

export interface GeneratedTypography {
  category: 'Primary' | 'Secondary' | 'Accent'
  font: string
  usage: string
}

export interface GeneratedGlossaryTerm {
  term: string
  definition: string
  usage_notes?: string
}


