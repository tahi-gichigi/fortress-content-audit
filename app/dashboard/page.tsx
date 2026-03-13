// fortress v1
"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase-browser"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowLeft, FileText, ExternalLink, RefreshCw, Loader2, TrendingUp, TrendingDown, Minus, CheckCircle2, Download, FileJson, FileType, Clock } from "lucide-react"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { useToast } from "@/hooks/use-toast"
import { PLAN_NAMES } from "@/lib/plans"
import { HealthScoreChart } from "@/components/health-score-chart"
import { HealthScoreCards } from "@/components/health-score-cards"
import { AuditTable } from "@/components/audit-table"
import { AuditProgress } from "@/components/audit-progress"
import { useAuditIssues } from "@/hooks/use-audit-issues"
import { useHealthScoreMetrics } from "@/hooks/use-health-score-metrics"
import { transformIssuesToTableRows } from "@/lib/audit-table-adapter"
import { NewAuditDialog } from "@/components/new-audit-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { AuditStartedModal } from "@/components/audit-started-modal"
import { AuditSuccessModal } from "@/components/audit-success-modal"
import { AuditFailureModal } from "@/components/audit-failure-modal"
import { DomainLimitReachedModal } from "@/components/domain-limit-reached-modal"
import { PageDiscoveryInline, PageDiscoveryList } from "@/components/PageDiscoveryInline"
import { PagesSummaryModal } from "@/components/pages-summary-modal"
import { classifyError } from "@/lib/error-classifier"
import type { ClassifiedError } from "@/lib/error-classifier"
import { useCheckDomainLimit } from "@/hooks/use-check-domain-limit"

interface AuditRun {
  id: string
  domain: string | null
  title: string | null
  brand_name: string | null
  pages_audited: number | null
  pages_found?: number | null
  issues_json: any
  created_at: string | null
  guideline_id: string | null
}

