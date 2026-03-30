"use client"

import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { CheckCircle2, Circle } from "lucide-react"

interface SiteDiscoveryCardProps {
  discoveredPages: string[]
  auditedUrls: string[]
  isAuthenticated: boolean
}

// Format URL for display (remove protocol, show path)
function formatUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === "/" ? parsed.hostname : `${parsed.hostname}${parsed.pathname}`
    return path.replace(/\/$/, "")
  } catch {
    return url
  }
}

export function SiteDiscoveryCard({ discoveredPages, auditedUrls, isAuthenticated }: SiteDiscoveryCardProps) {
  // Get pages that were discovered but not audited
  const auditedSet = new Set(auditedUrls.map(u => u.replace(/\/$/, "")))
  const remainingPages = discoveredPages.filter(page => !auditedSet.has(page.replace(/\/$/, "")))

  // Don't show if no discovered pages
  if (discoveredPages.length === 0) {
    return null
  }

  return (
    <Card className="border border-border">
      <CardHeader>
        <CardTitle className="font-serif text-2xl font-semibold">
          Site Discovery
        </CardTitle>
        <CardDescription>
          Found {discoveredPages.length} pages on your site
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Audited Pages */}
        {auditedUrls.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground uppercase tracking-wider mb-3">
              Audited
            </p>
            <div className="space-y-2">
              {auditedUrls.slice(0, 5).map((url, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-foreground shrink-0" />
                  <span className="font-mono text-foreground truncate">{formatUrl(url)}</span>
                </div>
              ))}
              {auditedUrls.length > 5 && (
                <p className="text-sm text-muted-foreground pl-6">
                  +{auditedUrls.length - 5} more audited
                </p>
              )}
            </div>
          </div>
        )}

        {/* Discovered (not audited) */}
        {remainingPages.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground uppercase tracking-wider mb-3">
              Discovered
            </p>
            <div className="space-y-2">
              {remainingPages.slice(0, 5).map((url, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Circle className="h-4 w-4 shrink-0" />
                  <span className="font-mono truncate">{formatUrl(url)}</span>
                </div>
              ))}
              {remainingPages.length > 5 && (
                <p className="text-sm text-muted-foreground pl-6">
                  +{remainingPages.length - 5} more
                </p>
              )}
            </div>
          </div>
        )}

        {/* What we checked */}
        <div className="border-t border-border pt-6">
          <p className="text-sm text-muted-foreground uppercase tracking-wider mb-3">
            What we checked
          </p>
          <div className="space-y-2 text-sm">
            <p>• Language (grammar, spelling, clarity)</p>
            <p>• Facts & Consistency (accuracy, brand voice)</p>
            <p>• Formatting (layout, visual hierarchy)</p>
          </div>
        </div>
      </CardContent>

      <CardFooter className="border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          Free: {auditedUrls.length} page{auditedUrls.length !== 1 ? "s" : ""} audited
          {remainingPages.length > 0 && (
            <span> • <span className="text-foreground">Pro: All {discoveredPages.length} pages</span></span>
          )}
        </p>
      </CardFooter>
    </Card>
  )
}
