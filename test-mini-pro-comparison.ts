/**
 * Test to compare Mini (FREE) vs Pro (PAID) audit behavior
 * Run with: pnpm exec tsx test-mini-pro-comparison.ts
 */

import { config } from "dotenv"
import { parallelMiniAudit, parallelProAudit } from "./lib/audit"

// Load environment variables
config({ path: ".env.local" })

async function runTests() {
  console.log("=" .repeat(70))
  console.log("🧪 MINI vs PRO AUDIT COMPARISON TEST")
  console.log("=".repeat(70))
  console.log("")

  const testDomain = "vercel.com" // Different domain for fresh test

  // Test 1: Mini Audit (FREE tier)
  console.log("📊 TEST 1: MINI AUDIT (FREE TIER)")
  console.log("-".repeat(70))
  console.log(`Domain: ${testDomain}`)
  console.log(`Expected: Up to 5 pages selected, 10 tool calls max`)
  console.log("")

  const miniStartTime = Date.now()
  try {
    const miniResult = await parallelMiniAudit(testDomain)
    const miniDuration = Date.now() - miniStartTime

    console.log("✅ MINI AUDIT COMPLETED")
    console.log(`Duration: ${miniDuration}ms (${(miniDuration/1000).toFixed(2)}s)`)
    console.log(`Issues Found: ${miniResult.issues.length}`)
    console.log(`Pages with Issues: ${miniResult.issues.length > 0 ? new Set(miniResult.issues.map(i => i.page_url)).size : 0}`)
    console.log(`Pages Discovered: ${miniResult.discoveredPages.length}`)
    console.log(`Status: ${miniResult.status}`)
    console.log("")

    // Show unique pages with issues
    if (miniResult.issues.length > 0) {
      const uniquePages = [...new Set(miniResult.issues.map(i => i.page_url))]
      console.log("Pages with Issues:")
      uniquePages.forEach((page, i) => {
        const pageIssues = miniResult.issues.filter(issue => issue.page_url === page)
        console.log(`  ${i + 1}. ${page} (${pageIssues.length} issues)`)
      })
      console.log("")
    }
  } catch (error) {
    console.error("❌ MINI AUDIT FAILED:")
    console.error(error)
  }

  console.log("")
  console.log("=" .repeat(70))
  console.log("")

  // Test 2: Pro Audit (PAID tier)
  console.log("📊 TEST 2: PRO AUDIT (PAID TIER)")
  console.log("-".repeat(70))
  console.log(`Domain: ${testDomain}`)
  console.log(`Expected: Up to 20 pages selected, 30 tool calls max`)
  console.log("")

  const proStartTime = Date.now()
  try {
    const proResult = await parallelProAudit(testDomain)
    const proDuration = Date.now() - proStartTime

    console.log("✅ PRO AUDIT COMPLETED")
    console.log(`Duration: ${proDuration}ms (${(proDuration/1000).toFixed(2)}s)`)
    console.log(`Issues Found: ${proResult.issues.length}`)
    console.log(`Pages with Issues: ${proResult.issues.length > 0 ? new Set(proResult.issues.map(i => i.page_url)).size : 0}`)
    console.log(`Pages Discovered: ${proResult.discoveredPages?.length || 0}`)
    console.log(`Status: ${proResult.status}`)
    console.log("")

    // Show unique pages with issues
    if (proResult.issues.length > 0) {
      const uniquePages = [...new Set(proResult.issues.map(i => i.page_url))]
      console.log("Pages with Issues:")
      uniquePages.slice(0, 10).forEach((page, i) => {
        const pageIssues = proResult.issues.filter(issue => issue.page_url === page)
        console.log(`  ${i + 1}. ${page} (${pageIssues.length} issues)`)
      })
      if (uniquePages.length > 10) {
        console.log(`  ... and ${uniquePages.length - 10} more pages`)
      }
      console.log("")
    }
  } catch (error) {
    console.error("❌ PRO AUDIT FAILED:")
    console.error(error)
  }

  console.log("")
  console.log("=".repeat(70))
  console.log("🎯 COMPARISON SUMMARY")
  console.log("=".repeat(70))
  console.log("")
  console.log("Expected Behavior:")
  console.log("  - Mini: 5 pages selected, 10 tool calls, faster execution")
  console.log("  - Pro: 20 pages selected, 30 tool calls, deeper analysis")
  console.log("")
  console.log("Check LangSmith Dashboard:")
  console.log("  https://smith.langchain.com")
  console.log("  Project: aicontentaudit")
  console.log("")
}

runTests()
  .then(() => {
    console.log("✨ Tests completed!")
    process.exit(0)
  })
  .catch((error) => {
    console.error("❌ Test suite failed:")
    console.error(error)
    process.exit(1)
  })
