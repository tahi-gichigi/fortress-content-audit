# Eval Baseline — Two-Pass Checker

---

## Run 2: HTML Compression + Full-HTML Checker (current)

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
