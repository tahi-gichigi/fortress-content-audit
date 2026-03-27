# ADR-002: Two-pass pipeline — liberal auditor + model checker with HTML compression

**Date:** 2026-03-12
**Status:** Accepted
**Context:** Pro tier audit quality and cost

## Problem

Single-pass auditing with a conservative prompt missed real issues (low recall). Single-pass with a liberal prompt produced too many false positives (low precision). Snippet extraction for the checker introduced a separate failure mode: when the extractor couldn't locate quoted text in the HTML, the checker received fallback context (often just nav HTML) and dropped real issues — seline.so had 0/22 snippet matches for Links & Formatting.

## Decision

### Two-pass pipeline
1. **Auditor pass** — liberal prompt ("when in doubt, include it"), 3 parallel category calls (Language / Facts & Consistency / Links & Formatting), model: `gpt-5.1-2025-11-13`, `reasoning: null`. Maximises recall.
2. **Checker pass** — 3 parallel per-category calls, each receives full compressed HTML for every page with issues in that category (same context the auditor saw). Model: `gpt-5.1-2025-11-13`, `reasoning: { effort: "low" }`. Drops `confirmed=false` or `confirmed=uncertain` + confidence <0.7.

### HTML compression (`lib/html-compressor.ts`)
Strip class/id/style/data-* attributes, unwrap inline formatting tags (`<strong>`, `<em>`, `<b>`, `<i>`, `<u>`, bare `<span>` etc. — auditing never needs bold/italic context), collapse SVGs to placeholders. Typically 60-91% size reduction on Tailwind pages.

**Fix (2026-03-19): Remove visually-hidden spans before class stripping.**
Tailwind's `hidden`, `sr-only`, and `invisible` classes make elements visually hidden. Before this fix, class stripping + span unwrapping merged their text content into adjacent text — e.g. `Add to your website<span class="hidden md:block">A</span>` became `"Add to your websiteA"`, which the auditor and checker both confirmed as a real stray-character issue. The fix adds a pass before attribute stripping that removes `<span>` elements whose `class` contains `hidden`, `sr-only`, or `invisible` as a whole word. Found via Natalie's seline.so test (2026-03-18). Verified end-to-end with the production Firecrawl client.

### Full HTML to checker (not snippets)
Checker receives full compressed page HTML, not extracted snippets. Eliminates the entire class of "snippet extractor couldn't locate the text" false drops. `lib/snippet-extractor.ts` has been deleted — it is no longer part of the codebase.

### Checker decision logic (`lib/checker-decisions.ts`)
Pure function `applyCheckerDecisions()` encodes the acceptance rule: keep issues where `confirmed=true`, or `confirmed=uncertain` with `confidence >= 0.7`. Extracted as a pure function so it can be unit-tested independently of the model calls. Tests in `lib/__tests__/two-pass-checker.test.ts`.

## Alternatives considered

- **Snippet extraction for checker** — rejected. 41-60% snippet match rate on benchmark sites meant checker frequently worked blind, dropping real issues.
- **Single-pass conservative** — rejected. Missed cross-page contradiction issues (pricing vs FAQ, etc.).
- **Single-pass liberal** — rejected. 40-60% false positive rate before this work.

## Results (benchmark, 4 sites)

- Avg confidence of surviving issues: ≥ 0.98 on 3/4 sites
- Drop rate (checker rejections): <25% — checker is precision gate, not a blunt filter
- Inline tag stripping: seline.so auditor tokens 130K → 102K (22% reduction, $0.21/site saved)
- See `docs/eval-baseline.md` Run 2 and Run 3 for full numbers

## Cost profile

~$0.93-1.14/site (6 calls × ~100-136K input tokens × $1.25/M). Checker dominates at ~70% of total once auditor is cheap. See ADR-003 for failed attempt to reduce auditor cost.
