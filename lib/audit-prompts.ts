/**
 * Inline Audit Prompts
 * Prompts for mini and full audits with manifest integration
 */

export function buildMiniAuditPrompt(
  url: string,
  manifestText: string,
  excludedIssues: string,
  activeIssues: string
): string {
  return `You are auditing ${url}. Below is an ELEMENT MANIFEST extracted from the actual HTML source code, showing all interactive elements (links, buttons, forms, headings) that exist on the page.

${manifestText}

---

Audit only the homepage and one additional key public-facing page of a website for language quality, factual accuracy, and formatting. In a single unified pass, audit both pages for all three content categories at once: Language, Facts & Consistency, and Formatting. For each page, identify and log issues per category:

- Language (typos, grammar, spelling, punctuation)
- Facts & Consistency (factual errors, inconsistencies, incorrect stats)
- Formatting (layout problems, visual hierarchy issues, formatting inconsistencies — NOT link issues, those are checked by a separate automated system)

**Language detection:** Detect the language of each page from its content. Write all issue descriptions and suggested fixes in that same language. Do not flag intentional foreign-language content — brand names, product terms, proper nouns, or content clearly written in a secondary language on purpose.

**IMPORTANT — Markdown extraction artifacts:**
The website content below was extracted from HTML and converted to markdown. This process often strips whitespace between adjacent HTML elements, producing false "missing space" issues. Examples:
- "Thesimple" (actually "The simple" in two separate HTML spans)
- "Add to your websiteA" or "Add Seline for freeA" (button text + keyboard shortcut letter in a separate element — the trailing letter is NOT part of the button text)
- "3000events" (number and unit in separate elements)
- "people.But" (sentence end and next sentence in separate elements)

DO NOT flag spacing issues that look like HTML elements merged together. Only flag spacing issues where the text would genuinely read wrong on the actual rendered page — e.g., real typos like "recieve" or genuinely missing punctuation.

Do NOT check or report ANY link issues — broken links, wrong destinations, link text, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.

**HOW TO USE THE MANIFEST:**

Use the manifest to avoid false positives about missing elements. The manifest shows code structure, NOT functionality.

**AUDIT THOROUGHLY:**
- Explore the site as you normally would (don't reduce exploration just because you have the manifest)
- Open multiple pages to find issues across the site
- Use your full tool call allowance to be comprehensive

**Use manifest for:**
✓ Checking if headings are duplicated or legitimate (responsive designs may show same heading at different breakpoints)
✓ Understanding code structure to avoid reporting missing elements that actually exist

**DON'T use manifest as:**
✗ A reason to explore fewer pages
✗ A substitute for thorough auditing

**The manifest is a fact-checking tool, not a shortcut.** Audit with the same thoroughness as if you had no manifest.

If you encounter bot protection or a firewall blocking access to either page, immediately return the short string: BOT_PROTECTION_OR_FIREWALL_BLOCKED and stop the audit for that page.

If a page is still loading or temporarily unavailable, retry loading that page at least three times, with brief pauses in between. Do not skip the page due to delays until all retries have failed; only then skip that page and do not report issues for it.

For every issue found, provide a scannable, concise description. Format as follows:
- **issue_description**: impact label (e.g., "professionalism:", "trust:", "clarity:", "credibility:") + the problem in 10 words or fewer. For readability issues use "clarity:" or "accessibility:" — never "readability:" or grade codes. Always name WHERE the issue is: quote the specific text OR name the section (hero, pricing table, footer CTA, nav). Example: "professionalism: 'recieve' in hero headline — should be 'receive'."
- **suggested_fix**: action verb + fix in 8 words or fewer. Example: "Change to 'receive'."

After completing the single pass over both pages and categories, return as output:
- If any issues are found, return all issues as a JSON object per the required fields below.
- If no issues are found across any category or page, return the JSON null value (not an empty object, array, or any message).
- Summary fields:
    - total_issues: total number of issues found across both pages
    - pages_with_issues: number of unique pages on which issues were found (maximum 2)
    - pages_audited: total number of pages reviewed (maximum 2)

# Steps

1. For each of the two pages (homepage and one key additional public page), audit all three categories (Language; Facts & Consistency; Links & Formatting) in a single comprehensive review.
2. For every identified issue, generate a JSON object with required fields (see output format).
3. Ensure the "issue_description" begins with the appropriate impact keyword for instant clarity.
4. Track the total number of issues, count of pages with issues, and total pages audited.
5. If access to the homepage or the other audited page is blocked by a bot or firewall, immediately return only BOT_PROTECTION_OR_FIREWALL_BLOCKED (not JSON).
6. If a page fails to load after three retry attempts, skip that page and do not report issues for it.
7. If no issues are found in any category for either page, return null (the JSON null value).

# Output Format

If issues are found:
Respond with a JSON object containing:
- "issues": array of objects, each with:
    - page_url: [string]
    - category: [string] — must be "Language", "Facts & Consistency", or "Links & Formatting"
    - issue_description: [string] — begins with an impact word (e.g., "professionalism:", "frustration:", "trust:", "credibility:") then concise problem statement
    - severity: [string] — "critical", "medium", or "low"
    - suggested_fix: [string] — direct, actionable, concise fix
- "total_issues": [integer]
- "pages_with_issues": [integer] (maximum 2)
- "pages_audited": [integer] (maximum 2)

If no issues are found after reviewing both pages and all categories, return:
null

If access to either page is blocked by a bot or firewall, respond only with:
BOT_PROTECTION_OR_FIREWALL_BLOCKED

All fields must be as brief as possible without loss of clarity.

# Examples

Example if issues are found:

{
  "issues": [
    {
      "page_url": "https://example.com/home",
      "category": "Language",
      "issue_description": "professionalism: 'recieve' in features section hero — misspelled",
      "severity": "low",
      "suggested_fix": "Change to 'receive'."
    },
    {
      "page_url": "https://example.com/pricing",
      "category": "Links & Formatting",
      "issue_description": "frustration: 'Contact Support' footer link leads to 404",
      "severity": "critical",
      "suggested_fix": "Update link to correct support page."
    }
  ],
  "total_issues": 2,
  "pages_with_issues": 2,
  "pages_audited": 2
}

Example if no issues are found:

null

# Notes

- Audit only the homepage and ONE key additional page, in a single comprehensive pass for all categories.
- Lead every "issue_description" with an impact label. For readability issues use "clarity:" or "accessibility:" — never "readability:" or grade codes.
- Always name the location: quote the specific text or name the section (hero, pricing table, footer CTA, nav).
- Keep issue_description to 10 words or fewer after the label.
- Keep suggested_fix to 8 words or fewer, starting with an action verb.
- Severity must be "critical", "medium", or "low".
- Only count a page as a "page with issues" if at least one issue is found on it.
- "pages_audited" is the count of the pages actually checked (excluding pages skipped due to loading failure or bot/firewall block; maximum 2).
- If you encounter bot protection or firewall block on either page, immediately return only BOT_PROTECTION_OR_FIREWALL_BLOCKED (not JSON).
- If a page cannot load after three attempts, skip that page and log no issues for it.
- If no issues are found in any category for either page, return null (not an empty object, not an empty array, not any explanation).
- Use the precise output format above; do not include extraneous notes, explanations, or context.
- DON'T report "/cdn-cgi/l/email-protection" links as broken - Cloudflare decodes these client-side into valid mailto links.

**Important: Audit only the homepage and ONE key additional page. Audit all categories (Language, Facts & Consistency, Links & Formatting) in a single comprehensive pass (not three separate passes). If no issues are found, return null; otherwise, follow all formatting, style, and conciseness rules.**

${excludedIssues && excludedIssues !== '[]' ? `\n# Previously Resolved/Ignored Issues\n\nThe following issues have been resolved or ignored by the user. DO NOT report them again:\n${excludedIssues}\n` : ''}
${activeIssues && activeIssues !== '[]' ? `\n# Active Issues from Previous Audit\n\nThe following issues were found in a previous audit. Verify if they still exist:\n${activeIssues}\n` : ''}
`
}

export function buildFullAuditPrompt(
  url: string,
  manifestText: string,
  excludedIssues: string,
  activeIssues: string,
  includeLongformFullAudit: boolean = false
): string {
  return `You are auditing ${url}. Below is an ELEMENT MANIFEST extracted from the actual HTML source code, showing all interactive elements (links, buttons, forms, headings) that exist on the page.

${manifestText}

---

Audit up to 20 public-facing, top-of-funnel pages of a website for:
- Language (typos, grammar, spelling, punctuation)
- Facts & Consistency (factual errors, inconsistencies, incorrect stats)
- Formatting (layout problems, visual hierarchy issues, formatting inconsistencies — NOT link issues, those are checked by a separate automated system)

**Language detection:** Detect the language of each page from its content. Write all issue descriptions and suggested fixes in that same language. Do not flag intentional foreign-language content — brand names, product terms, proper nouns, or content clearly written in a secondary language on purpose.

**IMPORTANT — Markdown extraction artifacts:**
The website content below was extracted from HTML and converted to markdown. This process often strips whitespace between adjacent HTML elements, producing false "missing space" issues. Examples:
- "Thesimple" (actually "The simple" in two separate HTML spans)
- "Add to your websiteA" or "Add Seline for freeA" (button text + keyboard shortcut letter in a separate element — the trailing letter is NOT part of the button text)
- "3000events" (number and unit in separate elements)
- "people.But" (sentence end and next sentence in separate elements)

DO NOT flag spacing issues that look like HTML elements merged together. Only flag spacing issues where the text would genuinely read wrong on the actual rendered page — e.g., real typos like "recieve" or genuinely missing punctuation.

Do NOT check or report ANY link issues — broken links, wrong destinations, link text, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.

${includeLongformFullAudit ? "" : "Avoid long-form blog/article/resource pages unless no other pages are available."}

**HOW TO USE THE MANIFEST:**

Use the manifest to avoid false positives about missing elements. The manifest shows code structure, NOT functionality.

**AUDIT THOROUGHLY:**
- Explore the site as you normally would (don't reduce exploration just because you have the manifest)
- Open multiple pages to find issues across the site
- Use your full tool call allowance to be comprehensive

**Use manifest for:**
✓ Checking if headings are duplicated or legitimate (responsive designs may show same heading at different breakpoints)
✓ Understanding code structure to avoid reporting missing elements that actually exist

**DON'T use manifest as:**
✗ A reason to explore fewer pages
✗ A substitute for thorough auditing

**The manifest is a fact-checking tool, not a shortcut.** Audit with the same thoroughness as if you had no manifest.

If you encounter bot protection or a firewall on any page, immediately return only: BOT_PROTECTION_OR_FIREWALL_BLOCKED and halt.

For pages that are still loading or temporarily unavailable, retry up to three times before skipping. Only consider pages fully loaded after all retries.

For every issue, log:
- page_url: [string]
- category: "Language", "Facts & Consistency", or "Links & Formatting"
- issue_description: impact label (professionalism:, trust:, clarity:, credibility:, frustration:) + problem in 10 words or fewer. For readability issues use "clarity:" or "accessibility:" — never "readability:" or grade codes. Always name WHERE: quote the text or name the section (hero, pricing table, nav, footer CTA).
- severity: "critical", "medium", or "low"
- suggested_fix: action verb + fix in 8 words or fewer

Output:
- If issues are found: JSON object with all issues, plus
    - total_issues: number of issues across all pages
    - pages_with_issues: number of unique pages with at least one issue
    - pages_audited: count of pages successfully reviewed (exclude skipped or blocked pages)
- If no issues are found: return the JSON null value (exactly null).
- If a page is blocked by a bot or firewall: immediately return only BOT_PROTECTION_OR_FIREWALL_BLOCKED.
- If a page cannot load after three attempts: skip it; do not log issues for that page.

Be concise but clear in all fields.

# Output Format

If issues are found, respond with:
{
  "issues": [
    {
      "page_url": "[string]",
      "category": "[Language|Facts & Consistency|Links & Formatting]",
      "issue_description": "[impact word]: [ultra-concise problem statement]",
      "severity": "[critical|medium|low]",
      "suggested_fix": "[concise fix]"
    }
    // ...more issues as needed
  ],
  "total_issues": [integer],
  "pages_with_issues": [integer],
  "pages_audited": [integer]
}

If no issues are found, respond with:
null

# Examples

Example if issues are found:
{
  "issues": [
    {
      "page_url": "https://example.com/home",
      "category": "Language",
      "issue_description": "professionalism: 'recieve' in features section — misspelled",
      "severity": "low",
      "suggested_fix": "Change to 'receive'."
    },
    {
      "page_url": "https://example.com/about",
      "category": "Links & Formatting",
      "issue_description": "frustration: 'Contact Us' footer link leads to 404",
      "severity": "critical",
      "suggested_fix": "Update link to correct contact page."
    },
    {
      "page_url": "https://example.com/pricing",
      "category": "Links & Formatting",
      "issue_description": "trust: hero 'Learn More' button links to homepage, not pricing",
      "severity": "medium",
      "suggested_fix": "Change button href to pricing page."
    }
  ],
  "total_issues": 3,
  "pages_with_issues": 3,
  "pages_audited": 10
}

Example if no issues are found:
null

# Notes

- Lead every issue_description with an impact label. For readability issues use "clarity:" or "accessibility:" — never "readability:" or grade codes.
- Always name the location in issue_description: quote the specific text or name the section.
- Keep issue_description to 10 words or fewer after the label.
- Keep suggested_fix to 8 words or fewer, starting with an action verb.
- Only "critical", "medium", or "low" are valid for severity.
- Only count a page as "with issues" if at least one issue is on it.
- Do not count skipped or blocked pages in pages_audited.
- Never include extra notes, explanations, or context outside the specified JSON or null outputs.
- DON'T report "/cdn-cgi/l/email-protection" links as broken - Cloudflare decodes these client-side into valid mailto links.

Reminder: Always condense instructions, return outputs in the precise format, and avoid redundant or unnecessary information.

${excludedIssues && excludedIssues !== '[]' ? `\n# Previously Resolved/Ignored Issues\n\nThe following issues have been resolved or ignored by the user. DO NOT report them again:\n${excludedIssues}\n` : ''}
${activeIssues && activeIssues !== '[]' ? `\n# Active Issues from Previous Audit\n\nThe following issues were found in a previous audit. Verify if they still exist:\n${activeIssues}\n` : ''}
`
}

/**
 * Build a category-specific audit prompt for parallel mini audits.
 * Each category model focuses on ONE issue type only.
 *
 * @param category - The category to audit
 * @param urlsToAudit - Explicit list of URLs to audit (no more, no less)
 * @param manifestText - Element manifest for false positive prevention
 * @param excludedIssues - Issues to skip (already resolved/ignored)
 * @param activeIssues - Issues to verify still exist
 * @param ignoreKeywords - Terms to never flag (e.g. from brand voice ignore list)
 * @param flagKeywords - Terms to always flag when present
 */
export function buildCategoryAuditPrompt(
  category: "Language" | "Facts & Consistency" | "Links & Formatting",
  urlsToAudit: string[],
  manifestText: string,
  excludedIssues: string,
  activeIssues: string,
  ignoreKeywords?: string[],
  flagKeywords?: string[]
): string {
  const categoryInstructions = {
    "Language": `Focus ONLY on Language issues:
- Typos and misspellings
- Grammar errors
- Punctuation mistakes
- Spelling inconsistencies
- Awkward phrasing

Do not flag intentional foreign-language content — brand names, technical terms, proper nouns, or sections clearly written in a secondary language on purpose. Only flag genuine errors within the page's own detected language.

DO NOT report Facts/Consistency or Links/Formatting issues.`,

    "Facts & Consistency": `Focus ONLY on Facts & Consistency issues:
- Factual errors or incorrect information
- Inconsistent data, numbers, or stats across pages
- Contradictory statements
- Outdated information
- Naming inconsistencies (product names, company name variations)

DO NOT report Language or Links/Formatting issues.`,

    "Links & Formatting": `Focus ONLY on Formatting & UX issues:
- Formatting problems (inconsistent styles, broken layouts)
- Layout issues affecting readability
- Visual hierarchy problems
- Navigation UX issues

DO NOT check or report ANY link issues — broken links, wrong destinations, link text quality, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.
DO NOT report Language or Facts/Consistency issues.`
  }

  // Format URL list for prompt
  const urlListText = urlsToAudit.map((u, i) => `${i + 1}. ${u}`).join('\n')

  const ignoreBlock = ignoreKeywords?.length
    ? `\n# Allowed Terms\nDO NOT flag or suggest changing:\n${ignoreKeywords.map(k => `- ${k}`).join('\n')}\n`
    : ''
  const flagBlock = flagKeywords?.length
    ? `\n# Flag Keywords\nALWAYS flag when present:\n${flagKeywords.map(k => `- ${k}`).join('\n')}\n`
    : ''

  return `You are auditing for ${category} issues ONLY.

**AUDIT EXACTLY THESE ${urlsToAudit.length} URLs:**
${urlListText}

Do NOT audit any other pages. Focus only on these specific URLs.

**Language detection:** Detect the language of each page from its content. Write all output (issue_description, suggested_fix) in that same language.

**IMPORTANT — Markdown extraction artifacts:**
The website content below was extracted from HTML and converted to markdown. This process often strips whitespace between adjacent HTML elements, producing false "missing space" issues. Examples:
- "Thesimple" (actually "The simple" in two separate HTML spans)
- "Add to your websiteA" or "Add Seline for freeA" (button text + keyboard shortcut letter in a separate element — the trailing letter is NOT part of the button text)
- "3000events" (number and unit in separate elements)
- "people.But" (sentence end and next sentence in separate elements)

DO NOT flag spacing issues that look like HTML elements merged together. Only flag spacing issues where the text would genuinely read wrong on the actual rendered page — e.g., real typos like "recieve" or genuinely missing punctuation.

Do NOT check or report ANY link issues — broken links, wrong destinations, link text, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.

${manifestText ? `Below is an ELEMENT MANIFEST showing interactive elements on the page:\n${manifestText}\n\n---\n` : ''}

${categoryInstructions[category]}

**HOW TO USE THE MANIFEST:**
- Use it to avoid false positives about missing elements
- The manifest shows code structure, NOT functionality

If you encounter bot protection, return: BOT_PROTECTION_OR_FIREWALL_BLOCKED

For every issue, provide:
- page_url: The URL where issue was found
- category: "${category}" (always this category)
- issue_description: impact label (professionalism:, trust:, clarity:, credibility:, frustration:) + problem in 10 words or fewer. For readability issues use "clarity:" or "accessibility:" — never "readability:" or grade codes. Always name WHERE: quote the specific text or name the section (hero, pricing table, nav, footer CTA).
- severity: "critical", "medium", or "low"
- suggested_fix: action verb + fix in 8 words or fewer

Output format:
{
  "issues": [...],
  "total_issues": <number>,
  "pages_with_issues": <number>,
  "pages_audited": ${urlsToAudit.length}
}

If no ${category} issues found, return: null
${ignoreBlock}
${flagBlock}
${excludedIssues && excludedIssues !== '[]' ? `\n# Previously Resolved/Ignored Issues\n\nDO NOT report these again:\n${excludedIssues}\n` : ''}
${activeIssues && activeIssues !== '[]' ? `\n# Active Issues\n\nVerify if these still exist:\n${activeIssues}\n` : ''}`
}
