// Browser client for Supabase with proper cookie handling
// Use this in client components instead of the basic supabase client

import { createBrowserClient } from '@supabase/ssr'
import { Database } from '@/types/database.types'

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing Supabase environment variables. NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
      'Check your environment configuration: https://supabase.com/dashboard/project/_/settings/api'
    )
  }

  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey)
}
