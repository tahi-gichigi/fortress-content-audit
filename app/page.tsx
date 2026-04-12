import { SiteFooter } from "@/components/SiteFooter"

/**
 * Static private alpha landing page.
 * No active audit functionality - just describes what Fortress does
 * and signals that it's in private alpha. Auth/dashboard routes still
 * exist but aren't linked from here.
 */
export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="container mx-auto px-6 py-24 md:py-32">
        <div className="max-w-3xl mx-auto text-center">
          {/* Private Alpha badge - prominent so visitors immediately understand the status */}
          <span className="inline-block mb-6 px-4 py-1.5 text-xs font-medium uppercase tracking-widest rounded-full border border-foreground/20 bg-foreground/5 text-foreground/70">
            Private Alpha
          </span>

          <h1 className="font-serif text-6xl md:text-7xl lg:text-8xl font-light tracking-tight text-balance mb-8">
            Fortress
          </h1>

          <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed text-balance mb-6 max-w-2xl mx-auto">
            AI-powered content auditing for websites
          </p>

          <p className="text-base md:text-lg text-muted-foreground/80 leading-relaxed text-balance max-w-2xl mx-auto">
            Fortress crawls your website, reads every page the way a user would, and finds the issues nobody notices: pricing contradictions, broken CTAs, stale dates, naming inconsistencies, factual conflicts. Built by Mooch.
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section className="border-t border-border py-24 md:py-32">
        <div className="container mx-auto px-6">
          <div className="max-w-3xl mx-auto">
            <h2 className="font-serif text-3xl md:text-4xl font-light tracking-tight text-center mb-16">
              How it works
            </h2>

            <div className="grid gap-10 md:gap-12">
              {/* Each feature: bold label + description. No icons - let the copy do the work. */}
              <Feature
                title="Multi-agent architecture"
                description="Parallel category-specific auditors - Language, Facts & Consistency, Formatting - for thorough coverage across every dimension of your content."
              />
              <Feature
                title="Two-pass verification"
                description="A liberal auditor flags candidates, then a precision checker verifies each finding against the source HTML. Low noise, high signal."
              />
              <Feature
                title="Bot protection bypass"
                description="Firecrawl integration handles JS-rendered and bot-protected sites so nothing is missed."
              />
              <Feature
                title="Semantic HTML compression"
                description="Intelligent preprocessing that preserves audit-relevant content while stripping noise, so the AI focuses on what matters."
              />
              <Feature
                title="Cross-page contradiction detection"
                description="Compares claims, pricing, and product names across every page on the site. Catches the inconsistencies that manual review misses."
              />
              <Feature
                title="Severity-graded reports"
                description="Critical, High, Medium, Low - with concrete fix recommendations for every issue found."
              />
              <Feature
                title="LangSmith observability"
                description="Full tracing on every audit for cost tracking and quality monitoring. Complete visibility into what the system is doing."
              />
              <Feature
                title="Deterministic page selection"
                description="Heuristic scoring prioritises the most important pages on any site, so audits cover what matters first."
              />
              <Feature
                title="Eval harness"
                description="Curated ground truth benchmarks for ongoing quality measurement. The system is tested against real-world data, not vibes."
              />
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}

/** Simple feature row - title + description, no frills */
function Feature({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold mb-1.5">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">{description}</p>
    </div>
  )
}
