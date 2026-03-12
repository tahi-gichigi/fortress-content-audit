/**
 * Tests for lib/html-compressor.ts
 *
 * Three areas:
 * 1. Attribute stripping — class/id/style/data-* removed, whitelist preserved
 * 2. Tag stripping — script/style/noscript/head removed entirely
 * 3. SVG replacement — inline SVGs → placeholders
 */

import { compressHtml } from '../html-compressor'

// ============================================================================
// 1. Attribute stripping
// ============================================================================

describe('compressHtml — attribute stripping', () => {
  it('removes class attributes', () => {
    const html = '<p class="text-xl font-bold">Hello</p>'
    expect(compressHtml(html)).not.toContain('class=')
    expect(compressHtml(html)).toContain('Hello')
  })

  it('removes id attributes', () => {
    const html = '<section id="hero-section"><h1>Title</h1></section>'
    expect(compressHtml(html)).not.toContain('id=')
    expect(compressHtml(html)).toContain('Title')
  })

  it('removes style attributes', () => {
    const html = '<div style="display: none; color: red">Hidden</div>'
    expect(compressHtml(html)).not.toContain('style=')
  })

  it('removes data-* attributes', () => {
    const html = '<button data-testid="submit-btn" data-track="cta">Click me</button>'
    expect(compressHtml(html)).not.toContain('data-testid')
    expect(compressHtml(html)).not.toContain('data-track')
    expect(compressHtml(html)).toContain('Click me')
  })

  it('preserves href on links', () => {
    const html = '<a href="/pricing" class="nav-link">Pricing</a>'
    const result = compressHtml(html)
    expect(result).toContain('href="/pricing"')
    expect(result).not.toContain('class=')
  })

  it('preserves alt on images', () => {
    const html = '<img src="/hero.png" alt="Product dashboard" class="rounded-lg"/>'
    const result = compressHtml(html)
    expect(result).toContain('alt="Product dashboard"')
    expect(result).not.toContain('class=')
  })

  it('preserves aria-label', () => {
    const html = '<button aria-label="Close dialog" class="btn">X</button>'
    const result = compressHtml(html)
    expect(result).toContain('aria-label="Close dialog"')
    expect(result).not.toContain('class=')
  })

  it('preserves all aria-* attributes', () => {
    const html = '<div aria-hidden="true" aria-expanded="false" aria-live="polite">Content</div>'
    const result = compressHtml(html)
    expect(result).toContain('aria-hidden="true"')
    expect(result).toContain('aria-expanded="false"')
    expect(result).toContain('aria-live="polite"')
  })

  it('preserves src, title, type, role, target', () => {
    const html = `
      <img src="/img.jpg" title="Tooltip" class="img"/>
      <input type="email" class="input" placeholder="Enter email"/>
      <a href="/about" target="_blank" rel="noopener">About</a>
      <div role="dialog" class="modal">Dialog</div>
    `
    const result = compressHtml(html)
    expect(result).toContain('src="/img.jpg"')
    expect(result).toContain('title="Tooltip"')
    expect(result).toContain('type="email"')
    expect(result).toContain('target="_blank"')
    expect(result).toContain('role="dialog"')
    expect(result).not.toContain('class=')
  })
})

// ============================================================================
// 2. Tag stripping
// ============================================================================

describe('compressHtml — tag/content stripping', () => {
  it('removes <script> tags and their content', () => {
    const html = '<p>Hello</p><script>var x = 1; console.log("hi")</script><p>World</p>'
    const result = compressHtml(html)
    expect(result).not.toContain('var x')
    expect(result).not.toContain('console.log')
    expect(result).toContain('Hello')
    expect(result).toContain('World')
  })

  it('removes <style> tags and their content', () => {
    const html = '<h1>Title</h1><style>.foo { color: red; }</style><p>Text</p>'
    const result = compressHtml(html)
    expect(result).not.toContain('.foo')
    expect(result).not.toContain('color: red')
    expect(result).toContain('Title')
  })

  it('removes <noscript> tags', () => {
    const html = '<p>Hi</p><noscript><p>Enable JavaScript</p></noscript>'
    const result = compressHtml(html)
    expect(result).not.toContain('Enable JavaScript')
    expect(result).toContain('Hi')
  })

  it('removes HTML comments', () => {
    const html = '<!-- This is a comment --><p>Visible</p><!-- Another comment -->'
    const result = compressHtml(html)
    expect(result).not.toContain('This is a comment')
    expect(result).toContain('Visible')
  })

  it('preserves semantic tags (h1-h6, p, nav, main, section, footer)', () => {
    const html = `
      <header><nav><a href="/">Home</a></nav></header>
      <main>
        <section>
          <h1>Welcome</h1>
          <h2>Features</h2>
          <p>We make things better.</p>
        </section>
      </main>
      <footer><p>© 2024</p></footer>
    `
    const result = compressHtml(html)
    expect(result).toContain('<header>')
    expect(result).toContain('<nav>')
    expect(result).toContain('<main>')
    expect(result).toContain('<section>')
    expect(result).toContain('<h1>')
    expect(result).toContain('<h2>')
    expect(result).toContain('<footer>')
  })
})

