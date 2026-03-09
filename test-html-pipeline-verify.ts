#!/usr/bin/env npx tsx
/**
 * Verify HTML-direct pipeline is in effect (free + pro audits)
 * Run: pnpm exec tsx test-html-pipeline-verify.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { parallelMiniAudit, parallelProAudit } from './lib/audit'

const FREE_DOMAINS = ['justcancel.io', 'seline.com']
const PRO_DOMAIN = 'youform.com'

async function run() {
  console.log('=== HTML-Direct Pipeline Verification ===\n')
  console.log(`LangSmith tracing: ${process.env.LANGSMITH_TRACING}`)
  console.log(`Project: ${process.env.LANGSMITH_PROJECT}\n`)

  // ── FREE AUDIT 1 ──────────────────────────────────────────────────────────
  console.log(`[1/3] Free audit: ${FREE_DOMAINS[0]}`)
  const t1 = Date.now()
  const r1 = await parallelMiniAudit(FREE_DOMAINS[0], { excluded: [], active: [] })
  console.log(`  ✓ Done in ${((Date.now()-t1)/1000).toFixed(1)}s — ${r1.issues.length} issues, ${r1.pagesAudited} pages\n`)

  // ── FREE AUDIT 2 ──────────────────────────────────────────────────────────
  console.log(`[2/3] Free audit: ${FREE_DOMAINS[1]}`)
  const t2 = Date.now()
  const r2 = await parallelMiniAudit(FREE_DOMAINS[1], { excluded: [], active: [] })
  console.log(`  ✓ Done in ${((Date.now()-t2)/1000).toFixed(1)}s — ${r2.issues.length} issues, ${r2.pagesAudited} pages\n`)

  // ── PRO AUDIT ─────────────────────────────────────────────────────────────
  console.log(`[3/3] Pro audit: ${PRO_DOMAIN}`)
  const t3 = Date.now()
  const r3 = await parallelProAudit(PRO_DOMAIN, { excluded: [], active: [] })
  console.log(`  ✓ Done in ${((Date.now()-t3)/1000).toFixed(1)}s — ${r3.issues.length} issues, ${r3.pagesAudited} pages\n`)

  console.log('=== All 3 runs complete ===')
  console.log('Now check LangSmith: https://smith.langchain.com')
  console.log(`Project: ${process.env.LANGSMITH_PROJECT}`)
  console.log('Look for "Content (HTML):" in the prompt inputs (not "Content:")')
}

run().catch(e => { console.error(e); process.exit(1) })
