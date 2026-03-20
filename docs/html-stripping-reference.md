# HTML Stripping Reference

How raw HTML becomes model-ready input. This doc maps every tag and attribute we've seen in production to what the pipeline does with it and why.

Baseline: seline.so homepage scraped 2026-03-19. Cross-validated against justcancel.io, vercel.com, dub.co.

---

## Pipeline Overview

```
Raw HTML (from Firecrawl browser scrape)
  │
  ├─ Stage 1: Browser-side JS (firecrawl-client.ts → STRIP_HIDDEN_ELEMENTS_SCRIPT)
  │   Runs BEFORE Firecrawl returns HTML.
  │   Phase 0:  Open native <details> accordions (set open=true + reflow)
  │   Phase 0b: Expand Radix/Headless UI closed panels (data-state="closed" → "open")
  │             Guards: skips dialog/tooltip/menu roles, aria-modal, data-radix-dialog-content,
  │             data-radix-tooltip-content
  │   Phase 1:  Strip by class (.sr-only, .visually-hidden, [aria-hidden="true"])
  │   Phase 2:  Strip by computed style (display:none, visibility:hidden, zero-size)
  │             Skips: <br>, <wbr>, <hr>, <img>, <input>, <svg>, <meta>, <link>
  │             Also strips clip-hidden patterns (position:absolute + overflow:hidden + ≤1px)
  │
  ├─ Stage 2: Regex strip (firecrawl-adapter.ts → stripHtmlNoise)
  │   Strips: <script>...</script>, <style>...</style>, HTML comments, inline SVG content
  │   SVGs → <svg/> placeholder (preserves aria-label/role)
  │
  ├─ Stage 3: Cheerio compressor (html-compressor.ts → compressHtml)
  │   Removes: <script>, <style>, <noscript>, <template>, <head>
  │   Collapses: inline SVGs → <svg/> (defensive, same as stage 2)
  │   Removes: hidden/sr-only/invisible elements (ANY tag, not just span — by class, before class strip)
  │   Strips attrs: class, id, style, data-*, tabindex, event handlers, etc.
  │   Keeps attrs: href, src, alt, title, type, role, for, name, target,
  │                lang, rel, action, method, value, placeholder,
  │                colspan, rowspan, scope, headers, inert, all aria-*
  │   Unwraps: <strong>, <em>, <b>, <i>, <u>, <s>, <del>, <ins>,
  │            <sub>, <sup>, <small>, <font>, <bdt>, <bdo>, <tt>,
  │            <strike>, <big>, bare <span> (no aria-*/role/inert)
  │   Collapses: empty divs (removed) and single-child divs (unwrapped), bottom-up
  │              Guards: skips divs with role or aria-* (semantic landmarks)
  │   Replaces: data: URI src → "[data-uri]"
  │   Collapses: newlines/tabs → single space (NOT between-tag whitespace — preserves "About Pricing" gaps)
  │
  ├─ Stage 4: Nav/footer dedup (firecrawl-adapter.ts → formatFirecrawlForPrompt)
  │   Scope: multi-page audits only (single page = no-op)
  │   Fingerprints nav/header/footer by first 300 chars of normalised text.
  │   Page 2+ matching blocks replaced with <tag>[Same as Page 1]</tag>.
  │   Guards: 300-char fingerprint means a single word difference prevents false dedup.
  │
  └─ Stage 5: Chunking (html-compressor.ts → compressHtmlToChunks)
      Fires only when compressed page > 60K chars.
      Splits at semantic section boundaries (children of <main> or <body>).
      Hard cap: 2 chunks maximum to bound token growth.
      Prompt output: "part 1 of 2" / "part 2 of 2" labels for model clarity.
      Checker stays on chunk 1 only — cost impact is auditor-only.
```

---

## Raw HTML Baseline

