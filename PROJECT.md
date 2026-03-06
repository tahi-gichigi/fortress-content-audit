# Fortress Content Audit - Project Rules

## Fortress-Specific Rules

### Forbidden
- **NEVER use example.com as a test domain** - use real domain names from the project context
- Never hallucinate API keys, event names, or property names - check existing code first

### Audit Quality Philosophy
- **Fewer issues, higher confidence** — it's better to miss an edge case than to report false positives. Users lose trust in the tool when it flags things that aren't real issues.
- **Link auditing is internal-only** — only flag internal navigation links that are broken or point to the wrong page. Never flag mailto:, tel:, or external links as broken — AI models can't verify these from markdown and they're almost always fine on the live site.
- **Extraction artifacts are not issues** — Firecrawl's HTML-to-markdown conversion strips whitespace between adjacent HTML elements (e.g., `<span>The</span><span>simple</span>` becomes `Thesimple`). The prompts in `lib/audit-prompts.ts` include explicit caveats telling models to ignore these. If similar artifact patterns emerge, fix at the prompt level, not by modifying the crawled content.
- **HTML-direct is the future** — Validated approach: feed cleaned raw HTML (after strip-hidden-elements JS) directly to models instead of markdown. Eliminates extraction artifacts entirely. See ADR-001 for details. The strip script must preserve zero-dimension inline tags (`<br>`, `<img>`, `<svg>`, etc.).

### Testing
- **For AI prompt or model/API changes: always run a real end-to-end audit test before pushing to prod** — prompt wording directly affects output quality and regressions are invisible without live testing
- Always test: PDF export, Supabase/PostHog/OpenAI integrations, auth flows, DB migrations

### Analytics & Tracking (PostHog)
- Feature flags: Use enums/const objects, keep usage centralized
- Custom properties used 2+ times: Store in enum/const object
- Naming convention: `UPPERCASE_WITH_UNDERSCORE` for flag/property names
- Gate flag-dependent code with validation checks
- Before creating event/property names, check for existing naming conventions

---

## Project Overview
Content audit SaaS platform built with Next.js, Supabase, and AI integrations. Helps brands audit website content for quality, consistency, and clarity issues.

## Key Technologies
- **Frontend:** Next.js 15, React 19, TypeScript, Tailwind CSS
- **Backend:** Next.js API routes, Supabase (PostgreSQL), Supabase Auth
- **PDF Export:** Client-side html2pdf.js
- **Analytics:** PostHog
- **AI:** OpenAI API (gpt-5.1-2025-11-13 via Responses API)
- **Tracing:** LangSmith (`aicontentaudit` project) — enabled on production via Vercel env vars

## Project Structure
- `/app` - Next.js app router pages and API routes
- `/lib` - Utility functions, helpers, and services
- `/components` - React components
- `/types` - TypeScript type definitions
- `.claude/commands/` - Claude Code slash commands

## Useful Commands
- `/check` - Review implementation critically
- `/rating` - Rate an implementation
- `/deslop` - Remove AI-generated code bloat
- `/kill` - Kill all Next.js dev servers
- `/push-to-github` - Push to GitHub with clear commit
- `/vlow` - Reminder to keep verbosity low
- `/confidence` - Rate confidence in assessment

## Architecture Decisions
Recorded in `docs/decisions/` as numbered ADRs. Check these before making changes to the content extraction pipeline.
- [ADR-001](docs/decisions/001-strip-hidden-elements-before-extraction.md) — Strip hidden DOM elements before Firecrawl markdown extraction

## Audit Architecture

### Tiers
- **FREE** → `parallelMiniAudit` — 3 category models + optional brand voice, 5 pages, 10 tool calls
- **PAID** → `parallelProAudit` — same structure, 20 pages, 30 tool calls
- **ENTERPRISE** → `auditSite` sequential + brand voice pass, 60 tool calls

### Issue Persistence (cross-audit context)
Each re-audit feeds two context blocks into the model prompts:
- **`# Active Issues`** — active issues from the most recent prior audit (via `getActiveIssues`). Model verifies if they still exist.
- **`# Previously Resolved/Ignored Issues`** — resolved/ignored issues across all prior audits (via `getExcludedIssues`). Model is told not to report these again.

Both are filtered by category before being injected (so the Language model only sees Language context). Confirmed working end-to-end via LangSmith token delta (Language prompt is ~190 tokens larger than Facts/Links due to category-filtered excluded issues).

### Preset → Brand Voice Profile Handling (`app/api/audit/route.ts`)
The `preset` param from the picker controls how the brand voice profile is built:
- **No DB profile** → synthetic profile built from picker options
- **`preset=custom` + existing DB profile** → picker options OVERRIDE the DB profile for fields the picker controls (`flag_ai_writing`, `readability_level`, `locale`, `formality`). Voice summary, enabled, keywords preserved from DB.
- **`preset=full` + existing DB profile** → augment with readability + AI detection defaults if not set
- **`preset=quick`** → disable brand voice pass entirely

### Test Scripts
- `test-issue-persistence.ts` — DB-level verification of getExcludedIssues/getActiveIssues queries
- `test-e2e-persistence.ts` — Full E2E: marks issues resolved, runs real prod audit, verifies context in traces
  - Uses `supabase.auth.admin.generateLink` + `anonClient.auth.verifyOtp` to get a bearer token without a password

## Important URLs
- Production: https://usefortress.vercel.app
- Supabase Admin URL: Check `.env.local`
- LangSmith: https://smith.langchain.com → project `aicontentaudit`
- PostHog Dashboard: Check project settings
