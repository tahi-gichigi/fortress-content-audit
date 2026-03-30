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

**Language detection:** Detect the primary language of the site from its homepage. Write all output in that language. Audit ONLY content in the primary language. If a page or section is in a different language, skip it entirely — do not flag spelling or grammar in non-primary languages. Do not flag brand names, technical terms, or proper nouns in any language.

**RESPONSIVE DUPLICATES — read before auditing:**
Modern sites ship BOTH mobile and desktop versions of components in the same HTML. Seeing the same text twice is intentional responsive design, not a content issue. CSS class attributes have been removed from the HTML you receive, so use structural clues to identify them.

How to spot them:
- Two <nav> elements (mobile drawer + desktop bar) are standard
- Two sections or divs with identical text content are likely mobile/desktop variants — audit the content ONCE
- Repeated CTAs, hero text, or banners appearing in the same page are usually responsive pairs

**DYNAMIC / INTERACTIVE CONTENT — do not flag these:**
- Do NOT flag numbers, text, or values inside interactive components (sliders, counters, animated number displays, progress bars). These show a snapshot state at scrape time — values like "0 seconds", "$0", or garbled text inside animated elements are NOT content errors.
- Do NOT flag garbled or partially-encoded text (e.g. "secure0n*d", "3x7K") inside a single isolated element — it is likely a text animation or encoding artifact captured mid-render, not a real content issue.
- Do NOT flag form field labels that mix parameter names and type annotations — this is standard developer tooling UI, not a copywriting error.
- Do NOT flag text adjacent to UI badge/tag/label elements (shown as [Badge: text] in the HTML) as a word-merging or concatenation error — these are intentional inline UI chips.
- Do NOT flag invisible, zero-width, or non-printable characters (U+FEFF, U+200B, etc.) as content issues. These are encoding artifacts from CMS systems or web frameworks and do not affect how text renders or reads — flagging them is always a false positive.

Pages are truncated at an HTML tag boundary and marked with "[Content truncated due to length]". DO NOT flag content near this marker as incomplete — it is an extraction limit, not a real site issue. Large pages may appear as "part 1 of 2" / "part 2 of 2" — treat them as one continuous page.

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

1. For each of the two pages (homepage and one key additional public page), audit all three categories (Language; Facts & Consistency; Formatting) in a single comprehensive review.
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
    - category: [string] — must be "Language", "Facts & Consistency", or "Formatting"
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
      "category": "Formatting",
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

**Important: Audit only the homepage and ONE key additional page. Audit all categories (Language, Facts & Consistency, Formatting) in a single comprehensive pass (not three separate passes). If no issues are found, return null; otherwise, follow all formatting, style, and conciseness rules.**

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

**Language detection:** Detect the primary language of the site from its homepage. Write all output in that language. Audit ONLY content in the primary language. If a page or section is in a different language, skip it entirely — do not flag spelling or grammar in non-primary languages. Do not flag brand names, technical terms, or proper nouns in any language.

**RESPONSIVE DUPLICATES — read before auditing:**
Modern sites ship BOTH mobile and desktop versions of components in the same HTML. Seeing the same text twice is intentional responsive design, not a content issue. CSS class attributes have been removed from the HTML you receive, so use structural clues to identify them.

How to spot them:
- Two <nav> elements (mobile drawer + desktop bar) are standard
- Two sections or divs with identical text content are likely mobile/desktop variants — audit the content ONCE
- Repeated CTAs, hero text, or banners appearing in the same page are usually responsive pairs