| File | Chars | Description |
|------|-------|-------------|
| `docs/samples/seline-raw.html` | 196,605 | Full Firecrawl output (post-browser JS, pre-pipeline) |
| `docs/samples/seline-compressed.html` | 42,183 | After stripHtmlNoise + compressHtml |

**Compression ratio: 79%** (196K → 42K)

### Cross-site compression ratios

| Site | Raw (post-browser) | Compressed | Reduction |
|------|-------------------|------------|-----------|
| seline.so | 164,684 | 42,183 | 74% |
| justcancel.io | 26,659 | 16,472 | 38% |
| vercel.com | 99,492 | 20,086 | 80% |
| dub.co | 120,719 | 26,806 | 78% |

justcancel.io is a lightweight site with minimal Tailwind — less to strip. dub.co raw was 1.5M before browser strip (heavy SVGs), which explains the 98% raw-to-compressed ratio.

---

## Tags Inventory

Every tag found in the seline.so raw HTML, categorised by what the pipeline does with it.

### Kept (structural/semantic — passed through to model)

| Tag | Count | Rationale |
|-----|-------|-----------|
| html | 1 | Document root |
| body | 1 | Document body |
| main | 1 | Primary content container |
| nav | 2 | Navigation regions — model uses these to identify repeated nav content |
| footer | 1 | Footer region |
| div | 1223 | Generic container — kept because it carries structural hierarchy |
| section | 0* | Semantic section (present on other sites: justcancel 7, vercel 10) |
| header | 0* | Header region (present on vercel: 6) |
| aside | 0* | Sidebar content (present on vercel: 1) |
| h1 | 1 | Heading hierarchy — critical for content audit |
| h2 | 7 | " |
| h3 | 26 | " |
| p | 2 | Paragraph text |
| a | 68 | Links — href preserved, essential for link auditing |
| button | 51 | Interactive elements — type preserved |
| img | 89 | Images — src, alt preserved for alt-text auditing |
| input | 2 | Form fields — type, placeholder, value preserved |
| ul/ol/li | 0/0/0* | List structure (present on other sites) |
| br | 5 | Line breaks — skipped by browser strip (zero-size but meaningful) |
| video | 1 | Media element |
| kbd | 1 | Keyboard input indicator |
| pre/code | 0* | Code blocks (present on vercel) |
| time | 0* | Datetime element (present on dub.co: 5) |
| canvas | 0* | Canvas element (present on dub.co: 1) |
| hr | 0* | Horizontal rule (present on vercel: 36) |
| fieldset/label | 0* | Form structure (present on vercel) |

*\* Not present on seline.so but found on other benchmark sites.*

### Unwrapped (text content kept, tag wrapper removed)

| Tag | Count | Rationale |
|-----|-------|-----------|
| span | 114 | Unwrapped unless it carries aria-* or role. Bare spans are styling-only wrappers. |
| strong | 0* | Bold — no audit issue relies on bold context (verified via LangSmith) |
| em | 0* | Italic — same rationale |
| b/i/u/s | 0* | Legacy formatting — same rationale |
| del/ins | 0* | Strikethrough/underline — same rationale |
| sub/sup | 0* | Sub/superscript |
| small | 0* | Small text |
| font | 0* | Legacy font tag |
| bdt/bdo | 0* | Bidirectional text |
| tt/strike/big | 0* | Deprecated formatting |

*\* Not present on seline.so but handled by the pipeline.*

### Removed entirely

| Tag | Count | Rationale |
|-----|-------|-----------|
| svg | 75 | Collapsed to `<svg/>` placeholder. Internal paths/circles are pure visual noise. aria-label/role preserved on placeholder. |
| script | 0* | Removed by stage 2 regex AND stage 3 cheerio (defensive). Zero content value. |
| style | 0* | CSS rules — irrelevant to text content audit. |
| noscript | 0* | Fallback content for non-JS browsers. |
| template | 0* | Unused template fragments. |
| head | 1 | Meta tags, link preloads, title — not body content. |

### Special: hidden elements removed

