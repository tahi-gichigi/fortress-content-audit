/**
 * Test mini audit with LangSmith tracing
 * Run with: pnpm exec tsx test-mini-audit-langsmith.ts
 */

import { config } from "dotenv"
import { parallelMiniAudit } from "./lib/audit"

// Load environment variables
config({ path: ".env.local" })

async function testMiniAudit() {
  console.log("🚀 Starting test mini audit with LangSmith tracing...\n")

  const testDomain = "stripe.com"
  console.log(`📍 Testing domain: ${testDomain}`)
  console.log(`🔍 LangSmith tracing: ${process.env.LANGSMITH_TRACING}`)
  console.log(`📊 Project: ${process.env.LANGSMITH_PROJECT}\n`)

  const startTime = Date.now()

  try {
    const result = await parallelMiniAudit(testDomain)
    const duration = Date.now() - startTime

    console.log("\n" + "=".repeat(60))
    console.log("✅ AUDIT COMPLETED SUCCESSFULLY")
    console.log("=".repeat(60))
    console.log(`⏱️  Total Duration: ${duration}ms (${(duration/1000).toFixed(2)}s)`)
    console.log(`🔍 Issues Found: ${result.issues.length}`)
    console.log(`📄 Pages Audited: ${result.pagesAudited}`)
    console.log(`🌐 Pages Discovered: ${result.discoveredPages.length}`)
    console.log(`📊 Model Duration: ${result.modelDurationMs}ms`)
    console.log(`✨ Status: ${result.status}`)

    if (result.issues.length > 0) {
      console.log("\n📋 Sample Issues:")
      result.issues.slice(0, 3).forEach((issue, i) => {
        console.log(`\n${i + 1}. ${issue.category} - ${issue.severity}`)
        console.log(`   Page: ${issue.page_url}`)
        console.log(`   Issue: ${issue.issue_description.substring(0, 80)}...`)
      })
    }

    console.log("\n" + "=".repeat(60))
    console.log("🔍 CHECK LANGSMITH DASHBOARD:")
    console.log("   https://smith.langchain.com")
    console.log("   Project: aicontentaudit")
    console.log("   Look for traces from the last few minutes")
    console.log("=".repeat(60) + "\n")

  } catch (error) {
    console.error("\n❌ AUDIT FAILED:")
    console.error(error)
    process.exit(1)
  }
}

testMiniAudit()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