**DYNAMIC / INTERACTIVE CONTENT — do not flag these:**
- Do NOT flag numbers, text, or values inside interactive components (sliders, counters, animated number displays, progress bars). These show a snapshot state at scrape time — values like "0 seconds", "$0", or garbled text inside animated elements are NOT content errors.
- Do NOT flag garbled or partially-encoded text (e.g. "secure0n*d", "3x7K") inside a single isolated element — it is likely a text animation or encoding artifact captured mid-render, not a real content issue.
- Do NOT flag form field labels that mix parameter names and type annotations — this is standard developer tooling UI, not a copywriting error.
- Do NOT flag text adjacent to UI badge/tag/label elements (shown as [Badge: text] in the HTML) as a word-merging or concatenation error — these are intentional inline UI chips.
- Do NOT flag invisible, zero-width, or non-printable characters (U+FEFF, U+200B, etc.) as content issues. These are encoding artifacts from CMS systems or web frameworks and do not affect how text renders or reads — flagging them is always a false positive.

Pages are truncated at an HTML tag boundary and marked with "[Content truncated due to length]". DO NOT flag content near this marker as incomplete — it is an extraction limit, not a real site issue. Large pages may appear as "part 1 of 2" / "part 2 of 2" — treat them as one continuous page.

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
- category: "Language", "Facts & Consistency", or "Formatting"
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
      "category": "[Language|Facts & Consistency|Formatting]",
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
      "category": "Formatting",
      "issue_description": "frustration: 'Contact Us' footer link leads to 404",
      "severity": "critical",
      "suggested_fix": "Update link to correct contact page."
    },
    {
      "page_url": "https://example.com/pricing",
      "category": "Formatting",
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
  category: "Language" | "Facts & Consistency" | "Formatting",
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

DO NOT report Facts/Consistency or Formatting issues.`,

    "Facts & Consistency": `Focus ONLY on Facts & Consistency issues:
- Factual errors or incorrect information
- Inconsistent data, numbers, or stats across pages
- Contradictory statements
- Outdated information
- Naming inconsistencies (product names, company name variations)

DO NOT report Language or Formatting issues.`,

    "Formatting": `Focus ONLY on Formatting & UX issues:
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

**Language detection:** Detect the primary language of the site from its homepage. Write all output in that language. Audit ONLY content in the primary language. If a page or section is in a different language, skip it entirely — do not flag spelling or grammar in non-primary languages. Do not flag brand names, technical terms, or proper nouns in any language.

**RESPONSIVE DUPLICATES — read before auditing:**
Modern sites ship BOTH mobile and desktop versions of components in the same HTML. Seeing the same text twice is intentional responsive design, not a content issue. CSS class attributes have been removed from the HTML you receive, so use structural clues to identify them.

How to spot them:
- Two <nav> elements (mobile drawer + desktop bar) are standard
- Two sections or divs with identical text content are likely mobile/desktop variants — audit the content ONCE
- Repeated CTAs, hero text, or banners appearing in the same page are usually responsive pairs

**DYNAMIC / INTERACTIVE CONTENT — do not flag these:**
- Do NOT flag numbers, text, or values inside interactive components (sliders, counters, animated number displays, progress bars). These show a snapshot state at scrape time — values like "0 seconds", "$0", or garbled text inside animated elements are NOT content errors.
- Do NOT flag garbled or partially-encoded text (e.g. "secure0n*d", "3x7K") inside a single isolated element — it is likely a text animation or encoding artifact captured mid-render, not a real content issue.
- Do NOT flag form field labels that mix parameter names and type annotations — this is standard developer tooling UI, not a copywriting error.
- Do NOT flag text adjacent to UI badge/tag/label elements (shown as [Badge: text] in the HTML) as a word-merging or concatenation error — these are intentional inline UI chips.
- Do NOT flag invisible, zero-width, or non-printable characters (U+FEFF, U+200B, etc.) as content issues. These are encoding artifacts from CMS systems or web frameworks and do not affect how text renders or reads — flagging them is always a false positive.

Pages are truncated at an HTML tag boundary and marked with "[Content truncated due to length]". DO NOT flag content near this marker as incomplete — it is an extraction limit, not a real site issue. Large pages may appear as "part 1 of 2" / "part 2 of 2" — treat them as one continuous page.

Do NOT check or report ANY link issues — broken links, wrong destinations, link text, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.

${manifestText ? `Below is an ELEMENT MANIFEST showing interactive elements on the page:\n${manifestText}\n\n---\n` : ''}

${categoryInstructions[category]}

**HOW TO USE THE MANIFEST:**
- Use it to avoid false positives about missing elements
- The manifest shows code structure, NOT functionality

If you encounter bot protection, return: BOT_PROTECTION_OR_FIREWALL_BLOCKED

**SEVERITY RUBRIC — assign carefully:**
- critical: broken functionality, completely wrong information, accessibility blocker (e.g. missing alt on key image, factual error that misleads users, nav link 404)
- medium: misleading content, inconsistent terminology across pages, style violations that affect trust (e.g. product name spelled two ways, ambiguous pricing claim)
- low: minor style preferences, nitpicks, cosmetic inconsistencies (e.g. trailing period in one CTA vs none in others)

**Examples:**
- critical: "professionalism: pricing page says \\"Free forever\\" but signup says \\"14-day trial\\" — contradictory claim that misleads users" (severity: critical)
- medium: "credibility: \\"AI-powered\\" used on homepage but \\"machine learning\\" used on features — inconsistent terminology" (severity: medium)
- low: "professionalism: footer copyright year is 2023, should be 2024" (severity: low)

**NOT critical (common severity inflation):** style/readability preferences (long paragraphs, jargon, passive voice) → low. Minor grammar that doesn't change meaning → low.

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

/**
 * Liberal (high-recall) category audit prompt for the Pro two-pass pipeline.
 * Optimizes for recall — find everything, let the checker sort it out.
 * Same signature as buildCategoryAuditPrompt so it can be swapped in directly.
 */
export function buildLiberalCategoryAuditPrompt(
  category: "Language" | "Facts & Consistency" | "Formatting",
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

DO NOT report Facts/Consistency or Formatting issues.`,

    "Facts & Consistency": `Focus ONLY on Facts & Consistency issues:
- Factual errors or incorrect information
- Inconsistent data, numbers, or stats across pages
- Contradictory statements
- Outdated information
- Naming inconsistencies (product names, company name variations)

When reporting cross-page contradictions, ALWAYS quote the exact text from BOTH sides.
Good: 'credibility: "file never touches our servers" (FAQ) contradicts "relayed through our server" (Transparency)'
Bad: 'credibility: FAQ claim contradicts transparency page'

DO NOT report Language or Formatting issues.`,

    "Formatting": `Focus ONLY on Formatting & UX issues:
- Formatting problems (inconsistent styles, broken layouts)
- Layout issues affecting readability
- Visual hierarchy problems
- Navigation UX issues

DO NOT check or report ANY link issues — broken links, wrong destinations, link text quality, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.
DO NOT report Language or Facts/Consistency issues.`
  }

  const urlListText = urlsToAudit.map((u, i) => `${i + 1}. ${u}`).join('\n')

  const ignoreBlock = ignoreKeywords?.length
    ? `\n# Allowed Terms\nDO NOT flag or suggest changing:\n${ignoreKeywords.map(k => `- ${k}`).join('\n')}\n`
    : ''
  const flagBlock = flagKeywords?.length
    ? `\n# Flag Keywords\nALWAYS flag when present:\n${flagKeywords.map(k => `- ${k}`).join('\n')}\n`
    : ''

  // Manifest goes FIRST so it forms a shared prefix across all 3 parallel category calls.
  // OpenAI prompt caching fires when the prefix is identical — putting the large manifest
  // first means calls 2 and 3 get a cache hit on the manifest tokens (~50% cost reduction
  // on those tokens). The small category-specific instruction comes after.
  return `${manifestText ? `${manifestText}\n\n---\n\n` : ''}You are auditing for ${category} issues ONLY. A separate checker model will verify every finding — when in doubt, include it. A checker verifies everything.

**AUDIT EXACTLY THESE ${urlsToAudit.length} URLs:**
${urlListText}

Do NOT audit any other pages. Focus only on these specific URLs.

**Language detection:** Detect the primary language of the site from its homepage. Write all output in that language. Audit ONLY content in the primary language. If a page or section is in a different language, skip it entirely — do not flag spelling or grammar in non-primary languages. Do not flag brand names, technical terms, or proper nouns in any language.

**RESPONSIVE DUPLICATES — read before auditing:**
Modern sites ship BOTH mobile and desktop versions of components in the same HTML. Seeing the same text twice is intentional responsive design, not a content issue. CSS class attributes have been removed from the HTML you receive, so use structural clues to identify them.

How to spot them:
- Two <nav> elements (mobile drawer + desktop bar) are standard
- Two sections or divs with identical text content are likely mobile/desktop variants — audit the content ONCE
- Repeated CTAs, hero text, or banners appearing in the same page are usually responsive pairs

**DYNAMIC / INTERACTIVE CONTENT — do not flag these:**
- Do NOT flag numbers, text, or values inside interactive components (sliders, counters, animated number displays, progress bars). These show a snapshot state at scrape time — values like "0 seconds", "$0", or garbled text inside animated elements are NOT content errors.
- Do NOT flag garbled or partially-encoded text (e.g. "secure0n*d", "3x7K") inside a single isolated element — it is likely a text animation or encoding artifact captured mid-render, not a real content issue.
- Do NOT flag form field labels that mix parameter names and type annotations — this is standard developer tooling UI, not a copywriting error.
- Do NOT flag text adjacent to UI badge/tag/label elements (shown as [Badge: text] in the HTML) as a word-merging or concatenation error — these are intentional inline UI chips.
- Do NOT flag invisible, zero-width, or non-printable characters (U+FEFF, U+200B, etc.) as content issues. These are encoding artifacts from CMS systems or web frameworks and do not affect how text renders or reads — flagging them is always a false positive.

Pages are truncated at an HTML tag boundary and marked with "[Content truncated due to length]". DO NOT flag content near this marker as incomplete — it is an extraction limit, not a real site issue. Large pages may appear as "part 1 of 2" / "part 2 of 2" — treat them as one continuous page.

Do NOT check or report ANY link issues — broken links, wrong destinations, link text, mailto/tel links, or external links. A separate automated system handles all link validation via HTTP checks.

${categoryInstructions[category]}

The element manifest shows code structure — use it to avoid false positives about missing elements.

If you encounter bot protection, return: BOT_PROTECTION_OR_FIREWALL_BLOCKED

**Report the same issue on each page it appears** — don't deduplicate across pages. Severity is optional and defaults to "medium" if uncertain.

**When flagging repeated or redundant content**, list the specific pages where it appears and how many times. Don't just say "repeated" — say where.

**SEVERITY RUBRIC — assign carefully:**
- critical: broken functionality, completely wrong information, accessibility blocker (e.g. missing alt on key image, factual error that misleads users, nav link 404)
- medium: misleading content, inconsistent terminology across pages, style violations that affect trust (e.g. product name spelled two ways, ambiguous pricing claim)
- low: minor style preferences, nitpicks, cosmetic inconsistencies (e.g. trailing period in one CTA vs none in others)

**Examples:**
- critical: "professionalism: pricing page says \\"Free forever\\" but signup says \\"14-day trial\\" — contradictory claim that misleads users" (severity: critical)
- medium: "credibility: \\"AI-powered\\" used on homepage but \\"machine learning\\" used on features — inconsistent terminology" (severity: medium)
- low: "professionalism: footer copyright year is 2023, should be 2024" (severity: low)

**NOT critical (common severity inflation):** style/readability preferences (long paragraphs, jargon, passive voice) → low. Minor grammar that doesn't change meaning → low. Missing articles (a/an/the) in non-headline positions → low.

For every issue, provide:
- page_url: The URL where issue was found
- category: "${category}" (always this category)
- issue_description: impact label (professionalism:, trust:, clarity:, credibility:, frustration:) then: quote the exact text, state the problem, name the pages if cross-page. Be specific — vague descriptions waste the user's time.
- severity: "critical", "medium", or "low" (default "medium" if unsure)
- suggested_fix: what to change and how, in one clear sentence

Output format — return ONLY the issues array, no summary counts:
{
  "issues": [...]
}

If no ${category} issues found, return: null
${ignoreBlock}
${flagBlock}
${excludedIssues && excludedIssues !== '[]' ? `\n# Previously Resolved/Ignored Issues\n\nDO NOT report these again:\n${excludedIssues}\n` : ''}
${activeIssues && activeIssues !== '[]' ? `\n# Active Issues\n\nVerify if these still exist:\n${activeIssues}\n` : ''}`
}

/**
 * Checker prompt for the Pro two-pass pipeline.
 * Given HTML snippets (potentially from multiple pages) and candidate issues,
 * determine which are real. One call per category, not per page.
 * Optimizes for precision — only confirmed issues reach the user.
 */
export function buildCheckerPrompt(
  snippetsText: string,
  issues: Array<{ category: string; issue_description: string; page_url?: string }>,
  category: string
): string {
  const categoryVerification: Record<string, string> = {
    "Language": "Confirm the exact quoted text exists in the HTML AND contains the claimed error. Valid stylistic choices (brand voice, intentional tone) are not errors. Regional spelling (UK vs US English) on a locale-targeted site is a valid concern, not a stylistic choice. If the claimed error text appears inside an animated number component, counter, or interactive widget (look for `inert` attributes on sibling elements, or custom elements like `<number-flow-react>`), mark confirmed: false — these are scrape-time snapshots, not real content. If the issue claims invisible characters, zero-width characters, or non-printable characters, search for the exact codepoint (U+200B, U+FEFF, U+200C, etc.) in the HTML evidence. If no such codepoint is present, mark confirmed: false.",
    "Facts & Consistency": "Confirm the claimed text/data is present. You can verify internal consistency (numbers matching across sections) but not external facts. If the text exists and the inconsistency is real within the page, confirm. Cross-page contradictions are valid. If an issue claims page A contradicts page B, look for evidence from both pages in the excerpts. If the claimed value appears inside an interactive component (slider, counter, progress bar), mark confirmed: false — it is a snapshot state, not a real content error.",
    "Formatting": "Confirm the HTML structure supports the claim (empty alt, wrong heading level, missing aria). Layout/render issues that can't be verified from static HTML → mark uncertain. If the issue describes garbled or scrambled text inside a single isolated element, check for signs of animation (sibling elements with `inert`, custom web components, or repeated character sets 0-9) — if present, mark confirmed: false. If the issue claims missing visual indicators (checkmarks, icons, dots, slide markers) that would only be visible in a rendered browser, mark confirmed: false — static HTML cannot verify CSS/SVG rendering.",
  }

  const verificationInstruction = categoryVerification[category]
    || "Check that each issue has clear supporting evidence in the HTML before confirming."

  const issueList = issues
    .map((issue, i) => `${i}. [${issue.category}] ${issue.issue_description}`)
    .join('\n')

  return `You are the final quality gate. Only issues that survive your review reach the user. Be skeptical — require clear HTML evidence.

${verificationInstruction}

Issues to verify:
${issueList}

Below is the full cleaned HTML for each page that has issues — the same HTML the auditor reviewed. Find the evidence for each issue directly in the page content.

${snippetsText}

For each issue return:
- confirmed: true (clear evidence) | false (no evidence or claim is wrong) | "uncertain" (plausible but not provable from static HTML)
- confidence: 0.0-1.0
- severity: final severity ("critical", "medium", or "low")
- evidence: HTML snippet proving or refuting the issue (max 200 chars)

Return ONLY valid JSON in this exact format:
{
  "verifications": [
    {"index": 0, "confirmed": true, "confidence": 0.95, "severity": "medium", "evidence": "<a href=\\"tel:\\">Contact</a>"},
    {"index": 1, "confirmed": false, "confidence": 0.9, "severity": "low", "evidence": "text not found in HTML"}
  ]
}`
}
