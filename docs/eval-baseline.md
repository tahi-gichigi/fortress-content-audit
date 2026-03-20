# Eval Baseline — Two-Pass Checker

---

## Run 6: ADR-004 Pipeline Improvements — Full Production Eval

**Run date:** 2026-03-20 12:14 UTC
**Environment:** Local dev server (`pnpm dev`), `?tier=PAID` override
**Site:** seline.so (PAID tier, 19 pages)
**Pipeline:** Two-pass (3 auditor + 3 checker calls), gpt-5.1 throughout
**Code state:** All ADR-004 changes active: div collapse, nav/footer dedup, multi-chunk, Phase 0b (Radix accordion), hidden-class widening, inert attr preservation, whitespace collapse fix, dynamic content prompt rules.

### LangSmith-verified metrics

**Auditor calls (3 parallel, gpt-5.1):**

| Call | Input tokens | Output tokens | Cache read | Cost | Category |
|------|-------------|--------------|-----------|------|----------|
| Auditor 1 | 86,278 | 2,761 | 0 | $0.135 | Facts & Links |
| Auditor 2 | 86,314 | 1,019 | 0 | $0.118 | Language |
| Auditor 3 | 86,234 | 3,828 | 3,456 | $0.142 | Brand voice |
| **Subtotal** | **258,826** | **7,608** | **3,456** | **$0.395** | |

**Checker calls (3 parallel, gpt-5.1, reasoning: low):**

| Call | Input tokens | Output tokens | Cost |
|------|-------------|--------------|------|
| Checker 1 | 58,129 | 1,569 | $0.088 |
| Checker 2 | 77,491 | 3,854 | $0.135 |
| Checker 3 | 77,695 | 3,658 | $0.134 |
| **Subtotal** | **213,315** | **9,081** | **$0.357** | |

### Head-to-head: Run 6 vs Run 5 (Natalie's baseline)

| Metric | Run 5 (baseline) | Run 6 (ADR-004) | Change |
|--------|-----------------|-----------------|--------|
| Auditor input tokens | 336,712 | 258,826 | **-23%** |
| Checker input tokens | 331,936 | 213,315 | **-36%** |
| Total input tokens | ~668K | ~472K | **-29%** |
| Auditor cost | $0.511 | $0.395 | -23% |
| Checker cost | $0.524 | $0.357 | -32% |
| **Total cost** | **$1.04** | **$0.75** | **-28%** |
| Auditor wall time (parallel) | ~65s | ~41s | **-37%** |
| Checker wall time (parallel) | ~57s | ~43s | -25% |
| **Total model time** | **~122s** | **~84s** | **-31%** |
| Prompt cache hits | 0 | 3,456 tokens | Cache starting to fire |
| Checker calls | 4 | 3 | -1 |
| Issues returned | unknown | 65 | — |
| Pages audited | 19 | 19 | — |

### Token savings breakdown

Per-call auditor input dropped from ~112K to ~86K (23% reduction). Sources:
- **Div collapse**: 64% fewer div elements (1,223 → 441 on homepage). Removes empty/single-child div nesting that Tailwind SPAs produce. Each eliminated div saves ~10 chars of tags.
- **Nav/footer dedup**: Identical nav/header/footer blocks on pages 2+ replaced with `<tag>[Same as Page 1]</tag>`. On seline.so's 19 pages, the ~2K-char nav block is transmitted once instead of 19 times.
- **Multi-chunk**: Large pages no longer silently truncated at chunk 1 — all content reaches the model, so the model finds more issues per page (partially explains higher issue count).

### Quality comparison

**False positive eliminated:** Run 5's checker confirmed `"Add to your websiteA"` as a real issue (confidence 0.99) — the stray-A bug where a hidden keyboard-shortcut span was unwrapped into adjacent text. Run 6 does NOT contain this false positive. The hidden-class widening fix in ADR-004 prevents the span from being unwrapped.

