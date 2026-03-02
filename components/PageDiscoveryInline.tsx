"use client"

import { useState, useEffect, useMemo } from "react"
import { ChevronDown, ChevronUp, CheckCircle2, Circle, ExternalLink } from "lucide-react"

interface PageDiscoveryInlineProps {
  discoveredPages: string[]
  auditedUrls: string[] // Actual list of audited URLs (replaces pagesAudited number)
  pagesFound: number | null
  isAuthenticated?: boolean
  /** When true, expanded list is rendered by parent (full-width row). Summary only here. */
  fullWidthExpanded?: boolean
  expanded?: boolean
  onExpandChange?: (expanded: boolean) => void
}

// Format URL for display: show full path (no truncation)
function formatUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "")
    return path || "/"
  } catch {
    return url
  }
}

// Build a Set of audited pathname keys for O(1) lookup
function buildAuditedPathSet(auditedUrls: string[]): Set<string> {
  const set = new Set<string>()
  for (const url of auditedUrls) {
    try {
      set.add(new URL(url).pathname.replace(/\/$/, ""))
    } catch {
      set.add(url)
    }
  }
  return set
}

function isAuditedBySet(url: string, auditedSet: Set<string>): boolean {
  try {
    return auditedSet.has(new URL(url).pathname.replace(/\/$/, ""))
  } catch {
    return auditedSet.has(url)
  }
}

// Get page priority for intelligent sorting
function getPagePriority(url: string): number {
  try {
    const path = new URL(url).pathname.toLowerCase().replace(/\/$/, "")

    // Homepage always first
    if (path === '' || path === '/') return 0

    // Key pages in priority order
    if (path.includes('/pricing') || path.includes('/plans')) return 1
    if (path.includes('/about')) return 2
    if (path.includes('/features') || path.includes('/product')) return 3
    if (path.includes('/contact') || path.includes('/support')) return 4
    if (path.includes('/blog') || path.includes('/changelog')) return 5
    if (path.includes('/faq') || path.includes('/help')) return 6

    // Everything else
    return 10
  } catch {
    return 10
  }
}

// Shared list UI: scrollable grid, full-width when used in dashboard row
function PageDiscoveryListInner({
  sortedPages,
  auditedSet,
  isDesktop,
  className,
}: {
  sortedPages: string[]
  auditedSet: Set<string>
  isDesktop: boolean
  className?: string
}) {
  return (
    <>
      <div
        className={`max-h-60 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 w-full ${className ?? ""}`}
      >
        <div
          className={`grid gap-x-6 gap-y-1.5 ${
            isDesktop ? 'grid-cols-4' : 'grid-cols-1'
          }`}
        >
          {sortedPages.map((url, i) => {
            const audited = isAuditedBySet(url, auditedSet)
            return (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-2 text-sm py-0.5 rounded hover:bg-muted transition-colors group/link min-w-0 ${
                  audited ? 'text-foreground' : 'text-muted-foreground'
                }`}
                title={`Open ${url} in new tab`}
              >
                {audited ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                )}
                <span className="font-mono text-xs truncate">{formatUrl(url)}</span>
                <ExternalLink className="h-3 w-3 opacity-0 group-hover/link:opacity-50 transition-opacity shrink-0" />
              </a>
            )
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        {sortedPages.length} pages · Click any to open in new tab
      </p>
    </>
  )
}

export function PageDiscoveryInline({
  discoveredPages,
  auditedUrls,
  pagesFound,
  isAuthenticated = false,
  fullWidthExpanded = false,
  expanded: controlledExpanded,
  onExpandChange,
}: PageDiscoveryInlineProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)
  const isControlled = controlledExpanded !== undefined
  const isExpanded = isControlled ? controlledExpanded : internalExpanded

  const setExpanded = (v: boolean) => {
    if (!isControlled) setInternalExpanded(v)
    onExpandChange?.(v)
  }

  // Detect screen size for column count
  useEffect(() => {
    const update = () => {
      setIsDesktop(window.innerWidth >= 768)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Use pagesFound if available, otherwise fall back to discoveredPages length
  const totalPages = pagesFound ?? discoveredPages.length
  const auditedCount = auditedUrls.length

  // Pre-compute audited path set once (O(m) instead of O(n*m) per render)
  const auditedSet = useMemo(() => buildAuditedPathSet(auditedUrls), [auditedUrls])

  // Memoize sorted pages so toggling expanded doesn't re-sort
  const sortedPages = useMemo(() => {
    return [...discoveredPages].sort((a, b) => {
      const aAudited = isAuditedBySet(a, auditedSet)
      const bAudited = isAuditedBySet(b, auditedSet)
      if (aAudited && !bAudited) return -1
      if (!aAudited && bAudited) return 1
      const aPriority = getPagePriority(a)
      const bPriority = getPagePriority(b)
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.localeCompare(b)
    })
  }, [discoveredPages, auditedSet])

  // Don't render if no pages discovered
  if (totalPages === 0) return null

  // Tier limits
  const freeLimit = 5
  const proLimit = 20

  return (
    <div className="text-sm">
      {/* Summary line with toggle */}
      <button
        onClick={() => setExpanded(!isExpanded)}
        className="flex items-center flex-wrap gap-x-2 gap-y-1 text-muted-foreground hover:text-foreground transition-colors group"
      >
        <span>
          <span className="text-foreground font-medium">{auditedCount}</span>
          {" of "}
          <span className="text-foreground font-medium">{totalPages}</span>
          {" pages audited"}
        </span>
        <span className="text-muted-foreground/60">·</span>
        {!isAuthenticated ? (
          <span className="text-muted-foreground">
            Free audit: up to {freeLimit} pages · <span className="text-foreground">Pro audit: up to {proLimit} pages</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Pro audit</span>
        )}
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        )}
      </button>

      {/* Expandable page list: inline or rendered by parent when fullWidthExpanded */}
      {!fullWidthExpanded && isExpanded && discoveredPages.length > 0 && (
        <div className="mt-3 animate-in fade-in slide-in-from-top-2 duration-200 w-full">
          <PageDiscoveryListInner
            sortedPages={sortedPages}
            auditedSet={auditedSet}
            isDesktop={isDesktop}
          />
        </div>
      )}
    </div>
  )
}

/** Full-width URL list for dashboard. Use when PageDiscoveryInline has fullWidthExpanded + controlled expanded. */
export function PageDiscoveryList({
  discoveredPages,
  auditedUrls,
}: {
  discoveredPages: string[]
  auditedUrls: string[]
}) {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const update = () => setIsDesktop(window.innerWidth >= 768)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const auditedSet = useMemo(() => buildAuditedPathSet(auditedUrls), [auditedUrls])

  const sortedPages = useMemo(() => {
    return [...discoveredPages].sort((a, b) => {
      const aAudited = isAuditedBySet(a, auditedSet)
      const bAudited = isAuditedBySet(b, auditedSet)
      if (aAudited && !bAudited) return -1
      if (!aAudited && bAudited) return 1
      const aPriority = getPagePriority(a)
      const bPriority = getPagePriority(b)
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.localeCompare(b)
    })
  }, [discoveredPages, auditedSet])

  if (sortedPages.length === 0) return null

  return (
    <div className="animate-in fade-in slide-in-from-top-2 duration-200 w-full">
      <PageDiscoveryListInner
        sortedPages={sortedPages}
        auditedSet={auditedSet}
        isDesktop={isDesktop}
      />
    </div>
  )
}
