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
  /**
   * Domain being audited, shown below the title
   */
  domain?: string
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
      domain,
      children,
      ...props
    },
    ref
  ) => {
    const [shownSummaries, setShownSummaries] = React.useState<{ message: string; completed: boolean }[]>([])
    // Show the status box after a short delay so it doesn't feel instant/jarring
    const [statusBoxVisible, setStatusBoxVisible] = React.useState(false)
    // Separate state for the count so we can animate the transition scanning → found
    const [countRevealed, setCountRevealed] = React.useState(false)

    // Calculate max pages audited based on tier
    const maxPagesAudited = auditTier === 'free' ? 5 : auditTier === 'pro' ? 20 : 60

    // Show status box ~1s after the interstitial opens; reset when it closes
    React.useEffect(() => {
      if (!open) {
        setStatusBoxVisible(false)
        setCountRevealed(false)
        return
      }
      const t = setTimeout(() => setStatusBoxVisible(true), 900)
      return () => clearTimeout(t)
    }, [open])

    // When pagesFound arrives (and box is visible), reveal the count in-place.
    // statusBoxVisible is included as a dep so that if pagesFound came in before
    // the box appeared, count still reveals once the box becomes visible.
    React.useEffect(() => {
      if (pagesFound != null && pagesFound > 0 && statusBoxVisible && !countRevealed) {
        const t = setTimeout(() => setCountRevealed(true), 300)
        return () => clearTimeout(t)
      }
    }, [pagesFound, statusBoxVisible, countRevealed])

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

    // Add summaries one by one after pages are found (or after 15s fallback)
    React.useEffect(() => {
      if (!open || cannedSummaries.length === 0) {
        setShownSummaries([])
        return
      }

      const hasPages = pagesFound != null && pagesFound > 0
      const timeouts: NodeJS.Timeout[] = []
      let startTimeout: NodeJS.Timeout | null = null

      const startSummaries = (initialDelaySecs: number) => {
        startTimeout = setTimeout(() => {
          if (!open) return
          setShownSummaries([{ message: cannedSummaries[0], completed: false }])
          for (let i = 1; i < cannedSummaries.length; i++) {
            const msg = cannedSummaries[i]
            const t = setTimeout(() => {
              setShownSummaries((prev) => {
                if (prev.length >= cannedSummaries.length) return prev
                const updated = prev.map((item, idx) =>
                  idx === prev.length - 1 ? { ...item, completed: true } : item
                )
                return [...updated, { message: msg, completed: false }]
              })
            }, i * 25000)
            timeouts.push(t)
          }
        }, initialDelaySecs * 1000)
      }

      if (hasPages) {
        // Pages found — start summaries 2s later
        startSummaries(2)
      } else {
        // Still scanning — start summaries after 15s regardless
        startSummaries(15)
      }

      return () => {
        if (startTimeout) clearTimeout(startTimeout)
        timeouts.forEach((t) => clearTimeout(t))
      }
    }, [open, pagesFound])

    if (!open) return null

    return (
      <div
        ref={ref}
        className={cn(
          "fixed inset-0 bg-background z-50 flex items-start justify-center pt-[28vh] animate-in fade-in duration-300",
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
            <h2 className="font-serif text-3xl font-light tracking-tight mb-1">{title}</h2>
          )}
          {domain && (
            <p className="text-muted-foreground font-medium mb-3">{domain}</p>
          )}
          {/* Status box: appears ~1s after open, transitions from scanning → found in-place */}
          {statusBoxVisible && (
            <div className="mt-6 mb-8 mx-auto max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out">
              <div className="bg-muted/30 border border-border/50 rounded-lg px-6 py-4 space-y-2.5">
                {!countRevealed ? (
                  // Scanning state
                  <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                    <span>Scanning pages...</span>
                  </p>
                ) : (
                  // Found state — fades in over the scanning state
                  <>
                    <p className="text-sm text-foreground flex items-center justify-center gap-2 animate-in fade-in duration-400">
                      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                      <span>Found {pagesFound} {pagesFound === 1 ? 'page' : 'pages'} on your site</span>
                    </p>
                    {auditTier && (
                      <p className="text-sm text-muted-foreground text-center animate-in fade-in duration-400" style={{ animationDelay: '150ms', animationFillMode: 'backwards' }}>
                        Auditing up to {maxPagesAudited} {maxPagesAudited === 1 ? 'page' : 'pages'}{auditTier === 'free' ? ' (Free)' : ''}
                      </p>
                    )}
                  </>
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