**Issue count: 65 (Run 6) vs unknown (Run 5).** The higher count in Run 6 is expected:
1. Phase 0b exposes accordion/FAQ content that was previously invisible — more content → more issues found
2. Multi-chunk ensures large pages aren't truncated — same effect
3. Many of the 65 issues are low-severity style opinions (e.g. "slightly wordy", "sounds informal for docs") that the checker confirmed but a human reviewer might dismiss
4. Several issues are the same template text repeated across pages (e.g. "monitize" appears on 6 pages) — the checker correctly confirms each occurrence independently

**Genuine new finds in Run 6 (from accordion content):**
- "Wait a coupe minutes" typo on `/docs/stripe` (FAQ content)
- "20/80 rule" should be "80/20 rule" on `/seline-vs-posthog`
- Pricing inconsistencies across comparison pages ($9 vs $14 vs $24)
- Cookie FAQ contradiction vs install docs

### Caveats

1. **Run 5 issue count unknown.** Natalie's run returned issues to the frontend, but I don't have the final filtered count from LangSmith (only per-call outputs). Direct issue-count comparison not possible.
2. **Checker call count differs.** Run 5 had 4 checker calls; Run 6 had 3. This means one category had zero issues in Run 6 (or the pipeline structure changed). Accounts for ~$0.09-0.15 of the cost difference.
3. **Local vs production.** Run 5 was Vercel production; Run 6 was local `pnpm dev`. Network latency and cold-start differences don't affect model call times but may affect total audit wall time.
4. **Site content may have changed.** 1-2 days between runs. Minor — seline.so unlikely to have major copy changes overnight.

---

## Run 5: Natalie's Production Baseline (pre-ADR-004 pipeline improvements)

**Run date:** 2026-03-18 21:23 UTC
**Deployed commit:** `73ebd86` (Vercel production)
**Site:** seline.so only (PAID tier, 19 pages)
**Pipeline:** Two-pass (3 auditor + 4 checker calls), gpt-5.1 throughout
**Code state:** Run 3 pipeline (inline tag stripping + HTML compression). Does NOT include any ADR-004 changes: no div collapse, no nav/footer dedup, no multi-chunk, no Phase 0b (Radix accordion expansion), no hidden-class widening, no inert attr preservation, no whitespace collapse fix.

This is the **current production baseline** — the last real user pro audit before ADR-004 pipeline improvements were implemented. All ADR-004 changes should be measured against this run.

### LangSmith-verified metrics

**Auditor calls (3 parallel, gpt-5.1):**

| Call | Input tokens | Output tokens | Reasoning | Cost | Category |
|------|-------------|--------------|-----------|------|----------|
| Auditor 1 | 112,130 | 5,374 | 2,517 (low) | $0.194 | Brand voice |
| Auditor 2 | 112,309 | 623 | 0 (none) | $0.147 | Facts & Links |
| Auditor 3 | 112,273 | 2,997 | 0 (none) | $0.170 | Language |
| **Subtotal** | **336,712** | **8,994** | | **$0.511** | |

**Checker calls (4 parallel, gpt-5.1, reasoning: low):**

| Call | Input tokens | Output tokens | Cost |
|------|-------------|--------------|------|
| Checker 1 | 64,560 | 1,107 | $0.092 |
| Checker 2 | 83,020 | 2,335 | $0.127 |
| Checker 3 | 92,155 | 3,810 | $0.153 |
| Checker 4 | 92,201 | 3,644 | $0.152 |
| **Subtotal** | **331,936** | **10,896** | **$0.524** |

| Metric | Value |
|--------|-------|
| Total input tokens | ~668K |
| Total output tokens | ~20K |
| Total cost (auditor + checker) | **~$1.04** |
| Page selector cost | ~$0.001 |
| **Grand total** | **~$1.04** |
| Duration (auditor start → last checker end) | ~122s |
| Prompt cache hits | 0 (all `cache_read: 0`) |

### Key observation: per-call input tokens are nearly identical

All 3 auditor calls received ~112K input tokens — the full compressed HTML of all 19 pages is repeated in every category call. This is the primary cost driver and the target for nav/footer dedup.

### Known false positives in this run

Natalie's structured test identified the following false positive root causes that were present in this deployed code. These were subsequently fixed in ADR-004:

