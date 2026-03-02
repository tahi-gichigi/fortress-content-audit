"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Circle, FileDiff } from "lucide-react"
import { useMemo } from "react"

interface PagesSummaryModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pagesFound: number | null
  pagesAudited: number
  pagesWithIssues: number
  discoveredPages: string[]
  auditedUrls: string[]
  /** Paths (from URL pathname) that have at least one active issue */
  pagePathsWithIssues: Set<string>
}

function formatUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "")
    const maxLen = 36
    if (path.length > maxLen) return path.substring(0, maxLen - 3) + "..."
    return path || "/"
  } catch {
    return url
  }
}

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

function pathHasIssues(url: string, pagePathsWithIssues: Set<string>): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "") || "/"
    return pagePathsWithIssues.has(path)
  } catch {
    return false
  }
}

export function PagesSummaryModal({
  open,
  onOpenChange,
  pagesFound,
  pagesAudited,
  pagesWithIssues,
  discoveredPages,
  auditedUrls,
  pagePathsWithIssues,
}: PagesSummaryModalProps) {
  const totalFound = pagesFound ?? discoveredPages.length

  const auditedSet = useMemo(() => buildAuditedPathSet(auditedUrls), [auditedUrls])

  const sortedPages = useMemo(() => {
    return [...discoveredPages].sort((a, b) => {
      const aAudited = isAuditedBySet(a, auditedSet)
      const bAudited = isAuditedBySet(b, auditedSet)
      if (aAudited && !bAudited) return -1
      if (!aAudited && bAudited) return 1
      return a.localeCompare(b)
    })
  }, [discoveredPages, auditedSet])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl font-semibold">
            Pages summary
          </DialogTitle>
          <DialogDescription>
            Pages found, audited, and which have issues
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
          <div className="space-y-2 text-sm rounded-lg border bg-muted/30 p-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pages found</span>
              <span className="font-medium tabular-nums">{totalFound}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pages audited</span>
              <span className="font-medium tabular-nums">{pagesAudited}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pages with issues</span>
              <span className="font-medium tabular-nums">{pagesWithIssues}</span>
            </div>
          </div>

          {sortedPages.length > 0 && (
            <div className="flex flex-col min-h-0">
              <p className="text-sm font-medium text-muted-foreground mb-2">
                Page list
              </p>
              <ul className="space-y-1.5 text-sm overflow-y-auto max-h-[220px] pr-1 border rounded-md p-2 bg-muted/20">
                {sortedPages.map((url, i) => {
                    const audited = isAuditedBySet(url, auditedSet)
                    const hasIssues = pathHasIssues(url, pagePathsWithIssues)
                    return (
                      <li
                        key={i}
                        className="flex items-center gap-2 min-w-0 text-foreground"
                      >
                        {audited ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                        )}
                        <span className="font-mono text-xs truncate">
                          {formatUrl(url)}
                        </span>
                        {hasIssues && (
                          <FileDiff className="h-4 w-4 text-muted-foreground shrink-0" title="Has content issues" />
                        )}
                      </li>
                    )
                  })}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
