"use client"

import * as React from "react"
import { Loader2, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AuditPreset } from "@/types/fortress"

export interface InterstitialLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Main heading text displayed in serif font
   */
  title?: string
  /**
   * Optional description text below the title
   */
  description?: string
  /**
   * Show loading spinner. Defaults to true.
   */
  showSpinner?: boolean
  /**
   * Z-index value. Defaults to 50.
   */
  zIndex?: number
  /**
   * Whether the loader is visible
   */
  open?: boolean
  /**
   * List of pages currently being crawled (for progress display)
   */
  pagesBeingCrawled?: string[]
  /**
   * Number of pages audited so far
   */
  pagesAudited?: number
  /**
   * Reasoning summaries from the model's thinking process
   */
  reasoningSummaries?: string[]
  /**
   * Audit tier information for showing limitations
   */
  auditTier?: 'free' | 'pro' | 'enterprise'
  /**
   * Whether user is authenticated (affects tier messaging)
   */
  isAuthenticated?: boolean
  /**
   * Number of pages found on the site (from manifest extraction)
   */
  pagesFound?: number | null
  /**
   * Audit preset (affects time estimate messaging)
   */
  preset?: AuditPreset
}

const InterstitialLoader = React.forwardRef<HTMLDivElement, InterstitialLoaderProps>(
  (
    {
      className,
      title,
      description,
      showSpinner = true,
      zIndex = 50,
      open = true,
      pagesBeingCrawled = [],
      pagesAudited = 0,
      reasoningSummaries = [],
      auditTier,
      isAuthenticated = false,
      pagesFound,
      preset,
      children,
      ...props
    },
    ref
  ) => {
    const [shownSummaries, setShownSummaries] = React.useState<{ message: string; completed: boolean }[]>([])

    // Calculate max pages audited based on tier
    const maxPagesAudited = auditTier === 'free' ? 5 : auditTier === 'pro' ? 20 : 60

    // Canned reasoning summaries in the same style as model output
    const cannedSummaries = [
      "Reviewing homepage content and structure",
      "Checking for spelling and grammar issues",
      "Analyzing page consistency and formatting",
      "Identifying broken links and navigation issues",
      "Reviewing calls to action and messaging",
      "Assessing content clarity and readability",
      "Checking for factual accuracy and claims",
      "Analyzing user experience and flow",
      "Reviewing footer and contact information",
      "Compiling findings and recommendations",
    ]

    // Use canned summaries instead of reasoningSummaries prop
    const summaries = cannedSummaries

    // Add summaries one by one, accumulating them on screen
    // Only start after pages found appears (or after 20s timeout if manifest extraction fails)
    React.useEffect(() => {
      if (!open || summaries.length === 0) {
        setShownSummaries([])
        return
      }

      // Don't show progress messages until pages found appears
      // (or after 20s timeout in case manifest extraction fails)
      const shouldShowMessages = pagesFound !== null && pagesFound !== undefined

      // If pages not found yet, set timeout to show messages anyway after 20s
      const timeouts: NodeJS.Timeout[] = []
      let startTimeout: NodeJS.Timeout | null = null

      if (!shouldShowMessages) {
        // Wait up to 20 seconds for pages found, then show messages anyway
        startTimeout = setTimeout(() => {
          // Start showing messages if still open
          if (!open) return
          setShownSummaries([{ message: summaries[0], completed: false }])

          // Add remaining summaries
          for (let i = 1; i < summaries.length; i++) {
            const summaryToAdd = summaries[i]
            const timeout = setTimeout(() => {
              setShownSummaries((prev) => {
                if (prev.length < summaries.length) {
                  const updated = prev.map((item, idx) =>
                    idx === prev.length - 1 ? { ...item, completed: true } : item
                  )
                  return [...updated, { message: summaryToAdd, completed: false }]
                }
                return prev
              })
            }, i * 25000)
            timeouts.push(timeout)
          }
        }, 20000)
      } else {
        // Pages found - wait 2 seconds, then show first message
        const initialDelay = setTimeout(() => {
          setShownSummaries([{ message: summaries[0], completed: false }])

          // Add remaining summaries one by one with delay
          for (let i = 1; i < summaries.length; i++) {
            const summaryToAdd = summaries[i]
            const timeout = setTimeout(() => {
              setShownSummaries((prev) => {
                if (prev.length < summaries.length) {
                  const updated = prev.map((item, idx) =>
                    idx === prev.length - 1 ? { ...item, completed: true } : item
                  )
                  return [...updated, { message: summaryToAdd, completed: false }]
                }
                return prev
              })
            }, i * 25000)
            timeouts.push(timeout)
          }
        }, 2000) // 2 second delay after pages found appears
        timeouts.push(initialDelay)
      }

      return () => {
        if (startTimeout) clearTimeout(startTimeout)
        timeouts.forEach((timeout) => clearTimeout(timeout))
      }
    }, [open, pagesFound]) // Trigger when open changes or pages found becomes available

    if (!open) return null

    return (
      <div
        ref={ref}
        className={cn(
          "fixed inset-0 bg-background z-50 flex items-center justify-center animate-in fade-in duration-300",
          className
        )}
        style={{ zIndex }}
        {...props}
      >
        <div className="text-center max-w-md px-6">
          {showSpinner && (
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-6" />
          )}
          {title && (
            <h2 className="font-serif text-3xl font-light tracking-tight mb-4">{title}</h2>
          )}
          {/* Show preset-aware time estimate, or fallback to description prop */}
          <p className="text-muted-foreground mb-4">
            {preset === 'quick'
              ? 'This should take about a minute'
              : preset === 'full'
                ? 'This may take a few minutes'
                : description || 'This may take a few minutes'}
          </p>

          {/* Pages found/auditing info - only show when pages found is available */}
          {pagesFound != null && pagesFound > 0 && (
            <div className="mt-6 mb-8 mx-auto max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-700 ease-out">
              <div className="bg-muted/30 border border-border/50 rounded-lg px-6 py-4 space-y-2.5">
                <p className="text-sm text-foreground flex items-center justify-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                  <span>Found {pagesFound} {pagesFound === 1 ? 'page' : 'pages'} on your site</span>
                </p>
                {auditTier && (
                  <p className="text-sm text-muted-foreground text-center">
                    → Auditing up to {maxPagesAudited} {(maxPagesAudited as number) === 1 ? 'page' : 'pages'}{auditTier === 'free' ? ' (Free)' : ''}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Accumulating summaries list */}
          {shownSummaries.length > 0 && (
            <div className="mt-6 mb-6 min-h-[100px] flex flex-col items-start justify-center space-y-3 max-w-lg mx-auto transition-all duration-500 ease-out">
              {shownSummaries.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-3 text-base w-full animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out"
                  style={{
                    animationDelay: `${idx * 50}ms`,
                    animationFillMode: 'backwards'
                  }}
                >
                  {item.completed ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 transition-all duration-300" />
                  ) : (
                    <div className="h-4 w-4 shrink-0" />
                  )}
                  <span className={cn(
                    "transition-all duration-500 ease-out",
                    item.completed ? "text-muted-foreground/70" : "text-muted-foreground"
                  )}>
                    {item.message}
                  </span>
                </div>
              ))}
            </div>
          )}
          

          {children}
        </div>
      </div>
    )
  }
)
InterstitialLoader.displayName = "InterstitialLoader"

export { InterstitialLoader }

