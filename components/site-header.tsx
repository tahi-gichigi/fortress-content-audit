"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { createClient } from "@/lib/supabase-browser"
import { PLAN_NAMES } from "@/lib/plans"

// Account management (sign out, account settings) is handled by NavUser in the sidebar footer.
// This header only shows the plan badge — no duplicate account controls needed.
export function SiteHeader() {
  const [plan, setPlan] = useState<string | null>(null)

  useEffect(() => {
    const loadPlan = async (userId?: string) => {
      const supabase = createClient()
      // If no userId provided, get from session (only safe outside onAuthStateChange)
      let uid = userId
      if (!uid) {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        uid = session.user.id
      }
      const { data: profile } = await supabase
        .from('profiles')
        .select('plan')
        .eq('user_id', uid)
        .maybeSingle()
      setPlan(profile?.plan || 'free')
    }
    loadPlan()

    // Use session arg directly to avoid getSession() deadlock during initialization
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) loadPlan(session.user.id)
    })
    const handlePaymentSuccess = () => loadPlan()
    window.addEventListener('paymentSuccess', handlePaymentSuccess)
    return () => {
      subscription.unsubscribe()
      window.removeEventListener('paymentSuccess', handlePaymentSuccess)
    }
  }, [])

  return (
    <header className="group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear">
      <div className="flex w-full items-center gap-2 px-4 lg:gap-3 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="hidden sm:block mx-2 data-[orientation=vertical]:h-4"
        />
        <Link href="/dashboard" className="text-lg sm:text-2xl font-serif font-semibold tracking-tight hover:opacity-80 transition-opacity">
          Dashboard
        </Link>
        {plan && (
          <Badge
            variant={plan === 'pro' || plan === 'enterprise' ? 'default' : 'secondary'}
            className="hidden sm:flex ml-2"
          >
            {PLAN_NAMES[plan as keyof typeof PLAN_NAMES] || 'Free'}
          </Badge>
        )}
      </div>
    </header>
  )
}
