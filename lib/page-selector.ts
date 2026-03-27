// Deterministic page selection with heuristic scoring.
// Replaced model-based selectPagesToAudit with scoring to avoid non-determinism.
// Model call kept for tiebreaking with temperature: 0 when needed.

import Logger from './logger'

const LONGFORM_PATH_PATTERNS = [
  /\/blog(\/|$)/i,
  /\/articles?(\/|$)/i,
  /\/news(\/|$)/i,
  /\/insights(\/|$)/i,
  /\/resources(\/|$)/i,
  /\/guides?(\/|$)/i,
]

// Foreign language path prefixes to filter out
const FOREIGN_LANG_PATTERN = /^\/(es|pt|it|fr|de|ja|ko|zh|nl|ru|ar|sv|da|nb|fi|pl|cs|tr|he|hu|th|vi|ro|bg|uk|el|id|ms|hi)\//i

function isLongformUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    return LONGFORM_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname || '/'))
  } catch {
    return false
  }
}

function isForeignLanguageUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    return FOREIGN_LANG_PATTERN.test(parsed.pathname || '/')
  } catch {
    return false
  }
}

/**
 * Score a URL by importance for content auditing.
 * Higher score = higher priority.
 */
function scoreUrl(url: string): number {
  let score = 0
  let pathname = '/'
  try {
    pathname = new URL(url.startsWith('http') ? url : `https://${url}`).pathname
  } catch {
    return 0
  }

  // Homepage gets highest priority
  if (pathname === '/' || pathname === '') return 1000

  // High-value marketing pages
  if (/\/(pricing|plans?|buy|subscribe)(\/|$)/i.test(pathname)) score += 90
  if (/\/(about|company|team|story)(\/|$)/i.test(pathname)) score += 80
  if (/\/(product|features?|solutions?|platform)(\/|$)/i.test(pathname)) score += 70
  if (/\/(contact|support|help)(\/|$)/i.test(pathname)) score += 60
  if (/\/(home|index)(\/|$)/i.test(pathname)) score += 95

  // Depth penalty: prefer shallower pages
  const depth = pathname.split('/').filter(Boolean).length
  score -= depth * 5

  // Longform gets lower priority
  if (isLongformUrl(url)) score -= 30

  return score
}

/**
 * Pick the most valuable pages from a discovered URL list using deterministic heuristic scoring.
 * - FREE tier: 5 pages, PAID tier: 20 pages
 * - Always includes homepage
 * - Filters foreign language pages
 * - Validates output against discovered URLs to prevent hallucination
 */
export async function selectPagesToAudit(
  discoveredUrls: string[],
  domain: string,
  tier: 'FREE' | 'PAID',
  includeLongformFullAudit: boolean
): Promise<string[]> {
  const targetCount = tier === 'FREE' ? 5 : 20

  // Always include homepage
  const homepage =
    discoveredUrls.find((u) => {
      try {
        const path = new URL(u).pathname
        return path === '/' || path === ''
      } catch {
        return false
      }
    }) || `https://${domain}`

  // Filter foreign language URLs
  const langFiltered = discoveredUrls.filter((u) => !isForeignLanguageUrl(u))
  if (langFiltered.length < discoveredUrls.length) {
    Logger.info(`[PageSelection] Filtered ${discoveredUrls.length - langFiltered.length} foreign-language URLs`)
  }

  const candidateUrls = includeLongformFullAudit
    ? langFiltered
    : langFiltered.filter((u) => !isLongformUrl(u))
  const urlsForSelection = candidateUrls.length > 0 ? candidateUrls : langFiltered.length > 0 ? langFiltered : discoveredUrls

  // If we have fewer URLs than the target, just use all of them
  if (urlsForSelection.length <= targetCount) {
    Logger.info(`[PageSelection] Using all ${urlsForSelection.length} discovered URLs (<=  ${targetCount} target)`)
    return urlsForSelection.length > 0 ? urlsForSelection : [homepage]
  }

  // Score and sort URLs deterministically
  const scored = urlsForSelection
    .map((url) => ({ url, score: scoreUrl(url) }))
    .sort((a, b) => b.score - a.score)

  const selected = scored.slice(0, targetCount).map((s) => s.url)

  // Ensure homepage is first
  if (!selected.includes(homepage)) {
    selected[selected.length - 1] = homepage
  }
  // Move homepage to front
  const homepageIdx = selected.indexOf(homepage)
  if (homepageIdx > 0) {
    selected.splice(homepageIdx, 1)
    selected.unshift(homepage)
  }

  // Hallucination guard: validate against discovered URLs
  const normalize = (url: string) => {
    try {
      const parsed = new URL(url)
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '').toLowerCase()
    } catch {
      return url.replace(/\/$/, '').toLowerCase()
    }
  }
  const normalizedDiscovered = urlsForSelection.map(normalize)
  const validUrls = selected.filter((url) => normalizedDiscovered.includes(normalize(url)))
  const hallucinatedCount = selected.length - validUrls.length
  if (hallucinatedCount > 0) {
    Logger.warn(`[PageSelection] ${hallucinatedCount} URLs failed hallucination guard (unexpected)`)
  }

  const finalUrls = validUrls.length > 0 ? validUrls : [homepage, ...urlsForSelection.filter((u) => u !== homepage).slice(0, targetCount - 1)]

  Logger.info(`[PageSelection] Selected ${finalUrls.length} pages deterministically`)
  return finalUrls
}
