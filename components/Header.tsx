"use client"

import { useState, useEffect } from "react"
import { useRouter, usePathname } from "next/navigation"
import Link from "next/link"
import { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase-browser"

interface HeaderProps {
  rightContent?: ReactNode
}

export default function Header({ rightContent }: HeaderProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    const checkAuth = async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      setIsAuthenticated(!!session)
    }
    checkAuth()

    // Use session arg directly to avoid getSession() deadlock during initialization
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthenticated(!!session)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  // Don't render on dashboard (it has its own header)
  if (pathname?.startsWith('/dashboard')) {
    return null
  }

  return (
    <header className="border-b border-border">
      <nav className="container mx-auto px-6 py-6 flex items-center justify-between">
        <Link href="/" className="text-2xl font-serif font-semibold tracking-tight hover:opacity-80 transition-opacity">
          Fortress
        </Link>
        <div className="flex items-center gap-4">
          {rightContent ? (
            rightContent
          ) : (
            <>
              {isAuthenticated ? (
                <>
                  <Button variant="ghost" onClick={() => router.push('/dashboard')}>Dashboard</Button>
                  <Button variant="ghost" onClick={() => router.push('/pricing')}>Pricing</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => router.push('/pricing')}>Pricing</Button>
                  <Button onClick={() => router.push('/sign-up?mode=sign-in')}>Sign in</Button>
                </>
              )}
            </>
          )}
        </div>
      </nav>
    </header>
  )
} 