**All elements** (not just spans) with `hidden`, `sr-only`, or `invisible` Tailwind classes are removed before class stripping (stage 3). This prevents phantom text like the "stray A" bug where a hidden keyboard-shortcut badge merged with adjacent text after span unwrapping. Widened from span-only to catch `<div class="hidden">`, `<p class="sr-only">`, etc. that stage 1 may miss (e.g. if CSS wasn't fully loaded at scrape time).

Browser-side (stage 1) also removes:
- `display:none` elements
- `visibility:hidden` elements
- Zero-size elements (except skip-list tags)
- `aria-hidden="true"` elements
- `.sr-only` / `.visually-hidden` elements
- Clip-based hiding patterns (position:absolute + overflow:hidden + 1px dimensions)

---

## Attributes Inventory

Every attribute found in seline.so raw HTML, categorised by what stage 3 does with it.

### Kept (whitelisted in KEEP_ATTRS or aria-* pattern)

| Attribute | Count (seline) | Rationale |
|-----------|---------------|-----------|
| href | 68 | Link destinations — essential for link audit |
| src | 89 | Image/media sources (data: URIs replaced with `[data-uri]`) |
| alt | 89 | Image alt text — essential for accessibility audit |
| title | 4 | Tooltip text — may contain content worth auditing |
| type | 29 | Input/button type — helps model understand form fields |
| role | 12 | ARIA role — accessibility semantics |
| target | 26 | Link target (`_blank` etc.) — relevant for UX audit |
| lang | 1 | Language attribute — relevant for language audit |
| value | 2 | Form field values |
| placeholder | 1 | Input placeholder text — content worth auditing |
| name | 0* | Form field names |
| for | 0* | Label association |
| rel | 0* | Link relationship (nofollow, noopener) |
| action | 0* | Form action URL |
| method | 0* | Form method |
| colspan/rowspan | 0* | Table cell spanning |
| scope/headers | 0* | Table header associations |
| aria-controls | 11 | ARIA — all aria-* kept |
| aria-labelledby | 9 | " |
| aria-expanded | 7 | " |
| aria-selected | 4 | " |
| aria-orientation | 1 | " |
| aria-label | 0* | " |
| aria-live | 0* | " |
| aria-hidden | 0* | " |
| aria-haspopup | 0* | " |

*\* Not present on seline.so but in the whitelist and found on other sites.*

### Stripped (removed by stage 3)

| Attribute | Count (seline) | Rationale |
|-----------|---------------|-----------|
| class | 1500 | Tailwind/CSS classes — pure styling, largest single source of bloat |
| style | 114 | Inline styles — styling only |
| id | 20 | Element IDs — used for CSS/JS targeting, not content |
| data-state | 213 | Radix UI state tracking |
| data-nimg | 85 | Next.js image optimisation metadata |
| data-orientation | 35 | Radix UI orientation |
| data-radix-collection-item | 11 | Radix UI internal |
| tabindex | 5 | Focus order — not content |
| decoding | 85 | Image decode hint — browser perf, not content |
| loading | 81 | Lazy loading — browser perf |
| width/height | 89/89 | Image dimensions — layout, not content |
| maxlength | 2 | Input length constraint |
| autoplay/playsinline/muted | 1/1/1 | Video playback hints |
| dir | 1 | Text direction — could theoretically matter but not observed in audit issues |
| disabled | 1 | Element state |

### Vercel-specific data-* attributes (all stripped)

Vercel.com has the most data-* attributes (68 unique). All are framework internals:

| Attribute | Count | Purpose |
|-----------|-------|---------|
| data-zone | 87 | Layout zones |
| data-version | 39 | Component versioning |
| data-grid/data-grid-cell/data-grid-cross | 13/28/3 | Grid layout system |
| data-geist-button/tab/badge/tabs | 21/3/1/1 | Geist UI component markers |
| data-prefetch | 22 | Route prefetching |
| data-react-aria-pressable | 21 | React Aria interaction state |
| data-prefix/data-suffix | 21/21 | Button icon slots |
| data-show-focus-ring | 8 | Focus ring styling |
| data-testid | 5 | Test selectors |
| data-cdp-track/scope | 5/1 | Analytics tracking |
| data-marketing-*-button | 2/3 | Marketing variant tracking |

None carry content. Safe to strip universally.

---

## Decision Matrix by Pipeline Stage

### Stage 1: Browser-side JS (`STRIP_HIDDEN_ELEMENTS_SCRIPT`)

| What | Action | Why | Risk |
|------|--------|-----|------|
| `<details>` elements | Open (set `open=true`) | Phase 0: Expands native HTML accordions BEFORE hidden-element stripping so their content is visible. | Low — only affects native `<details>`. |
| `[data-state="closed"]` elements | Flip to `"open"` | Phase 0b: Expands Radix/Headless UI accordion panels. Radix uses CSS attribute selectors so flipping the attr makes panel content visible without triggering React events. | **Medium** — guards required: skips dialog/alertdialog/tooltip/menu/listbox roles, aria-modal, data-radix-tooltip-content, data-radix-dialog-content. Verify via `test-pipeline.ts --live`. |
| `.sr-only`, `.visually-hidden` | Remove | Screen-reader-only text that would create phantom content | Low — these are by definition not visible to users |
| `[aria-hidden="true"]` | Remove | Decorative/duplicate content hidden from AT | Low — follows ARIA spec intent |
| `display:none` elements | Remove | CSS-hidden content (menus, modals, overlays) | **Medium** — Radix accordion content is display:none until expanded. Native `<details>` now handled by Phase 0. |
| `visibility:hidden` elements | Remove | Invisible but layout-occupying elements | Low |
| Zero-size elements | Remove (unless in skipTags) | Elements with 0×0 dimensions | Low — skipTags protects `<br>`, `<wbr>`, `<hr>`, `<img>`, `<input>`, `<svg>`, `<meta>`, `<link>` |
| Clip-hidden elements | Remove | `position:absolute` + `overflow:hidden` + ≤1px — common sr-only pattern | Low |

### Stage 2: Regex strip (`stripHtmlNoise`)

| What | Action | Why | Risk |
|------|--------|-----|------|
| `<script>...</script>` | Remove entirely | JS code — zero content value, huge token cost | None |
| `<style>...</style>` | Remove entirely | CSS rules — irrelevant to text audit. Added 2026-03-19 so `stripHtmlNoise` is safe to call standalone without relying on stage 3 for cleanup. | None |
| `<!--...-->` | Remove | HTML comments — developer notes, not user content | None |
| `<svg ...>...</svg>` | Collapse to `<svg/>` | SVG internals (paths, circles, groups) are visual noise. aria-label/role preserved. | **Low** — inline text inside SVGs would be lost. Rare in practice — SVG text is typically decorative (logos, icons). |

### Stage 3: Cheerio compressor (`compressHtml`)

| What | Action | Why | Risk |
|------|--------|-----|------|
| `<script>`, `<style>`, `<noscript>`, `<template>`, `<head>` | Remove | Defensive repeat of stages 1-2 so compressor works standalone | None |
| Inline SVGs | Collapse to `<svg/>` | Defensive repeat | None |
| `hidden`/`sr-only`/`invisible` on ANY element | Remove (by class, before class strip) | Prevents "stray A" bug — hidden text merging with adjacent content after unwrapping. Widened from span-only to all elements (2026-03-19). | **Low** — responsive pattern `hidden md:flex` would also be removed; stage 1 (browser JS) is the primary guard for responsive elements |
| `class`, `id`, `style`, `data-*`, event handlers | Strip from all elements | Pure styling/framework internals. Class alone is 30-60% of attribute bloat (Tailwind). | **Low** — class names occasionally encode semantic info (e.g. `error`, `active`). Not observed as audit-relevant. |
| Inline formatting tags | Unwrap (keep text) | Bold/italic/underline carry no meaning for content auditing | None — verified via LangSmith across all benchmark sites |
| Bare `<span>` (no aria-*/role) | Unwrap (keep text) | Styling wrapper only | **Low** — span with meaningful content but no ARIA attrs would lose its wrapper. Text preserved. |
| `<span>` with aria-*/role | Keep | Semantic meaning via accessibility attributes | None |
| `data:` URI src values | Replace with `[data-uri]` | Base64 images are enormous (10K-100K+ chars). Placeholder preserves knowledge that an image exists. | None |
| Empty divs (no children, no text) | Remove | Pure structural noise — no content loss | None |
| Single-child divs (no sibling text) | Unwrap | Collapses unnecessary nesting — 60-70% div count reduction on Tailwind SPAs | Low — guards skip divs with `role` or `aria-*` to preserve semantic landmarks |
| Whitespace runs | Collapse to single space | Token savings, no content change | None |
| Whitespace between tags | Remove | Block-level whitespace is layout, not content | None |

---

## Kept Attributes Whitelist

The full list from `KEEP_ATTRS` in `html-compressor.ts`, plus the `aria-*` pattern:

| Attribute | Why kept |
|-----------|---------|
| `href` | Link audit: destinations, broken links, external vs internal |
| `src` | Image/media source identification (data: URIs replaced) |
| `alt` | Accessibility audit: missing/poor alt text is a top finding |
| `title` | Tooltip content — sometimes contains important copy |
| `type` | Distinguishes button/submit/checkbox/email inputs |
| `role` | ARIA landmark roles for accessibility audit |
| `for` | Label-input association for form accessibility |
| `name` | Form field identification |
| `target` | Link behavior (`_blank` opens new tab) — UX audit |
| `lang` | Language declaration — language audit |
| `rel` | Link relationship (noopener, nofollow, canonical) |
| `action` | Form submission URL |
| `method` | Form HTTP method |
| `value` | Pre-filled form values — content worth auditing |
| `placeholder` | Input placeholder text — often has UX issues |
| `colspan`/`rowspan` | Table structure preservation |
| `scope`/`headers` | Table accessibility |
| `inert` | Marks inactive digits in animated number components (e.g. `number-flow-react`). Without it, all 10 digit variants (0-9) read as live content — confirmed source of "placeholder number" false positive on seline.so pricing. |
| `aria-*` (pattern) | All accessibility attributes — essential for a11y audit |

---

## Cross-Site Validation

### Tag presence across sites

Core structural tags are universal. Differences reflect site complexity, not pipeline gaps.

| Tag | seline.so | justcancel.io | vercel.com | dub.co | Pipeline action |
|-----|-----------|--------------|------------|--------|----------------|
| div | 1223 | 45 | 280 | 630 | Kept |
| span | 114 | 114 | 95 | 120 | Unwrapped (bare) / Kept (with aria-*/role) |
| a | 68 | 108 | 89 | 105 | Kept |
| img | 89 | 31 | 23 | 46 | Kept |
| svg | 75 | 2 | 48 | 180 | Collapsed to `<svg/>` |
| button | 51 | 1 | 12 | 13 | Kept |
| p | 2 | 36 | 48 | 43 | Kept |
| h1-h3 | 34 | 12 | 26 | 15 | Kept |
| section | - | 7 | 10 | - | Kept |
| nav | 2 | - | 1 | 2 | Kept |
| strong | - | 8 | 5 | 4 | Unwrapped |
| li | - | 3 | 81 | 49 | Kept |
| ul | - | - | 16 | 8 | Kept |
| input | 2 | 2 | 6 | - | Kept |
| footer | 1 | 1 | 1 | 1 | Kept |

### Attribute stripping consistency

| Pattern | seline.so | justcancel.io | vercel.com | dub.co | Notes |
|---------|-----------|--------------|------------|--------|-------|
| class (top attr by count) | 1500 | 290 | 626 | 980 | All stripped. Largest single source of bloat. |
| style | 114 | 28 | 172 | 99 | All stripped. |
| data-* variants | 8 types | 0 | 38 types | 8 types | All stripped. Vercel has the most framework-specific data attrs. |
| aria-* variants | 5 types | 0 | 6 types | 5 types | All kept. |
| href/src/alt | Present | Present | Present | Present | All kept. |

### Compression effectiveness by site type

| Site type | Example | Reduction | Why |
|-----------|---------|-----------|-----|
| Tailwind SPA | seline.so | 74% | Heavy class attrs, many divs |
| Lightweight static | justcancel.io | 38% | Minimal framework overhead — less to strip |
| Framework-heavy (Geist) | vercel.com | 80% | Many data-* attrs, complex grid system |
| Tailwind + heavy SVGs | dub.co | 78% (98% from raw) | SVG content is the biggest win here |

---

## Known Gaps / Open Questions

### ~~Accordion / collapsed content~~ — RESOLVED (2026-03-19)
**Was:** `display:none` accordion content stripped before model sees it.
**Fix:** Phase 0b in browser JS flips `data-state="closed"` → `"open"` for Radix/Headless UI panels before hidden-element stripping. Phase 0 already handled native `<details>`. Guards prevent flipping dialogs, tooltips, menus. See `STRIP_HIDDEN_ELEMENTS_SCRIPT` in `firecrawl-client.ts`.
**Remaining gap:** Tab content (not accordion) still not expanded — only the active tab panel is visible at scrape time.

### ~~Repeated nav/footer across pages~~ — RESOLVED (2026-03-19)
**Was:** Same nav/footer HTML repeated on every page, burning tokens.
**Fix:** Stage 4 in `formatFirecrawlForPrompt` fingerprints nav/header/footer blocks by first 300 chars of text. Page 2+ matching blocks replaced with `[Same as Page 1]` placeholder. Saves ~10-20% on multi-page audits.

### ~~Large pages truncated at chunk 1~~ — RESOLVED (2026-03-19)
**Was:** Pages >60K post-compression silently dropped chunk 2+.
**Fix:** `compressHtmlToChunks` exports up to 2 chunks. `formatFirecrawlForPrompt` inlines both as "part 1 of 2" / "part 2 of 2". Hard cap at 2 to bound token growth.

### CSS `content` property
**Impact: Low.** Pseudo-elements (`::before`, `::after`) with `content: "..."` are not in the DOM tree — they exist only in CSSOM. The pipeline strips `<style>` tags, so any CSS-injected text is lost. Rare in practice for meaningful content.

### Responsive class loss
**Impact: Resolved.** After compression strips class attributes, Tailwind responsive classes (e.g. `md:hidden`, `lg:block`) are gone. This was a concern for detecting responsive duplicates, but the pipeline now handles it via:
1. Browser-side JS removes `display:none` elements before class stripping
2. Compressor removes `hidden`/`sr-only`/`invisible` spans before class stripping
3. Structural clues (two nav elements, repeated sections) detect remaining duplicates

### SVG inline text
**Impact: Low.** Text inside inline SVGs is lost when SVGs collapse to `<svg/>`. In practice, SVG text is decorative (logos, icon labels). Meaningful text labels should use aria-label (which is preserved).

### Tab content (non-accordion)
**Impact: Low.** Tab panels that aren't the active one are `display:none` at scrape time. Unlike accordions (where Phase 0b opens all panels), tabs require clicking each tab — not attempted. Most sites show the first tab by default, which typically has the most important content.

### `dir` attribute stripping
**Impact: Very low.** The `dir` attribute (text direction) is currently stripped. Could matter for RTL sites, but no RTL sites have been audited to date.

### `width`/`height` on images
**Impact: Very low.** Image dimensions are stripped. Could theoretically be useful for detecting oversized/undersized images, but this isn't part of the current audit scope.
