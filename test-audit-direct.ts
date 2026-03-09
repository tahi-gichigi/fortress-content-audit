#!/usr/bin/env npx tsx

/**
 * Direct End-to-End Test - Calls audit functions directly
 * This bypasses the API and directly tests the deduplication logic
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { parallelMiniAudit, getExcludedIssues, getActiveIssues } from './lib/audit'

config({ path: resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DOMAIN = 'justcancel.io'
const TEST_USER_ID = '288a2b04-4cfb-402a-96b0-7ba5a63a684c'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function updateIssueStatus(issueId: string, status: 'resolved' | 'ignored' | 'active') {
  const { error } = await supabase
    .from('issues')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', issueId)

  if (error) throw new Error(`Failed to update issue: ${error.message}`)
}

async function saveAuditToDatabase(result: any, userId: string, domain: string) {
  // Create audit run
  const { data: run, error: runError } = await supabase
    .from('brand_audit_runs')
    .insert({
      user_id: userId,
      domain: domain,
      title: `${domain} Audit`,
      brand_name: domain.split('.')[0],
      pages_audited: result.pagesAudited || 0,
      issues_json: {
        issues: result.issues,
        status: 'completed',
        auditedUrls: result.auditedUrls || []
      },
      is_preview: false,
    })
    .select('id')
    .single()

  if (runError) throw new Error(`Failed to create audit: ${runError.message}`)

  const auditId = run.id

  // Save issues
  if (result.issues && result.issues.length > 0) {
    const issuesWithAuditId = result.issues.map((issue: any) => ({
      audit_id: auditId,
      page_url: issue.page_url,
      category: issue.category,
      severity: issue.severity || 'medium',
      issue_description: issue.issue_description,
      suggested_fix: issue.suggested_fix || '',
      status: 'active',
    }))

    const { error: issuesError } = await supabase
      .from('issues')
      .insert(issuesWithAuditId)

    if (issuesError) throw new Error(`Failed to save issues: ${issuesError.message}`)
  }

  return auditId
}

async function getAuditIssues(auditId: string) {
  const { data: issues, error } = await supabase
    .from('issues')
    .select('*')
    .eq('audit_id', auditId)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to get issues: ${error.message}`)
  return issues || []
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗')
  console.log('║     Direct E2E Test: Issue Deduplication Feature              ║')
  console.log('╚════════════════════════════════════════════════════════════════╝')
  console.log(`\nDomain: ${DOMAIN}`)
  console.log(`User ID: ${TEST_USER_ID}`)

  try {
    // ========================================================================
    // TEST 1: Run first audit (no context)
    // ========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('TEST 1: Run First Audit (No Context)')
    console.log('='.repeat(70))

    console.log(`\nCalling parallelMiniAudit() directly...`)
    const result1 = await parallelMiniAudit(DOMAIN, { excluded: [], active: [] })

    console.log(`✓ Audit completed`)
    console.log(`  - Issues found: ${result1.issues.length}`)
    console.log(`  - Pages audited: ${result1.pagesAudited}`)

    const auditId1 = await saveAuditToDatabase(result1, TEST_USER_ID, DOMAIN)
    console.log(`✓ Saved to database: ${auditId1}`)

    const issues1 = await getAuditIssues(auditId1)

    console.log(`\n📋 Issues found:`)
    issues1.forEach((issue, i) => {
      console.log(`  ${i + 1}. [${issue.category}] ${issue.issue_description.substring(0, 80)}...`)
    })

    if (issues1.length === 0) {
      console.log('\n⚠️  No issues found. Cannot test deduplication.')
      process.exit(0)
    }

    // ========================================================================
    // TEST 2: Mark some issues as resolved/ignored
    // ========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('TEST 2: Mark Issues as Resolved/Ignored')
    console.log('='.repeat(70))

    const numToResolve = Math.min(2, issues1.length)
    const numToIgnore = Math.min(2, issues1.length - numToResolve)

    console.log(`\nMarking ${numToResolve} issues as resolved...`)
    for (let i = 0; i < numToResolve; i++) {
      await updateIssueStatus(issues1[i].id, 'resolved')
      console.log(`  ✓ Resolved: ${issues1[i].issue_description.substring(0, 60)}...`)
    }

    console.log(`\nMarking ${numToIgnore} issues as ignored...`)
    for (let i = numToResolve; i < numToResolve + numToIgnore; i++) {
      await updateIssueStatus(issues1[i].id, 'ignored')
      console.log(`  ✓ Ignored: ${issues1[i].issue_description.substring(0, 60)}...`)
    }

    const numActive = issues1.length - numToResolve - numToIgnore
    console.log(`\nRemaining active issues: ${numActive}`)

    // ========================================================================
    // TEST 3: Get issue context
    // ========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('TEST 3: Load Issue Context')
    console.log('='.repeat(70))

    const excludedIssues = await getExcludedIssues(TEST_USER_ID, DOMAIN)
    const activeIssues = await getActiveIssues(TEST_USER_ID, DOMAIN)

    console.log(`\n✓ Excluded issues: ${excludedIssues.length}`)
    console.log(`✓ Active issues: ${activeIssues.length}`)

    console.log('\n📋 Excluded Issues (passing to AI):')
    excludedIssues.forEach((issue, i) => {
      console.log(`  ${i + 1}. [${issue.category}] ${issue.issue_description.substring(0, 80)}...`)
    })

    if (activeIssues.length > 0) {
      console.log('\n📋 Active Issues (passing to AI):')
      activeIssues.forEach((issue, i) => {
        console.log(`  ${i + 1}. [${issue.category}] ${issue.issue_description.substring(0, 80)}...`)
      })
    }

    // ========================================================================
    // TEST 4: Run second audit WITH context
    // ========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('TEST 4: Run Second Audit WITH Issue Context')
    console.log('='.repeat(70))

    console.log(`\nCalling parallelMiniAudit() with issue context...`)
    const result2 = await parallelMiniAudit(DOMAIN, {
      excluded: excludedIssues,
      active: activeIssues
    })

    console.log(`✓ Audit completed`)
    console.log(`  - Issues found: ${result2.issues.length}`)
    console.log(`  - Pages audited: ${result2.pagesAudited}`)

    const auditId2 = await saveAuditToDatabase(result2, TEST_USER_ID, DOMAIN)
    console.log(`✓ Saved to database: ${auditId2}`)

    const issues2 = await getAuditIssues(auditId2)

    // ========================================================================
    // TEST 5: Verify deduplication
    // ========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('TEST 5: Verify Deduplication Worked')
    console.log('='.repeat(70))

    const excludedDescriptions = new Set(excludedIssues.map(i => i.issue_description))
    const reappeared = issues2.filter(issue =>
      excludedDescriptions.has(issue.issue_description)
    )

    console.log(`\n📋 Second Audit Issues:`)
    issues2.forEach((issue, i) => {
      const wasExcluded = excludedDescriptions.has(issue.issue_description)
      const marker = wasExcluded ? '❌ REAPPEARED' : '✓'
      console.log(`  ${i + 1}. ${marker} [${issue.category}] ${issue.issue_description.substring(0, 70)}...`)
    })

    if (reappeared.length > 0) {
      console.log(`\n❌ FAIL: ${reappeared.length} excluded issues reappeared!`)
      console.log('\nThis means the AI ignored the excluded_issues context.')
      process.exit(1)
    } else {
      console.log(`\n✅ SUCCESS: No excluded issues reappeared!`)
      console.log('The AI successfully used the excluded_issues context to avoid duplicates.')
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('✅ TEST SUMMARY')
    console.log('='.repeat(70))
    console.log(`\nFirst Audit: ${issues1.length} issues`)
    console.log(`  - Resolved: ${numToResolve}`)
    console.log(`  - Ignored: ${numToIgnore}`)
    console.log(`  - Active: ${numActive}`)
    console.log(`\nSecond Audit: ${issues2.length} issues`)
    console.log(`  - Excluded context passed: ${excludedIssues.length} issues`)
    console.log(`  - Active context passed: ${activeIssues.length} issues`)
    console.log(`  - Reappeared: ${reappeared.length} ✓`)
    console.log(`\n✅ Deduplication is working correctly!`)

  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  }
}

main()