export default function DashboardPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [audits, setAudits] = useState<AuditRun[]>([])
  const [plan, setPlan] = useState<string>("free")
  const [error, setError] = useState<string | null>(null)
  const [healthScoreData, setHealthScoreData] = useState<any>(null)
  const [healthScoreLoading, setHealthScoreLoading] = useState(false)
  const [usageInfo, setUsageInfo] = useState<any>(null)
  const [domains, setDomains] = useState<string[]>([])
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null)
  const [deletingDomain, setDeletingDomain] = useState<string | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [domainToDelete, setDomainToDelete] = useState<string | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [exportLoading, setExportLoading] = useState<string | null>(null) // Track which format is loading
  const [startingAudit, setStartingAudit] = useState(false)
  const [pendingAuditId, setPendingAuditId] = useState<string | null>(null)
  const [auditProgress, setAuditProgress] = useState(0)
  const [severityFilter, setSeverityFilter] = useState<'all' | 'critical'>('all')
  const [newAuditDialogOpen, setNewAuditDialogOpen] = useState(false)
  // Domain to pre-fill when reopening the audit dialog from "Rerun audit"
  const [rerunDefaultDomain, setRerunDefaultDomain] = useState<string | undefined>(undefined)
  const [pageListExpanded, setPageListExpanded] = useState(false)

  // Modal states for audit notifications
  const [auditStartedModal, setAuditStartedModal] = useState<{
    open: boolean
    domain: string
    tier: 'free' | 'pro' | 'enterprise'
    estimatedDuration: string
    pagesFound?: number | null
    pagesAudited?: number
  }>({
    open: false,
    domain: '',
    tier: 'free',
    estimatedDuration: '2-4 minutes',
    pagesFound: null,
    pagesAudited: 0
  })

  const [auditSuccessModal, setAuditSuccessModal] = useState<{
    open: boolean
    domain: string
    totalIssues: number
    issueBreakdown: { critical: number; medium: number; low: number }
    milestones: any[]
    pagesFound?: number | null
    pagesAudited?: number
  }>({
    open: false,
    domain: '',
    totalIssues: 0,
    issueBreakdown: { critical: 0, medium: 0, low: 0 },
    milestones: [],
    pagesFound: null,
    pagesAudited: 0
  })

  const [auditFailureModal, setAuditFailureModal] = useState<{
    open: boolean
    domain: string
    error: ClassifiedError
  }>({
    open: false,
    domain: '',
    error: { type: 'api_error', message: '', details: '' }
  })

  const [domainLimitModalOpen, setDomainLimitModalOpen] = useState(false)
  const [pagesSummaryModalOpen, setPagesSummaryModalOpen] = useState(false)
  const { isAtLimit, plan: limitPlan, currentDomains, domainLimit, checkLimit } = useCheckDomainLimit()

  // Helper function to calculate issue breakdown by severity
  const calculateIssueBreakdown = (issues: any[]) => {
    const breakdown = { critical: 0, medium: 0, low: 0 }
    if (!issues || !Array.isArray(issues)) return breakdown

    issues.forEach((issue: any) => {
      const severity = issue.severity?.toLowerCase()
      if (severity === 'critical') breakdown.critical++
      else if (severity === 'medium') breakdown.medium++
      else if (severity === 'low') breakdown.low++
    })

    return breakdown
  }

  // Use shared hook to fetch issues from database
  const mostRecentAudit = audits.length > 0 ? audits[0] : null
  const { tableRows, loading: tableRowsLoading, totalIssues: tableTotalIssues, refetch } = useAuditIssues(
    mostRecentAudit?.id || null,
    authToken
  )

  // Display rows from database
  const displayTableRows = tableRows
  const displayTotalIssues = tableTotalIssues

  // Calculate metrics using shared hook
  const metrics = useHealthScoreMetrics(displayTableRows)

  // Paths (from page_url) that have at least one active issue — for pages summary modal
  const pagePathsWithIssues = useMemo(() => {
    const set = new Set<string>()
    displayTableRows
      .filter((row) => (row.status || "active") === "active" && row.page_url)
      .forEach((row) => {
        try {
          const path = new URL(row.page_url!).pathname.replace(/\/$/, "") || "/"
          set.add(path)
        } catch {
          /* skip invalid URL */
        }
      })
    return set
  }, [displayTableRows])

  // Merge chart data with current table metrics
  const chartDataWithCurrent = useMemo(() => {
    if (!healthScoreData?.data) {
      // If no historical data, just show current score
      if (mostRecentAudit?.created_at && metrics.score !== undefined) {
        const auditDate = new Date(mostRecentAudit.created_at).toISOString().split('T')[0]
        return [{
          date: auditDate,
          score: metrics.score,
          metrics: {
            totalActive: metrics.totalActive,
            totalCritical: metrics.totalCritical,
            criticalPages: metrics.criticalPages,
            pagesWithIssues: metrics.pagesWithIssues,
          }
        }]
      }
      return []
    }

    const historicalData = [...healthScoreData.data]
    
    // Add or update current score from table data
    if (mostRecentAudit?.created_at && metrics.score !== undefined) {
      const auditDate = new Date(mostRecentAudit.created_at).toISOString().split('T')[0]
      
      // Check if we already have data for this date
      const existingIndex = historicalData.findIndex(item => item.date === auditDate)
      
      if (existingIndex >= 0) {
        // Update existing entry with current table metrics
        historicalData[existingIndex] = {
          date: auditDate,
          score: metrics.score,
          metrics: {
            totalActive: metrics.totalActive,
            totalCritical: metrics.totalCritical,
            criticalPages: metrics.criticalPages,
            pagesWithIssues: metrics.pagesWithIssues,
          }
        }
      } else {
        // Add new entry for current audit
        historicalData.push({
          date: auditDate,
          score: metrics.score,
          metrics: {
            totalActive: metrics.totalActive,
            totalCritical: metrics.totalCritical,
            criticalPages: metrics.criticalPages,
            pagesWithIssues: metrics.pagesWithIssues,
          }
        })
      }
    }
    
    // Sort by date
    return historicalData.sort((a, b) => a.date.localeCompare(b.date))
  }, [healthScoreData?.data, mostRecentAudit?.created_at, metrics])

  useEffect(() => {
    checkAuthAndLoad()
  }, [])

  // Listen for domain changes from domain switcher
  useEffect(() => {
    const handleDomainChanged = () => {
      const newDomain = localStorage.getItem('selectedDomain')
      console.log('[Dashboard] Domain changed to:', newDomain)
      setSelectedDomain(newDomain)
    }
    
    // Listen for delete domain request
    const handleRequestDeleteDomain = (e: Event) => {
      const customEvent = e as CustomEvent<{ domain: string }>
      const domainToDelete = customEvent.detail?.domain
      if (domainToDelete) {
        console.log('[Dashboard] Delete domain requested:', domainToDelete)
        setDomainToDelete(domainToDelete)
        setShowDeleteDialog(true)
      }
    }
    
    window.addEventListener('domainChanged', handleDomainChanged)
    window.addEventListener('requestDeleteDomain', handleRequestDeleteDomain as EventListener)
    
    return () => {
      window.removeEventListener('domainChanged', handleDomainChanged)
      window.removeEventListener('requestDeleteDomain', handleRequestDeleteDomain as EventListener)
    }
  }, [])

  // Define load functions BEFORE useEffects that use them to avoid initialization order issues
  const loadAudits = useCallback(async (token: string, domain?: string | null, userId?: string) => {
    try {
      const supabase = createClient()
      // Avoid getSession() — can deadlock via navigator.locks on reload.
      // Use provided userId or fall back to getUser() (network call, no lock).
      let uid = userId
      if (!uid) {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        uid = user.id
      }

      // Use provided domain or fall back to selectedDomain state
      const domainToFilter = domain !== undefined ? domain : selectedDomain

      // Build query with domain filter if selected
      let query = supabase
        .from('brand_audit_runs')
        .select('*')
        .eq('user_id', uid)
      
      if (domainToFilter) {
        query = query.eq('domain', domainToFilter)
      }
      
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) throw error
      // Map database results to handle both old (pages_scanned) and new (pages_audited) column names
      const mappedAudits = (data || []).map((audit: any) => ({
        ...audit,
        pages_audited: audit.pages_audited ?? audit.pages_scanned ?? null,
      }))
      setAudits(mappedAudits)
      
      // Check for pending audits - check both issues_json.status and direct status field
      // Only set pendingAuditId if we find a pending audit
      // Don't clear it here - polling logic handles clearing when status is completed/failed
      const pendingAudit = mappedAudits.find((a: any) => {
        const status = a.status || a.issues_json?.status
        return status === 'pending'
      })
      if (pendingAudit) {
        setPendingAuditId(pendingAudit.id)
        console.log('[Dashboard] Found pending audit:', pendingAudit.id)
      }
      // Note: We don't clear pendingAuditId here - let polling logic handle it
      
      // Issues are now loaded via useAuditIssues hook when mostRecentAudit changes
    } catch (error) {
      console.error("Error loading audits:", error)
    }
  }, [selectedDomain])

  const loadHealthScore = useCallback(async (token: string, domain?: string | null) => {
    // Load health score for all authenticated users
    // Use provided domain or fall back to selectedDomain state
    const domainToUse = domain !== undefined ? domain : selectedDomain
    if (!domainToUse) {
      setHealthScoreData(null)
      return
    }
    
    setHealthScoreLoading(true)
    try {
      const response = await fetch(`/api/health-score?days=30&domain=${encodeURIComponent(domainToUse)}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      
      if (!response.ok) {
        // Don't show error - health score is optional
        console.warn('[Dashboard] Failed to load health score, response not ok')
        setHealthScoreData(null)
        return
      }
      
      const data = await response.json()
      setHealthScoreData(data)
    } catch (error) {
      console.warn("Error loading health score:", error)
      setHealthScoreData(null)
    } finally {
      setHealthScoreLoading(false)
    }
  }, [selectedDomain])

  const loadUsageInfo = useCallback(async (token: string, domain?: string | null) => {
    try {
      // Pass domain to get domain-specific usage
      const url = domain 
        ? `/api/audit/usage?domain=${encodeURIComponent(domain)}`
        : '/api/audit/usage'
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      
      if (response.ok) {
        const data = await response.json()
        setUsageInfo(data)
      }
    } catch (error) {
      console.error("Error loading usage info:", error)
    }
  }, [])

  // Track if this is the initial load to avoid double-loading
  const isInitialLoad = useRef(true)
  
  // Reload data when selected domain changes (but not on initial load)
  useEffect(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false
      return
    }
    
    if (selectedDomain && authToken) {
      console.log('[Dashboard] Reloading data for domain:', selectedDomain)
      const reloadData = async () => {
        // Use authToken from state — avoid getSession() deadlock
        await Promise.all([
          loadAudits(authToken, selectedDomain),
          loadHealthScore(authToken)
        ])
        // Also reload usage info for the new domain
        try {
          const url = `/api/audit/usage?domain=${encodeURIComponent(selectedDomain)}`
          const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${authToken}` }
          })
          if (response.ok) {
            const data = await response.json()
            setUsageInfo(data)
          }
        } catch (error) {
          console.error("Error loading usage info:", error)
        }
      }
      reloadData()
    }
  }, [selectedDomain, authToken])

  useEffect(() => {
    // Check for payment success query param
    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.get('payment') === 'success') {
      toast({
        title: "Payment successful!",
        description: "Your subscription is now active.",
      })
      // Dispatch event to refresh plan data in components
      window.dispatchEvent(new Event('paymentSuccess'))
      // Reload page to refresh plan data in all components
      setTimeout(() => {
        window.location.href = '/dashboard'
      }, 500) // Small delay to allow event to propagate
    }
  }, [router, toast])

  // Animate progress bar when audit is pending (tier-aware timing)
  // Uses asymptotic curve - keeps moving but slows down, never quite reaches 99%
  useEffect(() => {
    if (!pendingAuditId) {
      setAuditProgress(0)
      return
    }

    const startTime = Date.now()
    // Half-life: time to reach ~50% progress (Free: 20s, Pro: 45s)
    const halfLife = plan === 'free' ? 20000 : 45000

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      // Asymptotic formula: approaches 98% but never stops moving
      // progress = 98 * elapsed / (elapsed + halfLife)
      const progress = 98 * elapsed / (elapsed + halfLife)
      setAuditProgress(Math.round(progress))
    }, 150)

    return () => clearInterval(interval)
  }, [pendingAuditId, plan])

  // Poll for pending audit detected on page load
  useEffect(() => {
    if (!pendingAuditId || !authToken) return

    const pollPendingAudit = async () => {
      const maxAttempts = 180 // ~12 minutes max (4s intervals) - supports longer audits
      let attempts = 0

      const poll = async () => {
        try {
          const pollResponse = await fetch(`/api/audit/${pendingAuditId}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
          })

          if (!pollResponse.ok) {
            attempts++
            if (attempts < maxAttempts) {
              setTimeout(poll, 4000)
            } else {
              console.log('[Dashboard] Poll timeout for pending audit, clearing')
              setPendingAuditId(null)
            }
            return
          }

          const pollData = await pollResponse.json()
          console.log('[Dashboard] Poll status:', pollData.status)

          if (pollData.status === 'completed') {
            setAuditProgress(100) // Complete the progress bar
            setPendingAuditId(null)

            // Show success modal with issue breakdown
            const issues = pollData.issues || []
            const totalIssues = Array.isArray(issues) ? issues.length : 0
            const issueBreakdown = calculateIssueBreakdown(issues)
            const milestones = pollData.milestones || []

            setAuditSuccessModal({
              open: true,
              domain: selectedDomain || '',
              totalIssues,
              issueBreakdown,
              milestones,
              pagesFound: pollData.meta?.pagesFound || null,
              pagesAudited: pollData.meta?.pagesAudited || 0
            })

            // Reload all data using authToken from state
            if (authToken) {
              await Promise.all([
                loadAudits(authToken, selectedDomain),
                loadHealthScore(authToken)
              ])
              await loadUsageInfo(authToken, selectedDomain)
            }
            return
          }

          if (pollData.status === 'failed') {
            console.log('[Dashboard] Audit failed, showing error modal:', pollData.error)
            setPendingAuditId(null)

            // Show failure modal with classified error
            const errorMessage = pollData.error || "The audit encountered an error. Please try again."
            const classifiedError = classifyError(errorMessage, {
              pagesAudited: pollData.pagesAudited
            })

            // Close audit started modal before showing failure
            setAuditStartedModal(prev => ({ ...prev, open: false }))
            setAuditFailureModal({
              open: true,
              domain: selectedDomain || '',
              error: classifiedError
            })
            return
          }

          // Still pending - continue polling
          attempts++
          if (attempts < maxAttempts) {
            setTimeout(poll, 4000)
          } else {
            console.log('[Dashboard] Poll timeout for pending audit, clearing')
            setPendingAuditId(null)
          }
        } catch (pollError) {
          console.error('[Dashboard] Poll error for pending audit:', pollError)
          attempts++
          if (attempts < maxAttempts) {
            setTimeout(poll, 4000)
          } else {
            setPendingAuditId(null)
          }
        }
      }

      // Start polling after initial delay
      setTimeout(poll, 4000)
    }

    pollPendingAudit()
  }, [pendingAuditId, authToken, selectedDomain, loadAudits, loadHealthScore, loadUsageInfo, toast])

  // Claim pending audit from localStorage (set during unauthenticated audit + email signup)
  const claimPendingAudit = async (token: string): Promise<{ claimed: boolean; domain?: string }> => {
    try {
      // Check for direct sessionToken first (as per roadmap)
      let sessionToken: string | null = localStorage.getItem('audit_session_token')
      
      // Fallback to pendingAudit for backward compatibility
      if (!sessionToken) {
        const pendingAuditStr = localStorage.getItem('pendingAudit')
        if (pendingAuditStr) {
          try {
            const pendingAudit = JSON.parse(pendingAuditStr)
            // Check if expired (24 hours)
            if (pendingAudit.expiry && Date.now() > pendingAudit.expiry) {
              console.log('[Dashboard] Pending audit expired, clearing')
              localStorage.removeItem('pendingAudit')
              return { claimed: false }
            }
            sessionToken = pendingAudit.sessionToken
          } catch (e) {
            console.log('[Dashboard] Failed to parse pendingAudit, clearing')
            localStorage.removeItem('pendingAudit')
            return { claimed: false }
          }
        }
      }

      if (!sessionToken) {
        return { claimed: false }
      }

      console.log('[Dashboard] Claiming pending audit with session token:', sessionToken)

      const response = await fetch('/api/audit/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ sessionToken })
      })

      if (response.ok) {
        const result = await response.json()
        console.log('[Dashboard] Audit claimed successfully:', result)
        toast({
          title: "Audit saved!",
          description: `Your audit for ${result.domain || 'your site'} has been saved to your account.`
        })
        // Clear storage and return success with domain
        localStorage.removeItem('audit_session_token')
        localStorage.removeItem('pendingAudit')
        return { claimed: true, domain: result.domain }
      } else {
        const error = await response.json().catch(() => ({}))
        console.log('[Dashboard] Failed to claim audit:', error)
        // Don't show error to user - audit may have already been claimed or doesn't exist
      }

      // Clear both storage methods after attempt
      localStorage.removeItem('audit_session_token')
      localStorage.removeItem('pendingAudit')
      return { claimed: false }
    } catch (error) {
      console.error('[Dashboard] Error claiming pending audit:', error)
      localStorage.removeItem('audit_session_token')
      localStorage.removeItem('pendingAudit')
      return { claimed: false }
    }
  }

  // Polling removed - all audits now complete synchronously

  const checkAuthAndLoad = async () => {
    try {
      const supabase = createClient()

      // getSession() reads from cookies — no network round-trip.
      // Middleware already validates the session on every request.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push(`/sign-up?next=${encodeURIComponent('/dashboard')}`)
        return
      }

      const user = session.user
      setAuthToken(session.access_token)

      // Check for pending audit to claim (from localStorage)
      const claimResult = await claimPendingAudit(session.access_token)

      // Parallelize profile, domains loading, and domain data fetch
      const [{ data: profile }, _, { data: domainData }] = await Promise.all([
        supabase
          .from('profiles')
          .select('plan')
          .eq('user_id', user.id)
          .maybeSingle(),
        loadDomains(session.access_token, user.id),
        supabase
          .from('brand_audit_runs')
          .select('domain')
          .eq('user_id', user.id)
          .not('domain', 'is', null)
      ])
      if (profile) {
        setPlan(profile.plan || 'free')
      }

      const availableDomains = Array.from(new Set(
        (domainData || []).map(a => a.domain).filter((d): d is string => d !== null)
      ))

      // If we just claimed an audit, use that domain; otherwise use saved or first available
      let initialDomain: string | null = null
      if (claimResult.claimed && claimResult.domain) {
        initialDomain = claimResult.domain
      } else {
        const savedDomain = localStorage.getItem('selectedDomain')
        const isValidDomain = savedDomain && availableDomains.includes(savedDomain)
        initialDomain = isValidDomain ? savedDomain : (availableDomains[0] || null)
      }

      if (initialDomain) {
        setSelectedDomain(initialDomain)
        localStorage.setItem('selectedDomain', initialDomain)
      }

      // Unblock the UI immediately — data loads in background
      setLoading(false)

      // Load all data in background (non-blocking)
      loadAudits(session.access_token, initialDomain, user.id)
      loadHealthScore(session.access_token, initialDomain)
      loadUsageInfo(session.access_token, initialDomain)

      // Issues are now loaded via useAuditIssues hook
    } catch (error) {
      console.error("Error loading dashboard:", error)
      setError("Failed to load dashboard. Please refresh the page.")
      setLoading(false)
    }
  }

  // Open the new-audit dialog pre-filled with the domain so the user can choose audit settings
  const handleRerunAudit = (_auditId: string, domain: string) => {
    setRerunDefaultDomain(domain)
    setNewAuditDialogOpen(true)
  }

  const handleStartAudit = async () => {
    if (!selectedDomain || !authToken) {
      toast({
        title: "No domain selected",
        description: "Please select a domain to audit.",
      })
      return
    }

    // TEMPORARILY DISABLED: Daily limit check for testing
    // Check if daily limit reached
    // if (usageInfo && usageInfo.limit > 0 && usageInfo.today >= usageInfo.limit) {
    //   toast({
    //     title: "Daily limit reached",
    //     description: `You've reached your daily limit of ${usageInfo.limit} audit${usageInfo.limit === 1 ? '' : 's'}. Try again tomorrow${plan === 'free' ? ' or upgrade to Pro for 5 domains' : ''}.`,
    //   })
    //   return
    // }

    // Set loading state immediately for user feedback
    setStartingAudit(true)

    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ domain: selectedDomain })
      })

      // If response.ok, validation passed and audit started
      if (response.ok) {
        const data = await response.json()
        
        // Show modal now that we know audit started successfully
        const estimatedDuration = plan === 'pro' || plan === 'enterprise'
          ? '4-7 minutes'
          : '2-4 minutes'
        setAuditStartedModal({
          open: true,
          domain: selectedDomain,
          tier: plan as 'free' | 'pro' | 'enterprise',
          estimatedDuration
        })
        
        if (data.status === 'pending') {
          // Set pending audit ID to show banner
          setPendingAuditId(data.runId)

          // Scroll to top to show the pending audit banner
          window.scrollTo({ top: 0, behavior: 'smooth' })

          // Poll for completion - longer timeout for paid audits
          const pollIntervalMs = 5000 // 5 seconds
          const maxPollMinutes = plan === 'pro' || plan === 'enterprise' ? 15 : 12 // 12min for free tier, 15min for paid
          const maxAttempts = Math.ceil((maxPollMinutes * 60 * 1000) / pollIntervalMs)
          let attempts = 0
          
          const poll = async () => {
            try {
              const pollResponse = await fetch(`/api/audit/${data.runId}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
              })
              
              if (!pollResponse.ok) {
                attempts++
                if (attempts < maxAttempts) {
                  setTimeout(poll, pollIntervalMs)
                } else {
                  // Timeout - show error modal and reload data
                  setPendingAuditId(null)
                  setStartingAudit(false)

                  const timeoutError = classifyError("The audit timed out after exceeding the time limit.")
                  // Close audit started modal before showing failure
                  setAuditStartedModal(prev => ({ ...prev, open: false }))
                  setAuditFailureModal({
                    open: true,
                    domain: selectedDomain || '',
                    error: timeoutError
                  })
                  const supabase = createClient()
                  const { data: { session } } = await supabase.auth.getSession()
                  if (session) {
                    await loadAudits(session.access_token, selectedDomain)
                  }
                }
                return
              }
              
              const pollData = await pollResponse.json()
              
              if (pollData.status === 'completed') {
                setAuditProgress(100) // Complete the progress bar
                setPendingAuditId(null)
                setStartingAudit(false)

                // Show success modal with issue breakdown
                const issues = pollData.issues || []
                const totalIssues = Array.isArray(issues) ? issues.length : 0
                const issueBreakdown = calculateIssueBreakdown(issues)
                const milestones = pollData.milestones || []

                // Close audit started modal before showing success
                setAuditStartedModal(prev => ({ ...prev, open: false }))
                setAuditSuccessModal({
                  open: true,
                  domain: selectedDomain || '',
                  totalIssues,
                  issueBreakdown,
                  milestones
                })

                const supabase = createClient()
                const { data: { session } } = await supabase.auth.getSession()
                if (session) {
                  await Promise.all([
                    loadAudits(session.access_token, selectedDomain),
                    loadHealthScore(session.access_token)
                  ])
                  await loadUsageInfo(session.access_token, selectedDomain)
                }
                return
              }
              
              if (pollData.status === 'failed') {
                setPendingAuditId(null)
                setStartingAudit(false)

                // Show failure modal with classified error
                const errorMessage = pollData.error || "The audit encountered an error. Please try again."
                const classifiedError = classifyError(errorMessage, {
                  pagesAudited: pollData.pagesAudited
                })

                // Close audit started modal before showing failure
                setAuditStartedModal(prev => ({ ...prev, open: false }))
                setAuditFailureModal({
                  open: true,
                  domain: selectedDomain || '',
                  error: classifiedError
                })
                return
              }
              
              // Still pending - update audit started modal with progress if available
              if (pollData.meta?.pagesFound) {
                setAuditStartedModal(prev => ({
                  ...prev,
                  pagesFound: pollData.meta.pagesFound,
                  pagesAudited: pollData.meta.pagesAudited || 0
                }))
              }

              // Continue polling
              attempts++
              if (attempts < maxAttempts) {
                setTimeout(poll, pollIntervalMs)
              } else {
                // Timeout - reload data and show modal
                console.log('[Dashboard] Poll timeout after', maxPollMinutes, 'minutes')
                setPendingAuditId(null)
                setStartingAudit(false)

                const timeoutError = classifyError("The audit timed out after exceeding the time limit.")
                // Close audit started modal before showing failure
                setAuditStartedModal(prev => ({ ...prev, open: false }))
                setAuditFailureModal({
                  open: true,
                  domain: selectedDomain || '',
                  error: timeoutError
                })
                const supabase = createClient()
                const { data: { session } } = await supabase.auth.getSession()
                if (session) {
                  await loadAudits(session.access_token, selectedDomain)
                }
              }
            } catch (pollError) {
              console.error('[Dashboard] Poll error:', pollError)
              attempts++
              if (attempts < maxAttempts) {
                setTimeout(poll, pollIntervalMs)
              } else {
                setPendingAuditId(null)
                setStartingAudit(false)

                const connectionError = classifyError("Lost connection while waiting for audit.")
                // Close audit started modal before showing failure
                setAuditStartedModal(prev => ({ ...prev, open: false }))
                setAuditFailureModal({
                  open: true,
                  domain: selectedDomain || '',
                  error: connectionError
                })
              }
            }
          }
          
          // Start polling after initial delay
          setTimeout(poll, pollIntervalMs)
        } else if (data.status === 'failed') {
          setPendingAuditId(null)
          setStartingAudit(false)

          const errorMessage = data.error || "The audit encountered an error. Please try again."
          const classifiedError = classifyError(errorMessage)
          // Close audit started modal before showing failure
          setAuditStartedModal(prev => ({ ...prev, open: false }))
          setAuditFailureModal({
            open: true,
            domain: selectedDomain || '',
            error: classifiedError
          })
        } else {
          // Unknown status - treat as error
          setPendingAuditId(null)
          setStartingAudit(false)

          const unknownError = classifyError(`Unexpected status: ${data.status || 'unknown'}`)
          // Close audit started modal before showing failure
          setAuditStartedModal(prev => ({ ...prev, open: false }))
          setAuditFailureModal({
            open: true,
            domain: selectedDomain || '',
            error: unknownError
          })
        }
        return
      } else {
        // Validation errors - show error modal
        setStartingAudit(false)
        let errorMessage = 'Failed to start audit'
        let errorData: any = {}
        try {
          errorData = await response.json()
          errorMessage = errorData.message || errorData.error || errorMessage
        } catch {
          errorMessage = response.statusText || errorMessage
        }

        const classifiedError = classifyError(errorMessage)
        // Close audit started modal before showing failure
        setAuditStartedModal(prev => ({ ...prev, open: false }))
        setAuditFailureModal({
          open: true,
          domain: selectedDomain || '',
          error: classifiedError
        })
      }
    } catch (error) {
      console.error("Error starting audit:", error)
      
      // Clear starting state on error
      setStartingAudit(false)

      // Extract user-friendly error message
      let errorMessage = "Failed to start audit. Please try again."
      if (error instanceof Error) {
        errorMessage = error.message
        // Check for bot protection first
        if (error.message.toLowerCase().includes("bot protection")) {
          errorMessage = error.message
        } else if (error.message.includes("Audit generation failed") || error.message.includes("generation failed")) {
          errorMessage = "The audit could not be started. This might be due to a temporary service issue. Please try again in a moment."
        } else if (error.message.includes("rate limit") || error.message.includes("429") || error.message.includes("Daily limit")) {
          // Keep the original message for rate limits as it's already user-friendly
          errorMessage = error.message
        } else if (error.message.includes("network") || error.message.includes("fetch") || error.message.includes("Network")) {
          errorMessage = "Network error. Please check your connection and try again."
        } else if (error.message.includes("Unauthorized") || error.message.includes("401")) {
          errorMessage = "Your session has expired. Please sign in again."
        } else if (error.message.includes("Forbidden") || error.message.includes("403")) {
          errorMessage = "You don't have permission to perform this action."
        }
      }

      const classifiedError = classifyError(errorMessage || "Please try again in a moment.")
      // Close audit started modal before showing failure
      setAuditStartedModal(prev => ({ ...prev, open: false }))
      setAuditFailureModal({
        open: true,
        domain: selectedDomain || '',
        error: classifiedError
      })
    }
    // Note: No finally block - we intentionally keep startingAudit=true for successful audits
    // until window.location.reload() completes. All error paths above already clear the state.
  }

  const loadDomains = async (token: string, userId?: string) => {
    try {
      const supabase = createClient()
      // Avoid calling getSession() — it can deadlock due to navigator.locks contention.
      // The supabase singleton is already authenticated via cookies; we just need the user ID.
      let uid = userId
      if (!uid) {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        uid = user.id
      }

      const { data: audits } = await supabase
        .from('brand_audit_runs')
        .select('domain')
        .eq('user_id', uid)
        .not('domain', 'is', null)

      if (audits) {
        const uniqueDomains = Array.from(new Set(
          audits.map(a => a.domain).filter((d): d is string => d !== null)
        ))
        setDomains(uniqueDomains)
      }
    } catch (error) {
      console.error("Error loading domains:", error)
    }
  }

  const handleDeleteDomain = async () => {
    if (!domainToDelete) return

    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      // Set loading state after validation checks
      setDeletingDomain(domainToDelete)

      const encodedDomain = encodeURIComponent(domainToDelete)
      const response = await fetch(`/api/domains/${encodedDomain}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`
        }
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete domain')
      }

      // Store domain to delete for background operations before clearing state
      const deletedDomain = domainToDelete
      
      // Close dialog and clear states immediately (synchronous) so UI is responsive
      // Use React's automatic batching - all state updates in same function are batched
      setShowDeleteDialog(false)
      setDeletingDomain(null)
      setDomainToDelete(null)

      // Show toast immediately
      toast({
        title: "Domain deleted",
        description: "All audits and data for this domain have been removed.",
      })

      // Clear localStorage and refresh page
      if (selectedDomain === deletedDomain) {
        localStorage.removeItem('selectedDomain')
      }
      
      // Notify domain switcher to reload immediately
      window.dispatchEvent(new Event('domainsReload'))
      
      // Force full page reload after a short delay to ensure clean state
      // This is the most reliable way to reset all state after deletion
      setTimeout(() => {
        window.location.reload()
      }, 100)
    } catch (error) {
      toast({
        title: "Unable to delete domain",
        description: error instanceof Error ? error.message : "Please try again or contact support if the issue persists.",
        variant: "error",
      })
      // On error, still close dialog and clear states
      setDeletingDomain(null)
      setShowDeleteDialog(false)
      setDomainToDelete(null)
    }
  }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "Never"
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const handleExport = async (format: 'pdf' | 'json' | 'md') => {
    if (!mostRecentAudit?.id) {
      toast({
        title: "No audit available",
        description: "Please run an audit first before exporting.",
        variant: "error",
      })
      return
    }

    setExportLoading(format)

    try {
      // Get fresh session to avoid expired token issues
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        toast({
          title: "Session expired",
          description: "Please sign in again to export.",
          variant: "error",
        })
        return
      }

      const response = await fetch(`/api/audit/${mostRecentAudit.id}/export?format=${format}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`
        }
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))


        throw new Error(errorData.error || `Failed to export as ${format.toUpperCase()}`)
      }

      // Get filename from Content-Disposition header or generate one
      const contentDisposition = response.headers.get('Content-Disposition')
      let filename = `${mostRecentAudit.domain || 'audit'}-audit.${format}`
      if (contentDisposition) {
        // Handle both quoted and unquoted filenames
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i)
        if (filenameMatch && filenameMatch[1]) {
          // Remove quotes if present
          filename = filenameMatch[1].replace(/^["']|["']$/g, '')
        }
      }

      // Sanitize filename - remove any invalid characters
      filename = filename.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-')

      // Check if this is a client-side PDF conversion
      const pdfConversionHeader = response.headers.get('X-PDF-Conversion')
      const isClientSidePDF = format === 'pdf' && pdfConversionHeader === 'client-side'

      console.log('[Dashboard] Export response:', {
        format,
        contentType: response.headers.get('Content-Type'),
        pdfConversionHeader,
        isClientSidePDF,
      })

      if (isClientSidePDF) {
        // Handle client-side PDF generation
        const html = await response.text()

        console.log('[Dashboard] Received HTML for PDF conversion:', {
          htmlLength: html.length,
          htmlPreview: html.substring(0, 200),
        })

        // Generate proper PDF filename
        const domain = mostRecentAudit.domain || 'audit'
        const sanitizedDomain = domain.replace(/[^a-z0-9]/gi, '-').toLowerCase()
        const date = new Date(mostRecentAudit.created_at || Date.now()).toISOString().split('T')[0]
        const pdfFilename = `${sanitizedDomain}-audit-${date}.pdf`

        console.log('[Dashboard] Calling generateAuditPDFClient...')

        // Dynamic import for code splitting
        const { generateAuditPDFClient } = await import('@/lib/audit-pdf-client')
        await generateAuditPDFClient(html, pdfFilename)

        console.log('[Dashboard] PDF generation complete')
      } else {
        // Handle JSON and Markdown formats - traditional blob download
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      }

      toast({
        title: "Export successful",
        description: `Audit exported as ${format.toUpperCase()}`,
      })
    } catch (error) {
      console.error('[Dashboard] Export error:', error)
      toast({
        title: "Unable to export audit",
        description: error instanceof Error ? error.message : "Please try again or contact support if the issue persists.",
        variant: "error",
      })
    } finally {
      setExportLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="@container/main flex flex-1 flex-col gap-2">
          <div className="px-4 lg:px-6 pt-4">
            <Skeleton className="h-10 w-48 mb-4" />
          </div>
          <div className="px-4 lg:px-6 space-y-8">
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-10 w-32" />
              </div>
              
              <div className="grid gap-4">
                {[1, 2, 3].map((i) => (
                  <Card key={i} className="border border-border">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 space-y-3">
                          <Skeleton className="h-8 w-64" />
                          <div className="flex items-center gap-4">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-4 w-28" />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Skeleton className="h-9 w-24" />
                          <Skeleton className="h-9 w-9" />
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // tableRows are now loaded via useAuditIssues hook
  const previousScore = healthScoreData?.data && healthScoreData.data.length > 1 
    ? healthScoreData.data[healthScoreData.data.length - 2]?.score 
    : undefined

  return (
    <>
    <div className="@container/main flex flex-1 flex-col gap-2">
            {/* Error Alert */}
            {error && (
              <div className="px-4 lg:px-6 pt-4">
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            )}

            {/* Pending Audit Banner with Progress Bar */}
            {pendingAuditId && (
              <div className="px-4 lg:px-6 pt-4">
                <Alert className="border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-800">
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
                  <AlertTitle className="text-blue-900 dark:text-blue-100">Audit in progress</AlertTitle>
                  <AlertDescription className="text-blue-800 dark:text-blue-200 space-y-2">
                    <Progress value={auditProgress} className="h-1.5 mt-2" />
                    <p className="text-xs">
                      {auditProgress < 85 ? 'Analyzing your content...' : 'Finalizing results...'}
                    </p>
                  </AlertDescription>
                </Alert>
              </div>
            )}

            <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
                {/* Free vs Pro comparison banner */}
                {plan === 'free' && !loading && (
                  <div className="px-4 lg:px-6">
                    <div className="bg-muted/50 rounded-lg p-3 flex items-center justify-between text-sm">
                      <div>
                        <span className="font-medium">Free: Up to 5 pages</span>
                        <span className="text-muted-foreground ml-2">
                          Upgrade to Pro for 20 pages + weekly auto-audits
                        </span>
                      </div>
                      <Button variant="ghost" size="sm" asChild>
                        <Link href="/pricing">Compare plans →</Link>
                      </Button>
                    </div>
                  </div>
                )}

                {/* Header row: domain + pages summary (flush) | action buttons */}
                <div className="flex items-start justify-between gap-4 px-4 lg:px-6">
                  <div className="flex flex-col gap-0 min-w-0">
                    <h2 className="font-serif text-2xl font-semibold truncate">
                      {selectedDomain || 'Content Audits'}
                    </h2>
                    {mostRecentAudit &&
                      !pendingAuditId &&
                      (mostRecentAudit.pages_found != null && mostRecentAudit.pages_found > 0 ||
                        (mostRecentAudit.issues_json?.discoveredPages?.length ?? 0) > 0) && (
                      <PageDiscoveryInline
                        discoveredPages={mostRecentAudit.issues_json?.discoveredPages || []}
                        auditedUrls={mostRecentAudit.issues_json?.auditedUrls || []}
                        pagesFound={mostRecentAudit.pages_found ?? mostRecentAudit.issues_json?.pagesFound ?? null}
                        isAuthenticated={true}
                        plan={plan as 'free' | 'pro' | 'enterprise'}
                        fullWidthExpanded
                        expanded={pageListExpanded}
                        onExpandChange={setPageListExpanded}
                      />
                    )}
                  </div>

                  {/* Export, Rerun audit - beside domain */}
                  <div className="flex items-center gap-3 sm:gap-4 shrink-0">
                    {mostRecentAudit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            disabled={exportLoading !== null}
                            size="sm"
                            className="sm:size-default"
                          >
                            {exportLoading ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Exporting...
                              </>
                            ) : (
                              <>
                                <Download className="mr-2 h-4 w-4" />
                                Export
                              </>
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleExport('pdf')}
                            disabled={exportLoading !== null}
                          >
                            <FileText className="mr-2 h-4 w-4" />
                            PDF
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleExport('json')}
                            disabled={exportLoading !== null}
                          >
                            <FileJson className="mr-2 h-4 w-4" />
                            JSON
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleExport('md')}
                            disabled={exportLoading !== null}
                          >
                            <FileType className="mr-2 h-4 w-4" />
                            Markdown
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    <Button
                      onClick={() => {
                        // Open audit dialog pre-filled with current domain so user can pick settings
                        if (selectedDomain) {
                          setRerunDefaultDomain(selectedDomain)
                          setNewAuditDialogOpen(true)
                        }
                      }}
                      variant="default"
                      size="sm"
                      className="sm:size-default"
                    >
                      Rerun audit
                    </Button>
                  </div>
                </div>

                {/* URL list: full-width row when expanded */}
                {pageListExpanded &&
                  mostRecentAudit &&
                  !pendingAuditId &&
                  (mostRecentAudit.issues_json?.discoveredPages?.length ?? 0) > 0 && (
                  <div className="w-full px-4 lg:px-6">
                    <PageDiscoveryList
                      discoveredPages={mostRecentAudit.issues_json?.discoveredPages || []}
                      auditedUrls={mostRecentAudit.issues_json?.auditedUrls || []}
                    />
                  </div>
                )}

                {/* Workflow Progress - Only show for new users */}
                {(() => {
                  const isNewUser = audits.length <= 5
                  const resolvedCount = displayTableRows.filter(row => row.status === 'resolved').length
                  const totalIssues = displayTableRows.length
                  const allResolved = totalIssues > 0 && resolvedCount === totalIssues
                  
                  // Determine current step
                  let currentStep: 'review' | 'fix' | 'reaudit' = 'review'
                  if (allResolved) {
                    currentStep = 'reaudit'
                  } else if (resolvedCount > 0) {
                    currentStep = 'fix'
                  }
                  
                  const shouldShow = isNewUser && 
                                     !loading && 
                                     !tableRowsLoading && 
                                     !pendingAuditId && 
                                     totalIssues > 0
                  
                  return shouldShow ? (
                    <AuditProgress currentStep={currentStep} />
                  ) : null
                })()}

                {/* Health Score Section - Available to all authenticated users */}
                <HealthScoreCards
                  loading={tableRowsLoading || healthScoreLoading || !!pendingAuditId}
                  currentScore={metrics.score !== undefined ? {
                    score: metrics.score,
                    metrics: {
                      totalActive: metrics.totalActive,
                      totalCritical: metrics.totalCritical,
                      pagesWithIssues: metrics.pagesWithIssues,
                      criticalPages: metrics.criticalPages,
                    }
                  } : healthScoreData?.currentScore}
                  pagesAudited={mostRecentAudit?.pages_audited ?? null}
                  previousScore={previousScore}
                  onFilterChange={(filter) => {
                    setSeverityFilter(filter === null ? 'all' : filter)
                    requestAnimationFrame(() => {
                      document.querySelector('[data-issues-section]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    })
                  }}
                  activeFilter={severityFilter === 'all' ? null : severityFilter}
                  onPagesWithIssuesClick={
                    mostRecentAudit &&
                    (mostRecentAudit.issues_json?.discoveredPages?.length > 0 ||
                      (mostRecentAudit.pages_found != null && mostRecentAudit.pages_found > 0))
                      ? () => setPagesSummaryModalOpen(true)
                      : undefined
                  }
                />

                {/* Health Score Chart - Show if we have data (historical or current) */}
                {(chartDataWithCurrent.length > 0 || healthScoreData) && (
                  <div className="px-4 lg:px-6">
                    <HealthScoreChart 
                      data={chartDataWithCurrent.length > 0 ? chartDataWithCurrent : (healthScoreData?.data || [])} 
                      domain={healthScoreData?.domain || selectedDomain || undefined}
                    />
                  </div>
                )}

                {/* Audit Issues Table - Show most recent audit's issues */}
                {audits.length === 0 ? (
                  <div className="px-4 lg:px-6">
                    <Card className="border-2 border-dashed border-border">
                      <CardContent className="pt-6">
                        <div className="text-center py-12 px-4">
                          <FileText className="h-12 w-12 sm:h-16 sm:w-16 text-muted-foreground mx-auto mb-4" />
                          <h3 className="font-serif text-2xl sm:text-3xl font-semibold mb-3">
                            Welcome! Get started with your first audit
                          </h3>
                          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed mb-2 max-w-xl mx-auto">
                            Run a content audit to discover issues across your website. We'll scan your pages and identify typos, grammar errors, inconsistencies, and more.
                          </p>
                          <p className="text-sm text-muted-foreground mb-6">
                            Your audit results will appear here once complete.
                          </p>
                          <Button
                            size="lg"
                            className="font-semibold"
                            onClick={() => setNewAuditDialogOpen(true)}
                          >
                            Run Your First Audit
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                ) : (
                  <div className="px-4 lg:px-6" data-issues-section data-audit-results>
                    <AuditTable
                      data={displayTableRows}
                      auditId={mostRecentAudit?.id}
                      totalIssues={displayTotalIssues}
                      onStatusUpdate={refetch}
                      initialSeverityFilter={severityFilter}
                    />
                  </div>
                )}
            </div>
          </div>

      {/* Domain Deletion Confirmation Dialog */}
      <AlertDialog 
        open={showDeleteDialog} 
        onOpenChange={(open) => {
          if (!open) {
            // Allow closing - clear states
            setShowDeleteDialog(false)
            setDomainToDelete(null)
            setDeletingDomain(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Domain</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete all audits and data for <strong>{domainToDelete}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteDomain}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletingDomain !== null}
            >
              {deletingDomain ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New Audit Dialog - also used for rerun flow (pre-filled domain, skips to step 2) */}
      <NewAuditDialog
        open={newAuditDialogOpen}
        onOpenChange={(open) => {
          setNewAuditDialogOpen(open)
          // Clear rerun domain when dialog closes so next open is a fresh new-domain flow
          if (!open) setRerunDefaultDomain(undefined)
        }}
        defaultDomain={rerunDefaultDomain}
        onSuccess={async (newDomain: string) => {
          // Normalize domain
          const normalizedDomain = newDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')

          // Select the new domain and reload data
          setSelectedDomain(normalizedDomain)
          localStorage.setItem('selectedDomain', normalizedDomain)
          window.dispatchEvent(new Event('domainChanged'))

          // Reload audits for new domain (will detect pending audit and set pendingAuditId)
          if (authToken) {
            await loadAudits(authToken, normalizedDomain)
            await loadHealthScore(authToken, normalizedDomain)
            await loadUsageInfo(authToken, normalizedDomain)
          }

          // Scroll to top to show the pending audit banner
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />

      {/* Audit Started Modal */}
      <AuditStartedModal
        open={auditStartedModal.open}
        onOpenChange={(open) => setAuditStartedModal(prev => ({ ...prev, open }))}
        domain={auditStartedModal.domain}
        tier={auditStartedModal.tier}
        estimatedDuration={auditStartedModal.estimatedDuration}
        pagesFound={auditStartedModal.pagesFound}
        pagesAudited={auditStartedModal.pagesAudited}
      />

      {/* Audit Success Modal */}
      <AuditSuccessModal
        open={auditSuccessModal.open}
        onOpenChange={(open) => setAuditSuccessModal(prev => ({ ...prev, open }))}
        domain={auditSuccessModal.domain}
        totalIssues={auditSuccessModal.totalIssues}
        issueBreakdown={auditSuccessModal.issueBreakdown}
        milestones={auditSuccessModal.milestones}
        pagesFound={auditSuccessModal.pagesFound}
        pagesAudited={auditSuccessModal.pagesAudited}
        onViewResults={() => {
          // Refresh page to show updated audit results
          window.location.reload()
        }}
        onExport={() => {
          // Trigger PDF export
          handleExport('pdf')
        }}
      />

      {/* Audit Failure Modal */}
      <AuditFailureModal
        open={auditFailureModal.open}
        onOpenChange={(open) => setAuditFailureModal(prev => ({ ...prev, open }))}
        domain={auditFailureModal.domain}
        error={auditFailureModal.error}
        userTier={plan as 'free' | 'pro' | 'enterprise'}
        onRetry={() => {
          // Retry the audit
          handleStartAudit()
        }}
        onContactSupport={() => {
          // Open support email
          window.location.href = `mailto:support@fortress-audit.com?subject=Audit%20Failed%20for%20${encodeURIComponent(auditFailureModal.domain)}`
        }}
      />

      {/* Domain Limit Reached Modal */}
      <DomainLimitReachedModal
        open={domainLimitModalOpen}
        onOpenChange={setDomainLimitModalOpen}
        plan={limitPlan}
        currentDomains={currentDomains}
        domainLimit={domainLimit}
      />

      {/* Pages summary modal — pages found, audited, with issues */}
      {mostRecentAudit && (
        <PagesSummaryModal
          open={pagesSummaryModalOpen}
          onOpenChange={setPagesSummaryModalOpen}
          pagesFound={mostRecentAudit.pages_found ?? mostRecentAudit.issues_json?.pagesFound ?? null}
          pagesAudited={mostRecentAudit.issues_json?.auditedUrls?.length ?? mostRecentAudit.pages_audited ?? 0}
          pagesWithIssues={metrics.pagesWithIssues ?? 0}
          discoveredPages={mostRecentAudit.issues_json?.discoveredPages ?? []}
          auditedUrls={mostRecentAudit.issues_json?.auditedUrls ?? []}
          pagePathsWithIssues={pagePathsWithIssues}
        />
      )}
    </>
  )
}


