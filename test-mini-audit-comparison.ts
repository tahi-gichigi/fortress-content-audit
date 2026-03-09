#!/usr/bin/env npx tsx

/**
 * Direct comparison: Regular parallelMiniAudit vs Hybrid approach
 */

import { config } from 'dotenv'
import { resolve } from 'path'
import { parallelMiniAudit } from './lib/audit'

config({ path: resolve(process.cwd(), '.env.local') })

const DOMAIN = process.argv[2] || 'seline.com'

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════╗')
  console.log('║              Regular Mini Audit Test (for comparison)                      ║')
  console.log('╚════════════════════════════════════════════════════════════════════════════╝')
  console.log(`\nDomain: ${DOMAIN}`)

  try {
    const startTime = Date.now()

    console.log('\n⏳ Running regular mini audit (GPT-5.1 with web_search)...')
    const result = await parallelMiniAudit(DOMAIN, { excluded: [], active: [] })

    const duration = Math.round((Date.now() - startTime) / 1000 * 10) / 10

    console.log(`✅ Audit completed in ${duration}s`)
    console.log(`\n📊 RESULTS:`)
    console.log(`   Issues found:  ${result.issues.length}`)
    console.log(`   Pages audited: ${result.pagesAudited}`)
    console.log(`   Audited URLs:  ${result.auditedUrls?.length || 0}`)
    console.log(`   Model duration: ${result.modelDurationMs}ms`)
    console.log(`   Status:        ${result.status}`)

    if (result.issues.length > 0) {
      console.log('\n🔍 ISSUES FOUND:')
      result.issues.forEach((issue, i) => {
        console.log(`\n${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category}`)
        console.log(`   Page: ${issue.page_url}`)
        console.log(`   Issue: ${issue.issue_description}`)
        console.log(`   Fix: ${issue.suggested_fix}`)
      })
    } else {
      console.log('\n✅ No issues found')
    }

    console.log('\n' + '='.repeat(80))
    console.log('✅ TEST COMPLETED')
    console.log('='.repeat(80))

  } catch (error) {
    console.error('\n❌ Test failed:', error)
    if (error instanceof Error) {
      console.error('   Message:', error.message)
    }
    process.exit(1)
  }
}

main()
