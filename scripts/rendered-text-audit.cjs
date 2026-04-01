#!/usr/bin/env node
/**
 * Experiment: Rendered Text Audit
 * 
 * Instead of feeding HTML or markdown to a model, this:
 * 1. Renders the page in a real browser (Playwright)
 * 2. Walks the visible DOM to extract structured text: {tag, text, section}
 * 3. Sends clean, structured text to Claude for content auditing
 * 
 * Hypothesis: fewer false positives because:
 * - Browser resolves CSS → no responsive duplicates
 * - innerText gives real spacing → no whitespace merge bugs
 * - Drastically fewer tokens → cheaper, faster, simpler prompt
 * 
 * Usage: node scripts/rendered-text-audit.js <url> [url2] [url3]
 */

const { chromium } = require('/home/ubuntu/.openclaw/tools/browser/node_modules/playwright')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

// Load .env.local if present
const envPath = join(__dirname, '../.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"\n]+)"?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

// ============================================================================
// Step 1: Extract structured visible text from rendered page
// ============================================================================

async function extractRenderedText(page) {
  return await page.evaluate(() => {
    const results = []
    const seen = new Set()
    
    // Tags we care about for structure
    // NOTE: span intentionally excluded — fragment text captured by parent block elements
    const SEMANTIC_TAGS = new Set([
      'h1','h2','h3','h4','h5','h6',
      'p','li','td','th','caption',
      'a','button','label','legend',
      'blockquote','figcaption','summary','dt','dd',
      'section','article','nav','header','footer','main','aside'
    ])
    
    // Walk all elements
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          // Skip invisible elements
          const style = window.getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT // skip entire subtree
          }
          if (node.offsetHeight === 0 && node.offsetWidth === 0) {
            return NodeFilter.FILTER_REJECT
          }
          // Skip sr-only / visually-hidden elements (clip-based accessibility hiding)
          if (style.position === 'absolute' &&
              style.overflow === 'hidden' &&
              node.offsetWidth <= 1 && node.offsetHeight <= 1) {
            return NodeFilter.FILTER_REJECT
          }
          // Skip script, style, svg, noscript
          const tag = node.tagName.toLowerCase()
          if (['script','style','svg','noscript','iframe','video','audio','canvas','img'].includes(tag)) {
            return NodeFilter.FILTER_REJECT
          }
          return NodeFilter.FILTER_ACCEPT
        }
      }
    )
    
    let node = walker.currentNode
    while (node) {
      const tag = node.tagName?.toLowerCase()
      
      if (tag && SEMANTIC_TAGS.has(tag)) {
        // Get direct text content (not from children) for leaf-ish elements,
        // or full innerText for headings/paragraphs/list items
        let text = ''
        const isContainer = ['section','article','nav','header','footer','main','aside'].includes(tag)
        
        if (isContainer) {
          // For containers, only grab direct text nodes (not child element text)
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              text += child.textContent
            }
          }
        } else {
          // For semantic elements (headings, paragraphs, links, buttons), get full text
          text = node.innerText
        }
        
        text = text?.trim()
        
        if (text && text.length > 1 && !seen.has(text)) {
          seen.add(text)
          
          // Figure out the section context
          let section = ''
          let parent = node.closest('nav, header, footer, main, section, aside, article')
          if (parent) {
            const parentTag = parent.tagName.toLowerCase()
            const ariaLabel = parent.getAttribute('aria-label') || ''
            section = ariaLabel ? `${parentTag}[${ariaLabel}]` : parentTag
          }
          
          const entry = { tag, text, section }
          
          // Add href for links
          if (tag === 'a') {
            entry.href = node.getAttribute('href') || ''
          }
          
          results.push(entry)
        }
      }
      
      node = walker.nextNode()
    }
    
    return results
  })
}


// ============================================================================
// Step 2: Format extracted text for the model
// ============================================================================

function formatForModel(url, elements) {
  let output = `# Page: ${url}\n\n`
  
  let currentSection = ''
  
  for (const el of elements) {
    if (el.section && el.section !== currentSection) {
      currentSection = el.section
      output += `\n--- ${currentSection} ---\n`
    }
    
    const tagLabel = el.tag.toUpperCase()
    
    if (el.tag === 'a') {
      output += `[${tagLabel}] ${el.text} → ${el.href}\n`
    } else {
      output += `[${tagLabel}] ${el.text}\n`
    }
  }
  
  return output
}


