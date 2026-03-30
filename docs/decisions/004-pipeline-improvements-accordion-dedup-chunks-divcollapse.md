# ADR-004: Pipeline improvements — accordion recovery, nav dedup, multi-chunk, div collapse

**Date:** 2026-03-19
**Status:** Accepted
**Context:** Content coverage gaps and token efficiency identified after Natalie's structured benchmark test (2026-03-18)

---

## Problem

Four gaps remained after ADR-002's pipeline hardening:

1. **Radix/Headless UI accordion content silently lost.** FAQ answers, pricing plan details, and comparison content hidden behind `data-state="closed"` panels were stripped by Phase 2 (computed style) before the model ever saw them. Native `<details>` was already handled (Phase 0, ADR-001) but Radix uses CSS attribute selectors, not the HTML `open` attribute.

2. **Pages >60K post-compression dropped chunks 2+.** `compressHtmlWithLogging` returned only `chunks[0]`, silently discarding content on large pages. No warning in the prompt; model had no way to know content was missing.

3. **Nav/footer HTML repeated across every scraped page.** Same structural chrome burned tokens redundantly on every page in a multi-page audit. No deduplication existed.

4. **Excessive div nesting added structural noise.** Tailwind SPAs produce deeply nested single-child div trees (1,223 divs on seline.so homepage) that carry no semantic value for auditing. Each wrapper div adds ~10 chars; at scale this is meaningful token waste.

---

## Decisions

### 1. Radix accordion expansion (Phase 0b)

**File:** `lib/firecrawl-client.ts` — `STRIP_HIDDEN_ELEMENTS_SCRIPT`

Before Phase 1 (class-based removal), query all `[data-state="closed"]` elements and flip to `"open"`. Radix's CSS (`[data-state="closed"] { display: none }`) then makes panel content visible to `getComputedStyle` in Phase 2 — without triggering React event handlers.

Guards to prevent surfacing off-screen content from non-accordion Radix components:
- Skip elements with `role` in `{dialog, alertdialog, tooltip, menu, menuitem, listbox}`
- Skip elements with `aria-modal="true"`
- Skip elements with `data-radix-tooltip-content` or `data-radix-dialog-content`

Force reflow (`void document.body.offsetHeight`) after flipping so Phase 2's `getComputedStyle` sees the updated layout.

### 2. Multi-chunk content in prompt

**Files:** `lib/html-compressor.ts`, `lib/firecrawl-adapter.ts`, `lib/audit-prompts.ts`

Export `compressHtmlToChunks()` alongside `compressHtmlWithLogging`. When compressed page exceeds 60K, split at semantic section boundaries and return up to **2 chunks** (hard cap — prevents runaway token growth on pathological pages).

`formatFirecrawlForPrompt` calls `compressHtmlToChunks` and inlines both chunks as `"Content (HTML, part 1 of 2)"` / `"part 2 of 2"` sub-sections. Single-chunk pages are unaffected — output identical to before.

All 4 auditor prompt functions updated to note: *"Large pages may appear as 'part 1 of 2' / 'part 2 of 2' — treat them as one continuous page."*

Checker stays on `compressHtmlWithLogging` (chunk 1 only) — cost impact is auditor-only.

### 3. Nav/footer dedup across pages

**File:** `lib/firecrawl-adapter.ts` — `formatFirecrawlForPrompt`

Before the page loop, initialise `seenBlocks = new Set<string>()`. After compressing each page, fingerprint `nav`, `header`, `footer` elements by their first 300 chars of normalised text (`tag:text.slice(0,300)`). On match, replace element with `<tag>[Same as Page 1]</tag>`. On first occurrence, store fingerprint.

The 300-char window means a single word difference (e.g. a per-page CTA change) prevents false dedup. Element manifest continues to run on raw HTML — unaffected.

### 4. Empty and single-child div collapse

**File:** `lib/html-compressor.ts` — `compressHtml`

After span unwrapping, traverse all `div` elements in reverse DOM order (bottom-up, so children collapse before parents). Unwrap a div if:
- It has no `role` or `aria-*` attributes (guards semantic landmarks like `role="main"`, `aria-label="navigation"`)
- AND either: it has no children and no direct text (→ remove), or it has exactly one child element and no direct sibling text (→ unwrap)

---

## Verification

### Pipeline test (`test-pipeline.ts`)

40/40 checks passing (offline + live). Key live results on seline.so:

| Check | Result |
|-------|--------|
| `data-state="closed"` in live raw HTML | **0** — Phase 0b ran in browser, all panels already flipped before HTML returned |
| Nav dedup placeholder on page 2 (pricing) | **Found** |
| Compression ratio (seline.so homepage) | **80%** (161KB → 32KB) |
| Div count reduction | **64%** (1,223 → 441) |