| False Positive | Root Cause | Fix (ADR-004) |
|---------------|------------|---------------|
| "Placeholder number" in seline.so pricing | `inert` attr stripped → all 10 animated digits visible as content | `inert` added to KEEP_ATTRS |
| "time on page 0 seconds" | Dynamic counter captured at scrape-time zero state | Prompt rule: don't flag interactive component values |
| "secure0n*d" garbled text | Text animation captured mid-render | Prompt rule: don't flag garbled text in isolated elements |
| Parameter list mixes label/type | Model misreading form structure | Prompt rule: don't flag developer tooling UI |
| "DubRead more" (dub.co test) | Whitespace collapse regex `>\s+<` too aggressive | Replaced with newline/tab-only collapse |
| Stray "A" character (dub.co test) | Hidden span unwrapped into adjacent text | Hidden-class check widened to all elements |

### Content blind spots in this run

Accordion/FAQ content behind `data-state="closed"` panels was silently stripped by Phase 2 (computed style → display:none). The model never saw FAQ answers, preventing it from finding cross-page contradictions like the "free to start" vs "no free plan" conflict that ADR-004's Phase 0b later revealed.

### Why this is the baseline for ADR-004

1. **Same site** (seline.so) — directly comparable to the ADR-004 evaluation run
2. **Same tier** (PAID, 19 pages) — same page count and selection
3. **Same models** (gpt-5.1 auditor + checker) — no model variable
4. **Production deployment** — real user-facing code, not a test harness
5. **All ADR-004 changes are absent** — clean before/after comparison

### Caveats for comparison to ADR-004 Run 6

1. **Site content may change** between runs — seline.so may have updated copy
2. **Page selection is non-deterministic** — gpt-4.1-mini may pick slightly different pages
3. **ADR-004 adds div collapse + nav dedup** — expected to significantly reduce input tokens per call, which would lower cost even without changing the model or pipeline structure
4. **ADR-004 adds Phase 0b** — accordion content will now be visible, which may increase raw issue count (more content = more findings) but should improve quality (fewer blind spots)

---

---
---

# EARLIER EVAL RUNS (pre-production, eval script against 4 benchmark sites)

Runs 1-4 below used the `eval-*.ts` eval script against 4 benchmark sites (secondhome.io, justcancel.io, youform.com, seline.so). These measured the two-pass architecture during development. Run 5 above is the first production baseline.

---

## Run 4: gpt-5-mini Auditor (rejected - see ADR-003)

**Run date:** 2026-03-13
**Eval file:** `eval-results-1773417257766.json`
**Branch:** `feature/two-pass-model-checker`
**Change:** Pro auditor switched from `gpt-5.1-2025-11-13` → `gpt-5-mini`

### Hypothesis
gpt-5-mini at ~12% of gpt-5.1 input cost handles the liberal auditor pass well enough because:
- Auditor is high-recall (finds everything, even false positives)
- gpt-5.1 checker is the precision gate — it filters bad findings downstream
- Lower reasoning capability of mini doesn't matter; auditor uses `reasoning: null`

### Expected savings
~88% reduction on auditor calls (3 of the 6 calls per site).
Total site cost should drop from ~$0.93-1.14 to ~$0.30-0.45.

### Results

| Site | Pages | OLD raw→filtered (drop) | NEW raw→filtered (drop) | Checker rejected | Avg conf |
|------|-------|------------------------|------------------------|-----------------|----------|
| secondhome.io | 19 | 52→52 (0%) | 86→61 (29%) | 25 | 0.98 |
| justcancel.io | 17 | 28→20 (28%) | 62→37 (40%) | 25 | 0.96 |
| youform.com | 20 | 36→31 (13%) | 27→14 (48%) | 13 | 0.90 |
| seline.so | 19 | 40→28 (30%) | 86→64 (25%) | 22 | 0.98 |

### vs Run 3