// ============================================================================
// Step 3: Send to Claude for audit
// ============================================================================

async function auditWithClaude(pagesText) {
  const prompt = `You are auditing a website for content quality issues. Below is the visible text extracted from a rendered browser, organized by HTML element and page section.

Today's date is ${new Date().toISOString().split('T')[0]}.

Audit for:
- **Language**: typos, grammar, spelling, punctuation errors
- **Facts & Consistency**: contradictions, incorrect stats, inconsistent terminology
- **Formatting**: content hierarchy issues, missing labels, unclear structure

Rules:
- Do NOT flag brand names, technical terms, or proper nouns as spelling errors
- Do NOT flag link destinations or broken links (separate system handles that)
- Detect the site's primary language and audit only in that language

For each issue found, return JSON:
{
  "issues": [
    {
      "page_url": "...",
      "category": "Language|Facts & Consistency|Formatting",
      "issue_description": "impact: specific problem in ≤10 words, quoting the text",
      "severity": "low|medium|critical",
      "suggested_fix": "action verb + fix in ≤8 words"
    }
  ]
}

If no issues found, return: {"issues": []}

---

${pagesText}

---

Return ONLY valid JSON. No markdown fencing, no explanation.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  })

  const data = await response.json()
  
  if (data.error) {
    throw new Error(`Claude API error: ${data.error.message}`)
  }
  
  return data
}


// ============================================================================
// Main
// ============================================================================

async function main() {
  const urls = process.argv.slice(2)
  
  if (urls.length === 0) {
    console.error('Usage: node scripts/rendered-text-audit.js <url> [url2] ...')
    process.exit(1)
  }
  
  console.log('=== Rendered Text Audit Experiment ===\n')
  
  // Launch browser
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })
  
  let allPagesText = ''
  
  for (const url of urls) {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`
    console.log(`\n📄 Rendering: ${fullUrl}`)
    
    const page = await context.newPage()
    
    try {
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 })
      // Extra wait for JS rendering
      await page.waitForTimeout(2000)
      
      const elements = await extractRenderedText(page)
      console.log(`   ✅ Extracted ${elements.length} text elements`)
      
      const formatted = formatForModel(fullUrl, elements)
      const charCount = formatted.length
      const tokenEstimate = Math.round(charCount / 4)
      console.log(`   📊 ${charCount} chars (~${tokenEstimate} tokens)`)
      
      // Log a sample
      console.log(`\n   --- Sample (first 10 elements) ---`)
      elements.slice(0, 10).forEach(el => {
        const text = el.text.length > 80 ? el.text.substring(0, 80) + '...' : el.text
        console.log(`   [${el.tag}] ${el.section ? `(${el.section}) ` : ''}${text}`)
      })
      
      allPagesText += formatted + '\n\n'
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}`)
    } finally {
      await page.close()
    }
  }
  
  await browser.close()
  
  // Compare: show what current HTML pipeline would produce
  console.log(`\n\n=== Sending to Claude (claude-sonnet-4) ===`)
  console.log(`Total input: ${allPagesText.length} chars (~${Math.round(allPagesText.length / 4)} tokens)\n`)
  
  const startTime = Date.now()
  
  try {
    const result = await auditWithClaude(allPagesText)
    const durationMs = Date.now() - startTime
    
    const responseText = result.content?.[0]?.text || ''
    console.log(`⏱️  Claude responded in ${(durationMs / 1000).toFixed(1)}s`)
    console.log(`📊 Input tokens: ${result.usage?.input_tokens}, Output tokens: ${result.usage?.output_tokens}`)
    
    // Parse issues
    try {
      const parsed = JSON.parse(responseText)
      console.log(`\n=== Results: ${parsed.issues?.length || 0} issues found ===\n`)
      
      if (parsed.issues?.length) {
        for (const issue of parsed.issues) {
          const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'medium' ? '🟡' : '⚪'
          console.log(`${icon} [${issue.category}] ${issue.issue_description}`)
          console.log(`   Fix: ${issue.suggested_fix}`)
          console.log(`   Page: ${issue.page_url}\n`)
        }
      }
    } catch {
      console.log('Raw response:', responseText)
    }
  } catch (err) {
    console.error(`❌ Audit failed: ${err.message}`)
  }
}

main().catch(console.error)