### Pro audit (19 pages, seline.so, 2026-03-19)

12 issues found, all verified correct:

| # | Severity | Issue |
|---|----------|-------|
| 1 | low | "monitize" → "monetize" in FAQ |
| 2 | low | "just couple minutes away" → "just a couple of minutes away" |
| 3 | low | "23x times lighter" → "23x lighter" |
| 4 | **critical** | Free plan contradiction across home letter, FAQs (6+ pages), and comparison pages ("$14/month after free tier") |
| 5 | **critical** | Pricing inconsistency: $9/month (comparison pages) vs $14/month (seline-vs-amplitude) vs $24/month (pricing page) |
| 6 | medium | "Find the your checkout flow drop-offs" — duplicate article |
| 7 | medium | Shopify analytics card: "no setup required" for revenue tracking contradicts docs (requires Stripe or custom events) |
| 8 | medium | Cookie FAQ says "does not use cookies" but install docs describe optional first-party cookie modes |
| 9 | low | "immidiately" → "immediately" in docs |
| 10 | low | "Wordpress" → "WordPress" in nav |
| 11 | low | "item: added to card" → "item: added to cart" |
| 12 | low | "Using html data attributes" → "Using HTML data attributes" |

**Zero false positives** from Natalie's prior benchmark list. Issues 4, 5, 7, and 8 required accordion content and cross-page synthesis — none would have been findable before Phase 0b.

`immidiately` on `/docs/install-seline` (previously flagged as a possible hallucination — see memory) is confirmed real: the docs page was included in this run and the text is present in the raw HTML.

---

## Alternatives considered

**Click-to-expand script for accordions.** Dispatching synthetic click events on accordion triggers was considered and rejected: React's synthetic event system requires a real browser interaction to propagate through component state — simulating a click at the DOM level doesn't reliably open Radix panels. Attribute flip is simpler and more reliable.

**3+ chunks for large pages.** Hard cap is 2. Beyond 2 chunks the token cost grows faster than the quality gain — the two-pass checker only ever sees chunk 1, so chunk 3+ content would be audited but not verifiable. This is an acceptable trade-off until a smarter chunking strategy is warranted.

**Fingerprint nav/footer by full text (not 300 chars).** A full-text fingerprint would be more conservative but requires more memory and is slower on large navs. 300 chars is sufficient — any meaningful nav difference (new CTA, active page highlight) will appear in the first 300 chars.

---

## Addendum (2026-03-20): Auditor prompt clarity improvements

### Problem

Run 6 evaluation (65 issues, 19 pages) revealed that the auditor's issue descriptions were often vague due to hard word count caps (`≤15 words` for description, `≤8 words` for suggested fix). Since the checker does NOT rewrite descriptions — only filters and gates — the auditor's exact wording is what reaches the user.

Example: `"clarity: Repeated greetings block feels redundant and distracting"` — doesn't tell the user which pages, what block, or how many times. The checker confirmed it but couldn't improve the wording.

### Changes

1. **Removed `verbosity: "low"` from pro auditor API params** (`lib/audit.ts` line 1031, `lib/brand-voice-audit.ts` line 187). The low verbosity setting actively suppressed output detail on the pass that feeds directly into user-facing results.

2. **Replaced word count caps with structural format rules** in `buildLiberalCategoryAuditPrompt`:
   - Old: `"impact label + problem in 15 words or fewer"`, `"action verb + fix in 8 words or fewer"`
   - New: `"quote the exact text, state the problem, name the pages if cross-page. Be specific — vague descriptions waste the user's time."` and `"what to change and how, in one clear sentence"`

3. **Added cross-page specificity instruction**: `"When flagging repeated or redundant content, list the specific pages where it appears and how many times."`

4. **Trimmed manifest over-prompting**: Condensed the "HOW TO USE THE MANIFEST" section from 3 lines to 1. The liberal prompt receives pre-fed HTML, not web_search results — the "audit thoroughly / don't reduce exploration" language was irrelevant.

### Expected impact

- Auditor output tokens will increase slightly (~10-20% more output per call) but input tokens are unchanged
- Issue descriptions will be more specific and actionable for end users
- Cross-page issues like "greetings banner on every page" will name the affected pages
- Free tier prompts unchanged — cost and brevity matter there

### Not changed

- Checker prompt and params — `reasoning: { effort: "low" }` stays, checker is fast and focused
- Free tier auditor prompts — word caps kept for cost control
- `reasoning: null` on pro auditor — high recall doesn't need reasoning

---

## Files changed

