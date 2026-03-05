// fortress v1
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@supabase/supabase-js'
import { generateFile } from '@/lib/file-generator'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization')
  if (!auth?.toLowerCase().startsWith('bearer ')) return null
  return auth.split(' ')[1]
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Immediately await params to prevent Next.js 15 enumeration warnings
  const { id } = await params
  const startTime = Date.now()
  try {
    const token = getBearerToken(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    if (userError || !userData?.user?.id) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
    const userId = userData.user.id

    // Get format from query params
    const url = new URL(request.url)
    const format = url.searchParams.get('format') || 'md' // md, pdf, docx, html
    const watermark = url.searchParams.get('watermark') === 'true'

    // Get user plan
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('user_id', userId)
      .maybeSingle()
    const plan = profile?.plan || 'free'

    // Gate exports by plan
    if (format !== 'md' && plan !== 'pro') {
      return NextResponse.json(
        { error: `Export format ${format} requires Pro plan` },
        { status: 403 }
      )
    }

    // Fetch guideline
    const supabaseUser = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    })

    const { data: guideline, error } = await supabaseUser
      .from('guidelines')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!guideline) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const content = guideline.content_md || ''
    const title = guideline.title || 'Untitled'
    const filename = title.replace(/\s+/g, '-').toLowerCase()

    // Generate export based on format
    switch (format) {
      case 'md':
        return new NextResponse(content, {
          headers: {
            'Content-Type': 'text/markdown',
            'Content-Disposition': `attachment; filename="${filename}.md"`,
          },
        })

      case 'docx':
        try {
          const blob = await generateFile('docx', content, title)
          const buffer = await blob.arrayBuffer()
          return new NextResponse(buffer, {
            headers: {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename="${filename}.docx"`,
            },
          })
        } catch (error) {
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to generate DOCX' },
            { status: 500 }
          )
        }

      case 'html':
        const htmlContent = generateHTML(content, title, watermark)
        return new NextResponse(htmlContent, {
          headers: {
            'Content-Type': 'text/html',
            'Content-Disposition': `attachment; filename="${filename}.html"`,
          },
        })

      case 'pdf':
        // PDF generation done client-side via html2pdf.js
        // Return HTML that client can convert to PDF
        const pdfHTML = generateHTML(content, title, watermark)
        return new NextResponse(pdfHTML, {
          headers: {
            'Content-Type': 'text/html',
            'Content-Disposition': `attachment; filename="${filename}.html"`,
          },
        })

      default:
        return NextResponse.json({ error: 'Invalid format' }, { status: 400 })
    }
  } catch (e) {
    const duration = Date.now() - startTime
    const error = e instanceof Error ? e : new Error('Unknown error')
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}

function generateHTML(markdown: string, title: string, watermark: boolean): string {
  // Enhanced markdown to HTML conversion
  let html = markdown
    // Headers (order matters - do h3 before h2 before h1)
    .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold and italic (bold first to avoid conflicts)
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    // Code blocks
    .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
    .replace(/`(.*?)`/gim, '<code>$1</code>')
    // Lists
    .replace(/^[-*+]\s+(.*$)/gim, '<li>$1</li>')
    .replace(/^\d+\.\s+(.*$)/gim, '<li>$1</li>')
    // Emojis/symbols
    .replace(/✅/gim, '✓')
    .replace(/❌/gim, '✗')
    .replace(/→/gim, '→')
    // Line breaks (preserve paragraphs)
    .replace(/\n\n/gim, '</p><p>')
    .replace(/\n/gim, '<br>')

  // Wrap list items
  html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>')
  // Wrap paragraphs
  html = `<p>${html}</p>`

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      max-width: 800px; 
      margin: 40px auto; 
      padding: 20px; 
      line-height: 1.6; 
      color: #1a1a1a;
    }
    h1 { font-size: 2em; margin-top: 1em; margin-bottom: 0.5em; font-weight: 600; }
    h2 { font-size: 1.5em; margin-top: 1em; margin-bottom: 0.5em; font-weight: 600; }
    h3 { font-size: 1.2em; margin-top: 0.8em; margin-bottom: 0.4em; font-weight: 600; }
    h4 { font-size: 1.1em; margin-top: 0.6em; margin-bottom: 0.3em; font-weight: 600; }
    p { margin: 0.5em 0; }
    ul, ol { margin: 0.5em 0; padding-left: 2em; }
    li { margin: 0.25em 0; }
    code { background: #f5f5f5; padding: 0.2em 0.4em; border-radius: 3px; font-family: monospace; }
    pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    ${watermark ? 'body::after { content: "Generated by Fortress"; position: fixed; bottom: 10px; right: 10px; opacity: 0.3; font-size: 12px; color: #666; }' : ''}
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${html}
</body>
</html>`
}