| Site | Run 3 drop | Run 4 drop | Run 3 rejected | Run 4 rejected |
|------|-----------|-----------|----------------|----------------|
| secondhome.io | 4% | 29% | 2 | 25 |
| justcancel.io | 23% | 40% | 10 | 25 |
| youform.com | 0% | 48% | 0 | 13 |
| seline.so | 0% | 25% | 0 | 22 |

Drop rate up significantly on all sites — mini is a noisier auditor. The checker is working correctly (rejections are FPs based on evidence), but checker now dominates pipeline cost.

### Cost (from LangSmith traces, Run 4)

| Call type | Tokens/call | Cost/call | vs Run 3 |
|-----------|-------------|-----------|----------|
| Auditor (gpt-5-mini) | ~100-136K | ~$0.028-0.035 | **~6-7x cheaper** |
| Checker (gpt-5.1) | ~77-100K | ~$0.09-0.15 | unchanged |

| Site | Cost/site | vs Run 3 |
|------|-----------|---------|
| seline.so | ~$0.49 | -47% ($0.44 saved) |
| youform.com | ~$0.54 | -53% ($0.60 saved) |

- 3 auditor calls: ~$0.08-0.11/site (was ~$0.51-0.63 in Run 3)
- 3 checker calls: ~$0.27-0.45/site (checker now dominates at ~70-80% of total cost)
- **Total reduction: ~55% vs Run 2 ($1.14 → ~$0.50)**

### Quality assessment

- **Checker is doing its job correctly** — rejections are genuine FPs (e.g. claiming multiple HubSpot forms when only one exists, flagging responsive duplicates that are CSS-hidden not real duplicates)
- **youform recall concern**: 27 raw issues vs 22 in Run 3 — but only 14 survived checker (vs 22 in Run 3). The raw count is similar; the higher drop rate (48%) suggests mini is generating more marginal issues that checker rejects. Some real issues may be getting bundled with FPs and dropped as a batch.
- **Avg confidence high** (0.90-0.98) — checker is not uncertain, it's actively rejecting issues it can disprove
- **Cost-quality trade-off**: ~55% cost reduction, checker rejection rate up 10-15x. Quality of surviving issues appears similar (avg conf ≥ 0.90) but raw miss rate is unknown without manual ground truth review.

### Notable
- secondhome.io: checker correctly rejected "multiple HubSpot forms" x8 — mini audited the compressed HTML and couldn't see the JS-rendered form count correctly
- All 4 sites still ≥ 0.90 avg confidence on surviving issues
- Checker bottleneck: to cut costs further, needs cheaper checker or fewer checker pages

---

## Run 3: Cost Optimisation (inline tag stripping + no manifest in checker + prompt caching) (current)

**Run date:** 2026-03-12
**Branch:** `feature/two-pass-model-checker`
**Code state:** Three cost-reduction optimisations layered on top of Run 2

### What changed since Run 2
1. **Inline formatting tags stripped** (`lib/html-compressor.ts`): `<strong>`, `<em>`, `<b>`, `<i>`, `<u>`, `<s>`, `<span>` (bare), `<font>`, `<bdt>`, `<bdo>`, and other formatting-only wrappers are now unwrapped — text preserved, tags removed. Confirmed via LangSmith: no audit issue has ever relied on bold/italic/underline context.
2. **Element manifest removed from checker** (`lib/firecrawl-adapter.ts`): `formatPagesForChecker` no longer appends the element manifest. The checker only needs compressed HTML to verify issues exist — manifest was redundant and added ~15-20% token overhead.
3. **Manifest moved to prompt prefix** (`lib/audit-prompts.ts`): `buildLiberalCategoryAuditPrompt` now puts the full site HTML manifest FIRST (before category instructions). All 3 parallel category calls share an identical prefix, enabling OpenAI prompt caching on calls 2 and 3.