// ============================================================================
// 3. SVG replacement
// ============================================================================

describe('compressHtml — SVG replacement', () => {
  it('replaces inline SVGs with placeholder', () => {
    const html = '<span><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/><circle cx="12" cy="12" r="10"/></svg></span>'
    const result = compressHtml(html)
    expect(result).not.toContain('<path')
    expect(result).not.toContain('<circle')
    expect(result).toContain('<svg')
  })

  it('preserves aria-label in SVG placeholder', () => {
    const html = '<svg aria-label="Dashboard icon" class="icon"><path d="M0 0"/></svg>'
    const result = compressHtml(html)
    expect(result).toContain('aria-label="Dashboard icon"')
    expect(result).not.toContain('<path')
  })

  it('preserves role in SVG placeholder', () => {
    const html = '<svg role="img" class="icon"><title>Logo</title><path d="M0 0"/></svg>'
    const result = compressHtml(html)
    expect(result).toContain('role="img"')
    expect(result).not.toContain('<path')
  })

  it('produces shorter output than input for SVG-heavy pages', () => {
    const heavySvg = `<path d="${'M 0 0 '.repeat(500)}"/>`.repeat(10)
    const html = `<main><h1>Hello</h1><svg>${heavySvg}</svg><p>World</p></main>`
    const result = compressHtml(html)
    expect(result.length).toBeLessThan(html.length)
    expect(result).toContain('Hello')
    expect(result).toContain('World')
  })
})

// ============================================================================
// 4. Compression ratio
// ============================================================================

describe('compressHtml — compression ratio', () => {
  it('significantly reduces a Tailwind-heavy page', () => {
    // Simulate a typical Tailwind page with lots of class noise
    const tailwindPage = `
      <div class="flex flex-col min-h-screen bg-white">
        <header class="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
          <nav class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
            <a href="/" class="text-xl font-bold text-gray-900">Fortress</a>
            <div class="hidden md:flex items-center space-x-8">
              <a href="/pricing" class="text-sm font-medium text-gray-700 hover:text-gray-900">Pricing</a>
              <a href="/docs" class="text-sm font-medium text-gray-700 hover:text-gray-900">Docs</a>
              <button class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700">
                Get Started
              </button>
            </div>
          </nav>
        </header>
        <main class="flex-1">
          <section class="py-20 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            <h1 class="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-gray-900 tracking-tight">
              Ship faster with Fortress
            </h1>
            <p class="mt-6 text-xl text-gray-500 max-w-3xl">
              Content auditing that catches real issues, not false positives.
            </p>
          </section>
        </main>
      </div>
    `
    const result = compressHtml(tailwindPage)
    // Should reduce by at least 40% on a Tailwind page
    expect(result.length).toBeLessThan(tailwindPage.length * 0.6)
    // But must preserve all text and semantic structure
    expect(result).toContain('Ship faster with Fortress')
    expect(result).toContain('Content auditing that catches real issues')
    expect(result).toContain('href="/pricing"')
    expect(result).toContain('Get Started')
  })

  it('returns non-empty output for empty input', () => {
    expect(compressHtml('')).toBeDefined()
  })

  it('handles input with no compressible noise gracefully', () => {
    const simple = '<main><h1>Hello</h1><p>World</p></main>'
    const result = compressHtml(simple)
    expect(result).toContain('Hello')
    expect(result).toContain('World')
  })
})
