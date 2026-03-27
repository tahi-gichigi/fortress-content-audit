import { NextResponse } from "next/server"
import { supabase, type EmailCapture } from '@/lib/supabase'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Helper function for error handling
const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

export async function POST(request: Request) {
  const startTime = Date.now()
  console.log(`[Email Capture API] POST request started at ${new Date().toISOString()}`)
  
  try {
    // Parse and validate request body
    let body;
    try {
      body = await request.json()
    } catch (parseError) {
      console.error('[Email Capture API] Invalid JSON in request body:', parseError)
      return NextResponse.json(
        { error: 'Invalid JSON in request body', details: getErrorMessage(parseError) },
        { status: 400 }
      )
    }

    const { sessionToken, email } = body
    console.log(`[Email Capture API] Request data:`, { sessionToken, email: email ? email.substring(0, 3) + '***' : undefined })

    // Validate required fields
    if (!sessionToken || !email) {
      console.warn('[Email Capture API] Missing required fields:', { sessionToken: !!sessionToken, email: !!email })
      return NextResponse.json(
        { 
          error: 'Missing required fields: sessionToken, email',
          received: { sessionToken: !!sessionToken, email: !!email }
        },
        { status: 400 }
      )
    }

    // Validate email format - DISABLED FOR TESTING
    // Note: Relying on HTML5 browser validation and database constraints
    // const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    // if (!emailRegex.test(email.trim())) {
    //   console.warn('[Email Capture API] Invalid email format:', email.substring(0, 5) + '***')
    //   return NextResponse.json(
    //     { error: 'Invalid email format' },
    //     { status: 400 }
    //   )
    // }
    console.log('[Email Capture API] Email regex validation disabled - proceeding with browser validation')

    // Validate session token format
    if (sessionToken.length < 10) {
      console.warn('[Email Capture API] Invalid session token format:', sessionToken.substring(0, 5) + '***')
      return NextResponse.json(
        { error: 'Invalid session token format' },
        { status: 400 }
      )
    }

    console.log(`[Email Capture API] Storing capture for session: ${sessionToken}, email: ${email.substring(0, 3)}***`)

    // Test Supabase connection — uses admin client (anon has no SELECT on email_captures)
    try {
      await supabaseAdmin.from('email_captures').select('id').limit(1)
    } catch (connectionError) {
      console.error('[Email Capture API] Supabase connection test failed:', connectionError)
      return NextResponse.json(
        { error: 'Database connection failed', details: (connectionError as Error).message },
        { status: 503 }
      )
    }

    // Insert or update email capture in Supabase
    const { data, error } = await supabase
      .from('email_captures')
      .upsert({
        session_token: sessionToken,
        email: email.trim(),
        payment_completed: false
      }, {
        onConflict: 'session_token'
      })
      .select()

    if (error) {
      console.error('[Email Capture API] Supabase upsert error:', {
        code: error.code,
        message: (error as Error).message,
        details: error.details,
        hint: error.hint
      })
      return NextResponse.json(
        { 
          error: 'Failed to store email capture',
          supabaseError: error.message,
          code: error.code
        },
        { status: 500 }
      )
    }

    if (!data || data.length === 0) {
      console.error('[Email Capture API] No data returned from upsert operation')
      return NextResponse.json(
        { error: 'No data returned from database operation' },
        { status: 500 }
      )
    }

    const duration = Date.now() - startTime
    console.log(`[Email Capture API] Successfully stored in Supabase for session: ${sessionToken} (${duration}ms)`)
    console.log(`[Email Capture API] Stored record:`, { 
      id: data[0].id, 
      session_token: data[0].session_token,
      email: data[0].email.substring(0, 3) + '***',
      captured_at: data[0].captured_at,
      payment_completed: data[0].payment_completed
    })

    return NextResponse.json({ 
      success: true, 
      message: 'Email capture stored successfully',
      sessionToken,
      captureId: data[0].id,
      duration: `${duration}ms`
    })

  } catch (error) {
    const duration = Date.now() - startTime
    console.error('[Email Capture API] Unexpected error:', {
      error: (error as Error).message,
      stack: (error as Error).stack,
      duration: `${duration}ms`
    })
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: (error as Error).message,
        duration: `${duration}ms`
      },
      { status: 500 }
    )
  }
}

// GET endpoint to retrieve captures (for debugging/admin)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionToken = searchParams.get('sessionToken')

    if (sessionToken) {
      // Return specific capture — uses admin client (anon has no SELECT on email_captures)
      const { data, error } = await supabaseAdmin
        .from('email_captures')
        .select('*')
        .eq('session_token', sessionToken)
        .single()

      if (error) {
        return NextResponse.json(
          { error: 'Capture not found' },
          { status: 404 }
        )
      }

      return NextResponse.json(data)
    } else {
      // Return all captures (admin/debugging) — uses admin client
      const { data, error } = await supabaseAdmin
        .from('email_captures')
        .select('*')
        .order('captured_at', { ascending: false })

      if (error) {
        console.error('[Email Capture] Error retrieving captures:', error)
        return NextResponse.json(
          { error: 'Failed to retrieve email captures' },
          { status: 500 }
        )
      }

      const total = data.length
      const abandoned = data.filter(c => !c.payment_completed).length
      const completed = data.filter(c => c.payment_completed).length

      return NextResponse.json({ 
        captures: data,
        total,
        abandoned,
        completed
      })
    }

  } catch (error) {
    console.error('Error retrieving email captures:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve email captures' },
      { status: 500 }
    )
  }
}

