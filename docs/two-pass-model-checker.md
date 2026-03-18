# Two-Pass Model Checker: Research & Test Results

> **SUPERSEDED** - This is a historical research spike. The production implementation differs in several ways:
> - Model is `gpt-5.1-2025-11-13`, not `gpt-5.2` (spike used gpt-5.2 which didn't ship)
> - Checker is grouped by **category**, not by page
> - `formatFirecrawlForPromptMarkdown` referenced below no longer exists
> - See [ADR-002](decisions/002-two-pass-checker-with-html-compression.md) for the final production design

---

## Overview

A research spike to evaluate a two-pass audit architecture: a fast no-reasoning **audit pass** that sweeps for issues, followed by a low-reasoning **checker pass** that verifies each issue against the raw HTML evidence before surfacing it.

The goal: higher precision with fewer false positives, at acceptable cost/latency.

---

## Architecture

```
Crawl → pages (HTML + markdown)
          │
          ├── Audit pass (gpt-5.1 [spike used gpt-5.2, production uses gpt-5.1-2025-11-13], no reasoning, 3 categories parallel)
          │     └── Raw issues (broad, may include hallucinations)
          │
          └── Checker pass (gpt-5.1 [spike used gpt-5.2, production uses gpt-5.1-2025-11-13], reasoning: low, grouped by page)
                └── Verified issues (confirmed with HTML evidence + confidence score)
```

The checker receives the cleaned page HTML alongside all raw issues for that page. It returns `confirmed: true/false`, a confidence score (0–1), and a quoted HTML evidence snippet for each issue.

**Variant A (HTML audit):** Both audit and checker receive cleaned HTML.
**Variant B (Markdown audit):** Audit receives markdown, checker receives HTML.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/firecrawl-adapter.ts` | Added `stripHtmlNoise()` (removes scripts, comments, verbose SVGs); updated `formatFirecrawlForPrompt()` to use cleaned HTML; added `formatFirecrawlForPromptMarkdown()` for variant B testing |
| `lib/audit.ts` | Added `verifyIssuesAgainstHtml()` — regex-based post-audit filter that drops issues where model-quoted text doesn't appear in source HTML. Strips HTML comments before searching (so filter sees same content as model). Applied to all category + brand voice issues in `parallelMiniAudit()`. Link validation issues skip this filter (already verified by crawler). |
| `test-two-pass-audit.ts` | New test script. Crawls 3 sites once, runs both variants in parallel, runs checker on each, prints comparison table, saves JSON results. |

---

## Test Results (3 sites, gpt-5.1 [spike used gpt-5.2, production uses gpt-5.1-2025-11-13])

| Site | Pages | Variant | Audit tokens | Checker tokens | Total | Raw issues | Verified | Drop rate |
|------|-------|---------|-------------|----------------|-------|------------|----------|-----------|
| secondhome.io | 6 | **A (HTML)** | 86,097 | 22,728 | **108,825** | 27 | **20** | 26% |
| secondhome.io | 6 | B (MD) | 0* | 0 | 0 | 0 | 0 | — |
| justcancel.io | 18 | **A (HTML)** | 268,158 | 66,349 | **334,507** | 35 | **20** | 43% |
| justcancel.io | 18 | B (MD) | 116,260 | 88,892 | **205,152** | 41 | 14 | 66% |
| youform.com | 20 | **A (HTML)** | 276,171 | 68,995 | **345,166** | 29 | **25** | 14% |
| youform.com | 20 | B (MD) | 170,352 | 81,003 | **251,355** | 51 | 20 | 61% |

*secondhome.io Variant B failed — all 3 audit categories errored (likely timeout on 84.8s markdown audit pass).

---

## Key Findings

### HTML audit is more precise
Drop rates of 14–43% vs 61–66% for markdown. HTML gives the model structural context (element types, attribute values, class names) that markdown strips away, so it hallucinates less.

### Markdown finds more raw issues — most are noise
41–51 raw issues vs 27–35 for HTML. The checker rejects ~2/3 of markdown issues. Net verified: HTML wins or ties on all sites (25 vs 20 youform, 20 vs 14 justcancel, secondhome B failed).

### Token cost: HTML is heavier in the audit pass, lighter in the checker
HTML audit uses 1.5–2.4x more tokens per audit (HTML is verbose). But fewer issues means cheaper checker passes. On youform: A uses 345k total vs B 251k — HTML is more expensive overall but produces cleaner results.

### Speed
Audit pass: 13–22s (HTML) vs 15–25s (MD). Checker: 6–12s per variant. Total per site: ~20–35s after crawl.

---

## Manual Spot-Check (10 issues, Firecrawl MCP)

9/10 confirmed genuine, 1 partial:

| Issue | Verdict |
|-------|---------|
| secondhome.io — `tel:` empty href on "Contact Us" | ✅ `href="tel:"` confirmed in HTML |
| secondhome.io — Logo link has no visible text | ✅ Confirmed |
| justcancel.io — Hero uses "just fucking cancel" | ✅ Confirmed |
| justcancel.io — "1,189+ services" vs "1,100+" conflict | ✅ Body uses 1,189+, meta/OG tags use 1,100+ — real inconsistency |
| justcancel.io/calculator — Buttons use `color:#ccc` (low contrast) | ✅ Confirmed in inline styles |
| justcancel.io/calculator — "Empty `<select>` looks broken" | ⚠️ Select has /mo /yr /wk options in static HTML; may be dynamic render state |
| justcancel.io/calculator — "15-20% cheaper" tip | ✅ Confirmed |
| youform.com/about — "AWS servers in EU" missing article | ✅ Confirmed |
| youform.com/about — ALL-CAPS PROFITABLE/WILL + empty alt text | ✅ All confirmed |
| youform.com/templates — "Frequently Asked Question" (singular) | ✅ Confirmed |

---

## Recommendation

**Use HTML+HTML two-pass for the Pro tier.**

- Higher precision (fewer false positives surfaced to users)
- Evidence-backed issues (checker returns HTML snippet + confidence score)
- The checker pass enables a richer UI: show the exact HTML snippet that proves the issue
- Free tier can remain single-pass (no checker) for speed/cost

### Open questions before production use
1. **Cost model** — inline token costs are `$0.00` (gpt-5.1 [spike used gpt-5.2, production uses gpt-5.1-2025-11-13] pricing not in SDK). Need actual pricing to evaluate per-audit cost.
2. **Checker prompt tuning** — the checker occasionally rejects valid issues (the `<select>` case). May need a leniency adjustment for dynamic-render issues.
3. **Secondhome.io B failure** — investigate why all 3 markdown audit categories timeout/error at ~85s. May be token limit on large markdown payloads.

---

## Related Files
- `test-two-pass-results-1773108498737.json` — full results from the final 3-site test run
- `docs/decisions/001-strip-hidden-elements-before-extraction.md` — extraction pipeline decisions
