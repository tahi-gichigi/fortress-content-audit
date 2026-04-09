/**
 * Tests for html-to-annotated-text converter.
 * Converted from custom runner to Jest format.
 */

import { htmlToAnnotatedText, htmlToAnnotatedTextChunks } from '../html-to-annotated-text'

const testHtml = `
<html>
<head><title>Test Page</title></head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/pricing">Pricing</a>
  </nav>
  <header>
    <h1>Welcome to Our Site</h1>
    <p>We build great things.</p>
  </header>
  <main>
    <section>
      <h2>Features</h2>
      <p>Our product has amazing features.</p>
      <span class="badge">New</span>
      <span class="badge-pill">Beta</span>
    </section>
    <section>
      <h2>Pricing</h2>
      <p>Starting at $9/month.</p>
      <button>Get Started</button>
    </section>
  </main>
  <footer>
    <p>Copyright 2026</p>
    <a href="/privacy">Privacy</a>
  </footer>
</body>
</html>
`

describe('htmlToAnnotatedText', () => {
  const result = htmlToAnnotatedText(testHtml, 'https://test.com')

  it('contains [NAV] prefix', () => expect(result).toContain('[NAV]'))
  it('contains [HEADER] prefix', () => expect(result).toContain('[HEADER]'))
  it('contains [H1] prefix', () => expect(result).toContain('[H1]'))
  it('contains [H2] prefix', () => expect(result).toContain('[H2]'))
  it('contains [P] prefix', () => expect(result).toContain('[P]'))
  it('contains [SECTION] prefix', () => expect(result).toContain('[SECTION]'))
  it('contains [FOOTER] prefix', () => expect(result).toContain('[FOOTER]'))
  it('contains [Badge: New]', () => expect(result).toContain('[Badge: New]'))
  it('contains [Badge: Beta]', () => expect(result).toContain('[Badge: Beta]'))
  it('contains button text', () => expect(result.includes('[Button:') || result.includes('Get Started')).toBe(true))
  it('does not contain raw <script>', () => expect(result).not.toContain('<script>'))
  it('does not contain raw <nav>', () => expect(result).not.toContain('<nav>'))
  it('output is shorter than input (compression)', () => expect(result.length).toBeLessThan(testHtml.length))

  describe('hidden element removal', () => {
    const hiddenHtml = `
<body>
  <p>Visible text</p>
  <span class="hidden">Hidden text</span>
  <span class="sr-only">Screen reader only</span>
  <div class="hidden md:flex">Responsive nav</div>
  <p>More visible text</p>
</body>
`
    const hiddenResult = htmlToAnnotatedText(hiddenHtml, 'https://test.com')

    it('removes hidden spans', () => expect(hiddenResult).not.toContain('Hidden text'))
    it('removes sr-only spans', () => expect(hiddenResult).not.toContain('Screen reader only'))
    it('keeps responsive-show elements', () => expect(hiddenResult).toContain('Responsive nav'))
    it('keeps visible text', () => expect(hiddenResult).toContain('Visible text'))
  })
})

describe('htmlToAnnotatedTextChunks', () => {
  it('chunks when over limit', () => {
    const chunks = htmlToAnnotatedTextChunks(testHtml, 'https://test.com', 100)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('each chunk under limit (with small buffer)', () => {
    const chunks = htmlToAnnotatedTextChunks(testHtml, 'https://test.com', 100)
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(120))
  })

  it('single chunk when under limit', () => {
    const chunks = htmlToAnnotatedTextChunks(testHtml, 'https://test.com', 50000)
    expect(chunks.length).toBe(1)
  })
})
