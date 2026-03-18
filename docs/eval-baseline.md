# Eval Baseline — Two-Pass Checker

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
