"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase-browser"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/hooks/use-toast"
import { Loader2, AlertCircle } from "lucide-react"
import { AuditIntentPicker } from "@/components/audit-intent-picker"
import type { CustomAuditOptions } from "@/components/audit-intent-picker"
import type { AuditPreset } from "@/types/fortress"

interface NewAuditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: (newDomain: string) => void
  /** Pre-fill the domain and skip straight to the audit settings step */
  defaultDomain?: string
}

interface UsageInfo {
  domains: number
  domainLimit: number
  today: number
  limit: number
}

export function NewAuditDialog({ open, onOpenChange, onSuccess, defaultDomain }: NewAuditDialogProps) {
  const { toast } = useToast()
  const [domain, setDomain] = useState("")
  const [loading, setLoading] = useState(false)
  const [usageInfo, setUsageInfo] = useState<UsageInfo | null>(null)
  const [plan, setPlan] = useState<string>("free")
  const [error, setError] = useState<string | null>(null)
  // 2-step flow: 1 = enter URL, 2 = pick preset
  // If a defaultDomain is provided, skip straight to step 2
  const [step, setStep] = useState<1 | 2>(defaultDomain ? 2 : 1)

  // Poll for audit completion (runs after dialog closes)
  const pollForCompletion = useCallback(async (runId: string, domainName: string) => {
    const maxAttempts = 20 // 5 minutes max (15s intervals)
    let attempts = 0
    
    const poll = async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        
        const response = await fetch(`/api/audit/${runId}`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`
          }
        })
        
        if (!response.ok) {
          attempts++
          if (attempts < maxAttempts) {
            setTimeout(poll, 15000) // Poll every 15 seconds
          }
          return
        }
        
        const data = await response.json()
        
        // Check if audit failed
        if (data.status === 'failed') {
          // Don't show toast - dashboard's polling will show modal
          // Just notify parent to reload
          if (onSuccess) {
            onSuccess(domainName)
          }
          return
        }

        // Check if audit is complete (status completed, regardless of issue count)
        if (data.status === 'completed') {
          // Don't show toast - dashboard's polling will show modal
          // Just notify parent to reload
          if (onSuccess) {
            onSuccess(domainName)
          }
          return
        }
        
        // Still pending - continue polling
        attempts++
        if (attempts < maxAttempts) {
          setTimeout(poll, 15000) // Poll every 15 seconds
        } else {
          // Timeout - audit may still complete, user can refresh
          console.log('[NewAuditDialog] Polling timeout, audit may still be running')
        }
      } catch (error) {
        console.error('[NewAuditDialog] Poll error:', error)
        attempts++
        if (attempts < maxAttempts) {
          setTimeout(poll, 15000) // Poll every 15 seconds
        }
      }
    }
    
    // Start polling after a short delay
    setTimeout(poll, 3000)
  }, [toast, onSuccess])

  const loadUsageInfo = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      // Get plan
      const { data: profile } = await supabase
        .from('profiles')
        .select('plan')
        .eq('user_id', session.user.id)
        .maybeSingle()
      
      if (profile) {
        setPlan(profile.plan || 'free')
      }

      // Get usage info
      const response = await fetch('/api/audit/usage', {
        headers: {
          'Authorization': `Bearer ${session.access_token}`
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

  // Load usage info and plan when dialog opens
  useEffect(() => {
    if (open) {
      loadUsageInfo()
      // Reset states when dialog opens; if defaultDomain given, pre-fill and skip to step 2
      setDomain(defaultDomain ?? "")
      setError(null)
      setStep(defaultDomain ? 2 : 1)
    }
  }, [open, loadUsageInfo, defaultDomain])

  // Listen for payment success to refresh plan data
  useEffect(() => {
    const handlePaymentSuccess = () => {
      loadUsageInfo()
    }
    window.addEventListener('paymentSuccess', handlePaymentSuccess)
    return () => {
      window.removeEventListener('paymentSuccess', handlePaymentSuccess)
    }
  }, [loadUsageInfo])

  // Step 1: Validate domain and go to preset picker
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!domain.trim()) {
      setError("Please enter a website URL")
      return
    }

    setError(null)
    setStep(2)
  }

  // Step 2: Run audit with selected preset
  const handleRunWithPreset = async (preset: AuditPreset, options?: CustomAuditOptions) => {
    setLoading(true)
    setError(null)

    const inputDomain = domain.trim()
    const normalizedDomain = inputDomain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')

    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setLoading(false)
        setError("Not authenticated. Please sign in and try again.")
        return
      }

      const baseUrl = typeof window !== 'undefined'
        ? window.location.origin
        : process.env.NEXT_PUBLIC_APP_URL || ''

      // Build POST body with preset info
      const postBody: Record<string, unknown> = { domain: inputDomain, preset }
      if (options?.flagAiWriting !== undefined) postBody.flagAiWriting = options.flagAiWriting
      if (options?.readabilityLevel) postBody.readabilityLevel = options.readabilityLevel
      if (options?.formality) postBody.formality = options.formality
      if (options?.locale) postBody.locale = options.locale
      if (options?.includeLongform !== undefined) postBody.includeLongform = options.includeLongform
      if (options?.voiceSummary) postBody.voiceSummary = options.voiceSummary

      const response = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify(postBody)
      })

      // If response.ok, validation passed and audit started in background
      if (response.ok) {
        const data = await response.json()
        
        // Close dialog - dashboard will show "started" modal
        onOpenChange(false)
        setDomain("")
        setLoading(false)

        // Notify parent immediately so it can show the banner and modal
        if (onSuccess) {
          onSuccess(normalizedDomain)
        }

        // Audit is running in background - poll for completion
        if (data.runId && data.status === 'pending') {
          pollForCompletion(data.runId, normalizedDomain)
        } else if (data.status === 'completed') {
          // Audit already completed (mock data or very fast)
          // Dashboard will show success modal
          if (onSuccess) {
            onSuccess(normalizedDomain)
          }
        } else if (data.status === 'failed') {
          // Audit failed immediately (shouldn't happen but handle it)
          // Dashboard will show failure modal
          if (onSuccess) {
            onSuccess(normalizedDomain)
          }
        }
        
        return
      } else {
        // Validation errors - show in dialog, keep open
        setLoading(false)
        const errorData = await response.json().catch(() => ({}))
        
        // Provide specific error messages
        let errorMessage = 'Failed to start audit'
        if (response.status === 429) {
          errorMessage = errorData.message || 'Daily limit reached'
        } else if (response.status === 403) {
          errorMessage = 'This feature requires a paid plan. Upgrade to Pro or Enterprise.'
        } else if (response.status === 400) {
          errorMessage = errorData.error || 'Invalid domain. Please check the URL and try again.'
        } else if (response.status === 401) {
          errorMessage = 'Authentication required. Please sign in and try again.'
        } else {
          errorMessage = errorData.error || `Failed to start audit (${response.status})`
        }
        
        setError(errorMessage)
      }
    } catch (error) {
      console.error('Audit error:', error)
      setLoading(false)
      
      const errorMessage = error instanceof Error 
        ? error.message 
        : "Failed to start audit. Please try again."
      
      setError(errorMessage)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        {step === 1 ? (
          /* Step 1: Enter domain */
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-2xl font-semibold">New Domain</DialogTitle>
              <DialogDescription>
                Start a new content audit for a domain.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit}>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="domain">Domain</Label>
                  <Input
                    id="domain"
                    placeholder="example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    disabled={loading}
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter the domain you want to audit (e.g., example.com)
                  </p>
                </div>

                {error && step === 1 && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false)
                    setDomain("")
                    setError(null)
                  }}
                  disabled={loading}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!domain.trim()}>
                  Next
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          /* Step 2: Pick audit preset */
          <>
            <div className="py-2">
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {loading ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Starting audit...</p>
                </div>
              ) : (
                <AuditIntentPicker
                  isAuthenticated={true}
                  plan={plan === 'pro' || plan === 'enterprise' ? plan as 'pro' | 'enterprise' : 'free'}
                  domain={domain.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')}
                  onSelect={handleRunWithPreset}
                  // If we pre-filled the domain (rerun flow), back closes the dialog; otherwise go to step 1
                  onBack={defaultDomain
                    ? () => { onOpenChange(false); setError(null) }
                    : () => { setStep(1); setError(null) }
                  }
                  compact
                />
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

