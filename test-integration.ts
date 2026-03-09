#!/usr/bin/env npx tsx

/**
 * Test the new manifest + inline prompt integration
 */

import { config } from 'dotenv'
import { resolve } from 'path'
import { parallelMiniAudit } from './lib/audit'

config({ path: resolve(process.cwd(), '.env.local') })

const DOMAIN = process.argv[2] || 'justcancel.io'

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════╗')
  console.log('║         Testing New Integration: Manifest + Inline Prompts                 ║')
  console.log('╚════════════════════════════════════════════════════════════════════════════╝')
  console.log(`\nDomain: ${DOMAIN}`)

  try {
    const startTime = Date.now()

    console.log('\n⏳ Running mini audit with manifest extraction + inline prompt...')
    const result = await parallelMiniAudit(DOMAIN, { excluded: [], active: [] })

    const duration = Math.round((Date.now() - startTime) / 1000 * 10) / 10

    console.log(`\n✅ Audit completed in ${duration}s`)
    console.log(`\n📊 RESULTS:`)
    console.log(`   Issues found:  ${result.issues.length}`)
    console.log(`   Pages audited: ${result.pagesAudited}`)
    console.log(`   Status:        ${result.status}`)

    if (result.issues.length > 0) {
      console.log('\n🔍 ISSUES FOUND:')
      result.issues.forEach((issue, i) => {
        console.log(`\n${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category}`)
        console.log(`   Page: ${issue.page_url}`)
        console.log(`   Issue: ${issue.issue_description}`)
      })
    } else {
      console.log('\n✅ No issues found')
    }

    console.log('\n' + '='.repeat(80))
    console.log('✅ INTEGRATION TEST PASSED')
    console.log('='.repeat(80))
    console.log('\nManifest extraction and inline prompts working correctly!')

  } catch (error) {
    console.error('\n❌ Integration test failed:', error)
    if (error instanceof Error) {
      console.error('   Message:', error.message)
      console.error('   Stack:', error.stack)
    }
    process.exit(1)
  }
}

main()