### Future cost reduction options (higher risk, not yet implemented)
- **Option 4: Deduplicate nav/footer** — same nav appears on every page, wasting tokens. Strip repeated sections across pages. ~10-20% savings, medium risk (detection reliability).
- **Option 5: gpt-4.1-mini for auditor** — cheaper model, checker catches quality drop. ~40% savings, medium-high risk (needs eval to validate recall doesn't degrade). Note: Run 4 tested `gpt-5-mini` (a different model) for this same idea — rejected due to high variance. See ADR-003.

### Results

| Site | Pages | OLD raw→filtered (drop) | NEW raw→filtered (drop) | Checker rejected | Avg conf |
|------|-------|------------------------|------------------------|-----------------|----------|
| secondhome.io | 20 | 87→61 (30%) | 51→49 (4%) | 2 | 0.99 |
| justcancel.io | 17 | 24→15 (38%) | 44→34 (23%) | 10 | 0.98 |
| youform.com | 19 | 20→12 (40%) | 22→22 (0%) | 0 | 0.92 |
| seline.so | 19 | 72→62 (14%) | 55→55 (0%) | 0 | 0.99 |

### vs Run 2

| Site | Run 2 drop | Run 3 drop | Change |
|------|-----------|-----------|--------|
| secondhome.io | 3% | 4% | +1pp (flat) |
| justcancel.io | 11% | 23% | +12pp — checker correctly rejected 10 FP issues |
| youform.com | 3% | 0% | -3pp (improved) |
| seline.so | 17% | 0% | **-17pp (big improvement)** |

### Cost (from LangSmith traces, Run 3)

| Site | Input tokens/call | Cost/site | vs Run 2 |
|------|------------------|-----------|---------|
| seline.so | ~102K | ~$0.93 | -18% ($0.21 saved) |
| youform.com | ~136K | ~$1.14 | flat |

- Inline tag stripping reduces token counts on formatting-heavy pages (seline: 130K → 102K = 22% reduction)
- Element manifest removed from checker: checker calls are 16% smaller (~77K vs estimated ~92K)
- Prompt caching: barely firing in practice. Parallel calls can't benefit from each other's cache. Only 2/24 runs had non-zero `cache_read` (seline Facts checker: 36K tokens, youform: 6K tokens). The manifest-first restructure helps for sequential re-audits of the same site within the cache window.

### Compression ratios (Run 3)

Inline tag stripping added ~5-15pp on top of Run 2 attribute stripping:
- seline.so: 53-74% (was ~60-77% in Run 2)
- youform.com: 57-91% (91% on template-heavy pages with lots of inline formatting)
- justcancel.io: 28-56%
- secondhome.io: similar range

### Notable
- seline.so stray "A" issues (CTA text "Add to your websiteA") — real bugs, confirmed at 1.0 confidence
- justcancel.io 10 checker rejections: formatting-only issues where HTML whitespace made evidence ambiguous (confirmed=false/uncertain) — correct rejects
- youform.com checker drop rate 0%: all 22 issues had clear HTML evidence

---

## Run 2: HTML Compression + Full-HTML Checker

**Run date:** 2026-03-12
**Eval file:** `eval-results-1773317152769.json`
**Code state:** Per-category checker + semantic HTML compression (`lib/html-compressor.ts`)
**Branch:** `feature/two-pass-model-checker`

### What changed since Run 1
- Checker now receives full cleaned HTML (same context as auditor) instead of extracted snippets
- `lib/html-compressor.ts`: strips `class`/`id`/`style`/`data-*`, collapses SVGs, strips data URIs → 40-77% size reduction
- Hard truncation limit raised from 14K → 60K chars; DOM-aware chunking handles pages still over limit
- Snippet match rate eliminated as a concern (no longer using snippet extraction)

### Results

| Site | Pages | OLD raw→filtered (drop) | NEW raw→filtered (drop) | Avg conf |
|------|-------|------------------------|------------------------|----------|
| secondhome.io | 18 | 41→36 (12%) | 29→28 (3%) | 0.99 |
| justcancel.io | 17 | 27→25 (7%) | 36→32 (11%) | 0.98 |
| youform.com | 19 | 36→36 (0%) | 72→70 (3%) | 0.83 |
| seline.so | 19 | 65→43 (34%) | 92→76 (17%) | 0.98 |

### vs Run 1 (snippet-extraction era)

| Site | Run 1 drop | Run 2 drop | Change |
|------|-----------|-----------|--------|
| secondhome.io | 17% | 3% | **-14pp** |
| justcancel.io | 47% | 11% | **-36pp** |
| youform.com | 0% | 3% | +3pp |
| seline.so | 42% | 17% | **-25pp** |

seline.so drop rate halved (42% → 17%). justcancel.io drop rate cut by 3/4. Both had low snippet match rates in Run 1 that caused false drops.

### Notable
- DOM chunking fired on `justcancel.io/cancel`: 513K raw → 130K compressed → 2 chunks
- youform.com raw issues nearly doubled (36 → 72) — auditor now seeing more page content
- All sites avg confidence ≥ 0.83; 3 of 4 sites ≥ 0.98

### Accuracy verification (Firecrawl spot-check)
- Checker confirmed "IP adresses", "Key takeway", "Using html data attributes" at confidence 1.0 — all verified real via Firecrawl
- The eval's original `droppedByChecker` metric was misleading — it compared OLD vs NEW pipeline wording, not actual checker decisions. Fixed in eval script (now tracks `checkerRejected` vs `onlyInOld`/`onlyInNew`)
- Reasoning effort "low" is sufficient; `summary: "auto"` added for LangSmith debugging

### Cost (from LangSmith traces)
- Per call: ~130K input tokens, ~$0.17-$0.22
- Per site (6 calls): ~$1.14
- Full 4-site eval: ~$4.56
- No prompt caching active (`cache_read: 0`) — restructuring prompts to enable it is the top cost reduction priority

---

## Run 1: Per-category checker, snippet extraction (baseline)

**Last full eval run:** 2026-03-10T16:28:33Z
**Eval file:** `eval-results-1773160113362.json`
**Code state:** Per-page checker (OLD) — pre per-category refactor
**4 sites, sequential run**

---

## Results by Site

| Site | Pages | OLD raw→filtered (drop) | NEW raw→filtered (drop) | Avg conf | Snippet match | New discoveries | Dropped |
|------|-------|------------------------|------------------------|----------|---------------|-----------------|---------|
| secondhome.io | 18 | 1→0 (100%) | 46→38 (17%) | 0.97 | 59% | 38 | 0 |
| justcancel.io | 17 | 19→14 (26%) | 30→16 (47%) | 0.82 | 60% | 15 | 13 |
| youform.com | 20 | 11→10 (9%) | 7→7 (0%) | 0.94 | 86% | 5 | 8 |
| seline.so | 19 | 16→4 (75%) | 38→22 (42%) | 0.97 | 45% | 21 | 3 |

## Aggregate

| Metric | Value |
|--------|-------|
| Avg drop rate — OLD regex | 53% |
| Avg drop rate — NEW checker | 27% |
| Avg confidence (NEW filtered) | 0.93 |
| Total new discoveries (NEW vs OLD) | 79 |
| Total dropped by checker | 24 |

## Warnings
- secondhome.io: snippet_match_rate=59% — below 70% target
- justcancel.io: snippet_match_rate=60% — below 70% target
- youform.com: drop_rate_new=0 — checker did nothing (liberal≈precision?)
- seline.so: snippet_match_rate=45% — below 70% target

## LangSmith Observations (per-page era)
- Checker calls for Links & Formatting issues were largely 1-issue-per-call
- Many returned `uncertain` confidence 0.4 because snippet fell back to nav preview HTML
- Pattern: `"Provided HTML only shows nav links"` — snippet extractor failing on non-quoted issues
- Large Language calls (12k tokens, 9 issues) returned high-confidence confirmed results
- This confirmed the per-category refactor would consolidate calls and expose cross-page context

## Notes for Next Run (per-category code)
Expected changes vs this baseline:
- Checker calls: 3/site (one per category) instead of N/site (one per page with issues)
- Cross-page contradiction issues (Facts & Consistency) should now survive checker
- Snippet match rate should be unchanged (extraction logic identical)
- Drop rate may change: consolidation means checker sees more context per call
- Watch: secondhome.io discovered 38 issues from near-zero with OLD — verify these survive per-category checker intact