| File | Change |
|------|--------|
| `lib/firecrawl-client.ts` | Phase 0b: Radix accordion expansion in `STRIP_HIDDEN_ELEMENTS_SCRIPT` |
| `lib/html-compressor.ts` | Div collapse pass in `compressHtml`; export `compressHtmlToChunks` |
| `lib/firecrawl-adapter.ts` | Nav/footer dedup in `formatFirecrawlForPrompt`; multi-chunk output |
| `lib/audit-prompts.ts` | Multi-chunk note; liberal prompt: word caps → structural format, specificity instruction, trimmed manifest section |
| `lib/audit.ts` | Removed `verbosity: "low"` from pro auditor API params |
| `lib/brand-voice-audit.ts` | Removed `verbosity: "low"` from brand voice API params |
| `lib/__tests__/html-compressor.test.ts` | Div collapse tests; `compressHtmlToChunks` tests |
| `lib/__tests__/firecrawl-adapter.test.ts` | Nav/footer dedup tests (new file) |
| `lib/__tests__/two-pass-checker.test.ts` | Updated liberal prompt test: specificity over word caps |
| `test-pipeline.ts` | New pipeline inspection harness (35 checks, offline + live modes) |
| `docs/html-stripping-reference.md` | Updated pipeline overview, decision matrices, resolved gaps |
| `docs/eval-baseline.md` | Run 5 (Natalie baseline) and Run 6 (ADR-004 eval) documented |

---

## Addendum (2026-03-27): Systemic fixes round 2 + eval harness

### Systemic fixes (PR #6)

Seven fixes addressing issues found during QA round 2 (Notion 7edda1f2):

| Fix | Area | Change |
|-----|------|--------|
| A | Health score | Clamp `Math.max(0, ...)` instead of `Math.max(1, ...)` — zero issues = 100, not 99 |
| B | Checker fail-safe | Missing verification defaults to `confirmed=false` (was true) — unverified issues no longer slip through |
| C | Page selector | Deterministic scoring heuristic; 18-prefix foreign language filter (`/es/`, `/fr/`, `/de/`...) |
| D | Link crawler | 403/401 after GET fallback → status `'ok'` (inconclusive), not broken |
| E | HTML compressor | Badge detection moved before attribute stripping (was no-op); inline tag spacing on unwrap; zero-width character verification |
| F | Audit prompts | Severity rubric (critical/medium/low definitions + examples); category rename `Links & Formatting` → `Formatting` |
| G | Nav dedup | Fingerprint includes hrefs: `tag:text:hrefs.join(',')` — prevents false dedup on navs with same text but different links |

**Badge fix (E)**: `compressHtml` had badge detection at line ~133, after attribute stripping at ~112. Since classes were already stripped, the regex `badge|tag|label|chip|pill|status|tier|plan` never matched. Moved badge detection before attribute stripping. Confirmed via test: `<span class="badge">New</span>Feature` → `[Badge: New]Feature`.

**Test suite**: 56 new tests in `lib/__tests__/systemic-fixes-round2.test.ts` covering all 7 fixes. 3 existing tests updated for category rename and fail-safe default change. Total: 239 passing.

### Eval harness (`scripts/eval-quality.ts`)

LangSmith-integrated quality evaluation harness. Runs the production two-pass pipeline on benchmark sites and scores against curated ground truth.

**Ground truth** (`scripts/eval-ground-truth.json`): 5 benchmark sites (seline.so, dub.co, plausible.io, justcancel.io, beehiiv.com) with 14 known real issues and 13 false positive patterns, curated from QA testing and eval runs 1-6.

**Metrics scored per-site:**
- **Recall**: known issues found / total known issues
- **Precision**: 1 - (issues matching FP patterns / total reported)
- **Severity accuracy**: correct severity / matched issues
- **Issue count**, cost, duration

**LangSmith integration**: Creates a `content-audit-quality` dataset, runs `evaluate()` with per-example evaluators (recall, precision, severity, issue count) and summary evaluators (weighted recall/precision across sites). Results appear as experiments in the `aicontentaudit` project.

**CLI:**
```
npx tsx scripts/eval-quality.ts                    # all sites
npx tsx scripts/eval-quality.ts --site seline.so   # single site
npx tsx scripts/eval-quality.ts --dry-run           # local only, skip LangSmith
npx tsx scripts/eval-quality.ts --no-crawl          # use cached HTML
```

**Files added/changed:**

| File | Change |
|------|--------|
| `scripts/eval-quality.ts` | New: LangSmith eval harness |
| `scripts/eval-ground-truth.json` | New: curated ground truth for 5 benchmark sites |
| `lib/__tests__/systemic-fixes-round2.test.ts` | New: 56 tests for fixes A-G |
| `lib/__tests__/two-pass-checker.test.ts` | Updated: category rename, fail-safe default |
| `lib/html-compressor.ts` | Fix: badge detection moved before attribute stripping |
| `.gitignore` | Added eval-quality-*.json and scripts/.eval-cache/ |
