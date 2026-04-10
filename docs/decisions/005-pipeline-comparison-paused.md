# ADR-005: Pipeline comparison paused — switching to Notion AI web search approach

**Date:** 2026-04-10
**Branch:** `eval/secondhome-comparison`
**Status:** Paused

---

## What we were doing

Head-to-head comparison of two content audit pipelines on secondhome.io:
- **Compressed HTML** — strips and compresses raw HTML before sending to GPT-5.1
- **Annotated text** — converts HTML to structured markdown with semantic annotations

The goal was to pick a winner and codify it in this ADR.

## What happened

The comparison script (`scripts/compare-pipelines.ts`) ran successfully on seline.so (20 pages) as a validation run. It got through the crawl and auditor phase, but the checker step hung.

**LangSmith trace analysis (10 Apr 2026):**

The checker calls are the problem. Two failure modes found:

1. **First attempt:** checker ran with `max_output_tokens: 4500`. With `effort: medium` reasoning, the model spent all 4,500 tokens on chain-of-thought (`<reasoning>`) before writing any output text. `output_text` was empty. Response status: `incomplete`.

2. **Retry attempt:** token budget bumped to 16,000-32,000. Three checker calls launched in parallel (one per issue category), each with ~270K characters (~67K tokens) of context. All three showed `status: pending` in LangSmith and never returned. Killed after 30+ minutes.

**Root cause:** the checker is fed the full HTML content alongside the issues list. At 67K input tokens plus effort:medium reasoning, each call runs 15-20 minutes minimum. Three in parallel with API concurrency makes this impractical.

The code fixes applied in this branch (bugs 1 and 2 from Task 3b) are correct and should be kept:
- `formatFirecrawlForPrompt` now properly accepts `{ useAnnotatedText?: boolean }` — without this, both pipelines were getting identical compressed HTML and the comparison was measuring LLM variance, not pipeline differences
- Checker polling window bumped from 120s to 600s
- `maxOutputTokens` for checker bumped from `min(16000, max(4000, n*150))` to `min(32000, max(16000, n*500))`
- `reasoning: null` comment added on the auditor explaining the liberal-auditor approach

## Why we're pausing

A simpler approach is producing good results without the infrastructure cost. Notion AI running web search audits directly in the workspace is yielding actionable content issues with far less setup. See new approach links below.

The compressed HTML vs annotated text question is still worth answering eventually, but not at the cost of the current checker architecture. The checker context problem (feeding full HTML to the checker) is the real bottleneck and needs a redesign before this comparison produces meaningful results.

## What would be needed to resume

1. **Fix the checker context.** The checker should receive the issues list + targeted page excerpts (the specific HTML sections relevant to each issue), not the full 20-page HTML dump. This would cut checker input from ~67K tokens to ~5-10K per call.

2. **Consider async background runs.** At this scale, the comparison should probably run as a background job with results written to a file, not a blocking CLI script.

3. **Simpler architecture option.** If we strip the multi-category parallelism and run one category at a time with a smaller page set (5-10 pages), the checker becomes manageable without the redesign.

## New direction

- **Web search audit output (Second Home):** https://www.notion.so/tahi/Second-Home-Content-Audit-33d804529ed08132aaf0f03ae0b28a9b
- **Notion AI Content Audit skill:** https://www.notion.so/tahi/Notion-Skill-Content-Audit-a9ff64f0c01a499ab66c394ddc06c374

## Branch state

All code changes from Task 3b are committed and pushed on `eval/secondhome-comparison`. The branch is clean and safe to pick up later. Do not merge to main — this is a comparison experiment, not a production change.
