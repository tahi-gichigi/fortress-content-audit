/**
 * Mock audit data generator for UI testing
 * Generates realistic audit results with varied issue types
 */

/**
 * Generate complete mock audit data with varied issue types
 * Creates 8-10 realistic issues covering all audit categories
 * 
 * @param origin - Full origin URL (e.g., 'https://example.com') or domain string
 * @param issueCount - Number of issues to generate (default: 10)
 */
export function createMockAuditData(origin: string = 'https://example.com', issueCount: number = 10) {
  // Normalize to base URL - handle both full URLs and domain strings
  let baseUrl: string
  try {
    // If it's already a full URL, use it; otherwise construct it
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      baseUrl = origin
    } else {
      baseUrl = `https://${origin}`
    }
  } catch {
    // Fallback if URL parsing fails
    baseUrl = `https://${origin}`
  }
  const issues: Array<{
    page_url: string
    category: 'Language' | 'Facts & Consistency' | 'Formatting'
    issue_description: string
    severity: 'low' | 'medium' | 'critical'
    suggested_fix: string
  }> = []

  // Issue templates with realistic examples
  const issueTemplates: Array<{
    page_url: string
    category: 'Language' | 'Facts & Consistency' | 'Formatting'
    issue_description: string
    severity: 'low' | 'medium' | 'critical'
    suggested_fix: string
  }> = [
    {
      page_url: `${baseUrl}/contact`,
      category: 'Language',
      issue_description: "professionalism: 'suport' is misspelled—it should be 'support'.",
      severity: 'medium',
      suggested_fix: "Correct spelling to 'support'.",
    },
    {
      page_url: `${baseUrl}/help`,
      category: 'Language',
      issue_description: "professionalism: 'suport' is misspelled—it should be 'support'.",
      severity: 'medium',
      suggested_fix: "Correct spelling to 'support'.",
    },
    {
      page_url: `${baseUrl}/about`,
      category: 'Language',
      issue_description: "professionalism: 'accomodate' is misspelled—it should be 'accommodate'.",
      severity: 'medium',
      suggested_fix: "Correct spelling to 'accommodate'.",
    },
    {
      page_url: `${baseUrl}/services`,
      category: 'Language',
      issue_description: "professionalism: 'accomodate' is misspelled—it should be 'accommodate'.",
      severity: 'medium',
      suggested_fix: "Correct spelling to 'accommodate'.",
    },
    {
      page_url: `${baseUrl}/team`,
      category: 'Language',
      issue_description: "professionalism: 'The team are' uses incorrect subject-verb agreement—should be 'The team is'.",
      severity: 'medium',
      suggested_fix: "Change to 'The team is'.",
    },
    {
      page_url: `${baseUrl}/faq`,
      category: 'Language',
      issue_description: "readability: 'dont' is missing an apostrophe—should be 'don't'.",
      severity: 'low',
      suggested_fix: "Add apostrophe: 'don't'.",
    },
    {
      page_url: `${baseUrl}/terms`,
      category: 'Language',
      issue_description: "readability: 'dont' is missing an apostrophe—should be 'don't'.",
      severity: 'low',
      suggested_fix: "Add apostrophe: 'don't'.",
    },
    {
      page_url: `${baseUrl}/pricing`,
      category: 'Facts & Consistency',
      issue_description: "trust: Pricing shows $29/month but features page shows $39/month, creating confusion.",
      severity: 'critical',
      suggested_fix: "Standardize pricing across all pages to a single consistent amount.",
    },
    {
      page_url: `${baseUrl}/`,
      category: 'Facts & Consistency',
      issue_description: "confidence: Terminology inconsistency—uses 'customer', 'client', and 'user' interchangeably.",
      severity: 'medium',
      suggested_fix: "Standardize to 'customer' across all pages.",
    },
    {
      page_url: `${baseUrl}/pricing`,
      category: 'Facts & Consistency',
      issue_description: "trust: Product name formatting inconsistent—appears as 'ProductName', 'Product-Name', and 'Product Name'.",
      severity: 'critical',
      suggested_fix: "Standardize product name formatting across all pages.",
    },
    {
      page_url: `${baseUrl}/help`,
      category: 'Facts & Consistency',
      issue_description: "confidence: Setup time conflict—help page says 5 minutes, docs say 10 minutes.",
      severity: 'medium',
      suggested_fix: "Consolidate conflicting information and use consistent setup time.",
    },
    {
      page_url: `${baseUrl}/products`,
      category: 'Formatting',
      issue_description: "trust: Page is missing an H1 tag, which hurts SEO and page structure.",
      severity: 'medium',
      suggested_fix: "Add H1 tag with primary keyword.",
    },
    {
      page_url: `${baseUrl}/blog`,
      category: 'Formatting',
      issue_description: "trust: Blog listing page is missing an H1 tag.",
      severity: 'medium',
      suggested_fix: "Add H1 tag to blog listing page.",
    },
    {
      page_url: `${baseUrl}/page1`,
      category: 'Formatting',
      issue_description: "credibility: Duplicate meta description used on multiple pages, reducing SEO effectiveness.",
      severity: 'low',
      suggested_fix: "Create unique meta descriptions for each page.",
    },
    {
      page_url: `${baseUrl}/resources`,
      category: 'Formatting',
      issue_description: "frustration: Link to /old-page returns 404 error.",
      severity: 'critical',
      suggested_fix: "Fix or remove broken link—update URL or redirect to correct page.",
    },
    {
      page_url: `${baseUrl}/docs`,
      category: 'Formatting',
      issue_description: "frustration: Link to /deprecated-feature returns 404 error.",
      severity: 'critical',
      suggested_fix: "Fix or remove broken link—update URL or redirect to correct page.",
    },
  ]

  // Generate issues from templates, up to issueCount
  const templatesToUse = issueTemplates.slice(0, Math.min(issueCount, issueTemplates.length))
  
  for (let i = 0; i < templatesToUse.length; i++) {
    const template = templatesToUse[i]
    issues.push({
      page_url: template.page_url,
      category: template.category,
      issue_description: template.issue_description,
      severity: template.severity,
      suggested_fix: template.suggested_fix,
    })
  }

  // If more issues requested than templates, duplicate with variations
  if (issueCount > issueTemplates.length) {
    const additional = issueCount - issueTemplates.length
    for (let i = 0; i < additional; i++) {
      const baseTemplate = issueTemplates[i % issueTemplates.length]
      try {
        const url = new URL(baseTemplate.page_url)
        url.pathname = `/v${i + 2}${url.pathname}`
        issues.push({
          page_url: url.toString(),
          category: baseTemplate.category,
          issue_description: `${baseTemplate.issue_description} (Additional)`,
          severity: baseTemplate.severity,
          suggested_fix: baseTemplate.suggested_fix,
        })
      } catch {
        // Fallback if URL parsing fails
        issues.push({
          page_url: `${baseUrl}/v${i + 2}${baseTemplate.page_url.replace(baseUrl, '')}`,
          category: baseTemplate.category,
          issue_description: `${baseTemplate.issue_description} (Additional)`,
          severity: baseTemplate.severity,
          suggested_fix: baseTemplate.suggested_fix,
        })
      }
    }
  }

  // Generate audited URLs from all page_urls
  const auditedUrls = Array.from(
    new Set(issues.map(issue => issue.page_url))
  )

  const discoveredPages = auditedUrls.length > 0 ? auditedUrls : [baseUrl]
  return {
    issues,
    pagesAudited: auditedUrls.length > 0 ? auditedUrls.length : 1,
    auditedUrls,
    discoveredPages,
  }
}