// PUT endpoint to mark capture as completed (called from webhook)
export async function PUT(request: Request) {
  const startTime = Date.now()
  console.log(`[Email Capture API] PUT request started at ${new Date().toISOString()}`)
  
  try {
    // Parse and validate request body
    let body;
    try {
      body = await request.json()
    } catch (parseError) {
      console.error('[Email Capture API] PUT - Invalid JSON in request body:', parseError)
      return NextResponse.json(
        { error: 'Invalid JSON in request body', details: (parseError as Error).message },
        { status: 400 }
      )
    }

    const { sessionToken } = body
    console.log(`[Email Capture API] PUT - Marking session as completed: ${sessionToken}`)

    if (!sessionToken) {
      console.warn('[Email Capture API] PUT - Missing sessionToken')
      return NextResponse.json(
        { error: 'Missing required field: sessionToken' },
        { status: 400 }
      )
    }

    // Validate session token format
    if (sessionToken.length < 10) {
      console.warn('[Email Capture API] PUT - Invalid session token format:', sessionToken.substring(0, 5) + '***')
      return NextResponse.json(
        { error: 'Invalid session token format' },
        { status: 400 }
      )
    }

    // First, check if the capture exists — uses admin client (anon has no SELECT on email_captures)
    console.log(`[Email Capture API] PUT - Checking if capture exists for session: ${sessionToken}`)
    const { data: existingData, error: selectError } = await supabaseAdmin
      .from('email_captures')
      .select('*')
      .eq('session_token', sessionToken)
      .single()

    if (selectError) {
      if (selectError.code === 'PGRST116') {
        console.warn(`[Email Capture API] PUT - No capture found for session: ${sessionToken}`)
        return NextResponse.json(
          { error: 'Capture not found', sessionToken },
          { status: 404 }
        )
      } else {
        console.error('[Email Capture API] PUT - Error checking existing capture:', selectError)
        return NextResponse.json(
          { error: 'Database error while checking capture', details: selectError.message },
          { status: 500 }
        )
      }
    }

    console.log(`[Email Capture API] PUT - Found existing capture:`, {
      id: existingData.id,
      email: existingData.email.substring(0, 3) + '***',
      captured_at: existingData.captured_at,
      payment_completed: existingData.payment_completed
    })

    // Check if already completed
    if (existingData.payment_completed) {
      console.log(`[Email Capture API] PUT - Session already marked as completed: ${sessionToken}`)
      return NextResponse.json({ 
        success: true, 
        message: 'Email capture already marked as completed',
        capture: existingData,
        alreadyCompleted: true
      })
    }

    // Update payment_completed to true — uses admin client (anon has no UPDATE on email_captures)
    const { data, error } = await supabaseAdmin
      .from('email_captures')
      .update({ payment_completed: true })
      .eq('session_token', sessionToken)
      .select()

    if (error) {
      console.error('[Email Capture API] PUT - Supabase update error:', {
        code: error.code,
        message: (error as Error).message,
        details: error.details,
        hint: error.hint
      })
      return NextResponse.json(
        { 
          error: 'Failed to update email capture',
          supabaseError: error.message,
          code: error.code
        },
        { status: 500 }
      )
    }

    if (!data || data.length === 0) {
      console.error(`[Email Capture API] PUT - No data returned from update for session: ${sessionToken}`)
      return NextResponse.json(
        { error: 'No data returned from update operation' },
        { status: 500 }
      )
    }

    const duration = Date.now() - startTime
    console.log(`[Email Capture API] PUT - Successfully marked session as completed: ${sessionToken} (${duration}ms)`)
    console.log(`[Email Capture API] PUT - Updated record:`, {
      id: data[0].id,
      email: data[0].email.substring(0, 3) + '***',
      payment_completed: data[0].payment_completed,
      captured_at: data[0].captured_at
    })

    return NextResponse.json({ 
      success: true, 
      message: 'Email capture marked as completed',
      capture: data[0],
      duration: `${duration}ms`
    })

  } catch (error) {
    const duration = Date.now() - startTime
    console.error('[Email Capture API] PUT - Unexpected error:', {
      error: (error as Error).message,
      stack: (error as Error).stack,
      duration: `${duration}ms`
    })
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: (error as Error).message,
        duration: `${duration}ms`
      },
      { status: 500 }
    )
  }
} 