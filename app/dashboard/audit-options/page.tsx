"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createClient } from "@/lib/supabase-browser"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"
import { Badge } from "@/components/ui/badge"
import { Loader2, X } from "lucide-react"
import { VALID_READABILITY, VALID_FORMALITY } from "@/lib/brand-voice-constants"

export default function AuditOptionsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const domain = searchParams.get("domain")?.trim() || null

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [saveTimeout, setSaveTimeout] = useState<NodeJS.Timeout | null>(null)
  const initialLoadDone = useRef(false)
  const userChangedSomething = useRef(false)

  const [plan, setPlan] = useState<string>("free")
  const [autoWeeklyEnabled, setAutoWeeklyEnabled] = useState(false)
  const [autoWeeklyLoading, setAutoWeeklyLoading] = useState(false)

  const [readabilityLevel, setReadabilityLevel] = useState<string>("")
  const [formality, setFormality] = useState<string>("")
  // locale is null/"" when off (model infers); "en-GB"/"en-US" when on
  const [locale, setLocale] = useState<string>("")
  const [localeEnabled, setLocaleEnabled] = useState(false)
  const [readabilityEnabled, setReadabilityEnabled] = useState(false)
  const [formalityEnabled, setFormalityEnabled] = useState(false)
  const [flagKeywords, setFlagKeywords] = useState<string[]>([])
  const [ignoreKeywords, setIgnoreKeywords] = useState<string[]>([])
  const [flagKeywordsEnabled, setFlagKeywordsEnabled] = useState(false)
  const [ignoreKeywordsEnabled, setIgnoreKeywordsEnabled] = useState(false)
  const [flagKeywordInput, setFlagKeywordInput] = useState("")
  const [ignoreKeywordInput, setIgnoreKeywordInput] = useState("")
  const [flagAiWriting, setFlagAiWriting] = useState(false)
  const [includeLongform, setIncludeLongform] = useState(false)

  const loadSettings = useCallback(async (token: string) => {
    if (!domain) return
    const res = await fetch(`/api/brand-voice?domain=${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      if (res.status === 401) router.replace("/auth/sign-in")
      return
    }
    const data = await res.json()
    if (data) {
      const r = data.readability_level ?? ""
      setReadabilityLevel(r)
      setReadabilityEnabled(!!r)
      const f = data.formality ?? ""
      const formalityMap: Record<string, string> = {
        very_casual: "casual",
        casual: "casual",
        neutral: "neutral",
        formal: "formal",
        very_formal: "formal",
      }
      setFormality(formalityMap[f] || f || "")
      setFormalityEnabled(!!f)
      // locale is stored as "en-GB" or "en-US"; empty/null means off (model infers)
      const savedLocale = data.locale || ""
      setLocale(savedLocale)
      setLocaleEnabled(!!savedLocale)
      const fk = Array.isArray(data.flag_keywords) ? data.flag_keywords : []
      const ik = Array.isArray(data.ignore_keywords) ? data.ignore_keywords : []
      setFlagKeywords(fk)
      setIgnoreKeywords(ik)
      setFlagKeywordsEnabled(fk.length > 0)
      setIgnoreKeywordsEnabled(ik.length > 0)
      setFlagAiWriting(data.flag_ai_writing === true)
      setIncludeLongform(!!data.include_longform_full_audit)
    }
  }, [domain, router])

  const loadPlanAndScheduled = useCallback(async (token: string) => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.id) return
    const { data: profile } = await supabase.from("profiles").select("plan").eq("user_id", user.id).maybeSingle()
    setPlan(profile?.plan || "free")
    if (profile?.plan !== "pro" && profile?.plan !== "enterprise") return
    try {
      const res = await fetch("/api/audit/scheduled/settings", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        const list = data.scheduledAudits || []
        const forDomain = list.find((sa: { domain: string }) => sa.domain === domain)
        setAutoWeeklyEnabled(forDomain?.enabled === true)
      }
    } catch (e) {
      console.error("[AuditOptions] Load scheduled:", e)
    }
  }, [domain])

  useEffect(() => {
    if (!domain) {
      router.replace("/dashboard")
      return
    }
    const init = async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        router.replace("/auth/sign-in")
        return
      }
      setAuthToken(session.access_token)
      setLoading(true)
      await loadSettings(session.access_token)
      await loadPlanAndScheduled(session.access_token)
      setLoading(false)
    }
    init()
  }, [domain, router, loadSettings, loadPlanAndScheduled])

  const autoSave = useCallback(async (data: {
    readability: string | null
    formality: string | null
    locale: string | null
    flagKeywords: string[]
    ignoreKeywords: string[]
    flagAiWriting: boolean
    includeLongform: boolean
  }) => {
    if (!authToken || !domain) return
    setSaving(true)
    try {
      const res = await fetch("/api/brand-voice", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          domain,
          readability_level: data.readability,
          formality: data.formality,
          locale: data.locale,
          flag_keywords: data.flagKeywords,
          ignore_keywords: data.ignoreKeywords,
          flag_ai_writing: data.flagAiWriting,
          include_longform_full_audit: data.includeLongform,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast({ title: "Save failed", description: err.error || "Could not save.", variant: "destructive" })
        // Revert to server state on failure
        await loadSettings(authToken)
        return
      }
      // No success toast for these toggles — silent save
    } finally {
      setSaving(false)
    }
  }, [authToken, domain, toast, loadSettings])

  useEffect(() => {
    if (loading) return
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      return
    }
    if (saveTimeout) clearTimeout(saveTimeout)
    const timeout = setTimeout(() => {
      autoSave({
        readability: readabilityEnabled ? readabilityLevel || null : null,
        formality: formalityEnabled ? formality || null : null,
        // null when off means the auditor infers language from site content
        locale: localeEnabled ? locale || null : null,
        flagKeywords: flagKeywordsEnabled ? flagKeywords : [],
        ignoreKeywords: ignoreKeywordsEnabled ? ignoreKeywords : [],
        flagAiWriting: flagAiWriting,
        includeLongform,
      })
    }, 500)
    setSaveTimeout(timeout)
    return () => clearTimeout(timeout)
  }, [readabilityLevel, formality, locale, localeEnabled, flagKeywords, ignoreKeywords, flagKeywordsEnabled, ignoreKeywordsEnabled, flagAiWriting, includeLongform, readabilityEnabled, formalityEnabled, loading, autoSave])

  const toggleAutoWeekly = async (enabled: boolean) => {
    if (!authToken || !domain) return
    setAutoWeeklyLoading(true)
    try {
      const res = await fetch("/api/audit/scheduled/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ domain, enabled }),
      })
      if (res.ok) {
        setAutoWeeklyEnabled(enabled)
        const data = await res.json()
        const nextRun = data.scheduledAudit?.next_run
          ? new Date(data.scheduledAudit.next_run).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : null
        toast({
          title: enabled ? `Auto weekly enabled for ${domain}` : `Auto weekly disabled for ${domain}`,
          description: enabled && nextRun ? `Next audit: ${nextRun}.` : enabled ? "Domain will be audited automatically every week." : "Auto weekly audits are off.",
        })
      } else {
        const err = await res.json().catch(() => ({}))
        toast({ title: "Could not save", description: err.error || "Try again.", variant: "destructive" })
      }
    } catch (e) {
      toast({ title: "Could not save", description: "Try again.", variant: "destructive" })
    } finally {
      setAutoWeeklyLoading(false)
    }
  }

  if (!domain) return null
  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const addFlagKeyword = () => {
    const v = flagKeywordInput.trim()
    if (v && v.length <= 100 && !v.includes("\n") && !/^\s+$/.test(v)) {
      userChangedSomething.current = true
      setFlagKeywords((prev) => [...prev, v])
      setFlagKeywordInput("")
    }
  }
  const addIgnoreKeyword = () => {
    const v = ignoreKeywordInput.trim()
    if (v && v.length <= 100 && !v.includes("\n") && !/^\s+$/.test(v)) {
      userChangedSomething.current = true
      setIgnoreKeywords((prev) => [...prev, v])
      setIgnoreKeywordInput("")
    }
  }
  const removeFlagKeyword = (i: number) => {
    userChangedSomething.current = true
    setFlagKeywords((prev) => prev.filter((_, j) => j !== i))
  }
  const removeIgnoreKeyword = (i: number) => {
    userChangedSomething.current = true
    setIgnoreKeywords((prev) => prev.filter((_, j) => j !== i))
  }

  const showAutoWeekly = plan === "pro" || plan === "enterprise"

  return (
    <div className="container mx-auto max-w-4xl px-6 py-8">
      <div className="mb-8">
        <p className="text-muted-foreground mb-1">{domain}</p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight">Audit settings</h1>
        <p className="text-sm text-muted-foreground mt-2">Scope and writing style to check during audits</p>
      </div>

      <div className="space-y-12">
        {/* Scope */}
        <section>
          <h2 className="font-serif text-2xl font-semibold mb-4">Scope</h2>
          <div className="space-y-4">
            {showAutoWeekly && (
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                <div>
                  <Label htmlFor="auto_weekly" className="cursor-pointer font-medium">Auto weekly</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">Runs an audit for this domain every week automatically.</p>
                </div>
                {autoWeeklyLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground shrink-0" />
                ) : (
                  <Switch
                    id="auto_weekly"
                    checked={autoWeeklyEnabled}
                    onCheckedChange={toggleAutoWeekly}
                  />
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4 rounded-md border border-border p-4">
              <div className="flex-1 min-w-0">
                <Label htmlFor="include_longform" className="cursor-pointer font-medium">
                  Include blog/article pages
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  Adds /blog, /articles, etc. to the audit. More pages, longer run.
                </p>
              </div>
              <Switch
                id="include_longform"
                checked={includeLongform}
                onCheckedChange={(v) => {
                  userChangedSomething.current = true
                  setIncludeLongform(v)
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
              <div>
                <Label htmlFor="flag_ai_writing" className="cursor-pointer font-medium">Flag AI patterns</Label>
                <p className="text-sm text-muted-foreground mt-1">Flags content that shows several AI-writing patterns together.</p>
              </div>
              <Switch
                id="flag_ai_writing"
                checked={flagAiWriting}
                onCheckedChange={(v) => {
                  userChangedSomething.current = true
                  setFlagAiWriting(v)
                }}
              />
            </div>
          </div>
        </section>

        {/* Writing Standards */}
        <section>
          <h2 className="font-serif text-2xl font-semibold mb-4">Writing standards</h2>
          <p className="text-sm text-muted-foreground mb-6">Intended style to audit against</p>

          {/* Spelling standard — off means model infers from site content */}
          <div className="rounded-md border border-border p-4 mb-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="locale_toggle" className="cursor-pointer font-medium">Spelling standard</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {localeEnabled
                    ? "Audit against the chosen English variant"
                    : "Off - model infers from site content"}
                </p>
              </div>
              <Switch
                id="locale_toggle"
                checked={localeEnabled}
                onCheckedChange={(v) => {
                  userChangedSomething.current = true
                  setLocaleEnabled(v)
                  // Default to British when first enabling
                  if (v && !locale) setLocale("en-GB")
                }}
              />
            </div>
            {localeEnabled && (
              <div className="mt-4 flex flex-wrap gap-2">
                {[
                  { value: "en-GB", label: "British" },
                  { value: "en-US", label: "American" },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      userChangedSomething.current = true
                      setLocale(value)
                    }}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      locale === value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="readability_toggle" className="cursor-pointer font-medium">Readability</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">Flags content that doesn’t match the chosen reading level.</p>
                </div>
                <Switch
                  id="readability_toggle"
                  checked={readabilityEnabled}
                  onCheckedChange={(v) => {
                    userChangedSomething.current = true
                    setReadabilityEnabled(v)
                    if (!v) setReadabilityLevel("")
                  }}
                />
              </div>
              {readabilityEnabled && (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: VALID_READABILITY[0], label: "Grade 6–8" },
                      { value: VALID_READABILITY[1], label: "Grade 10–12" },
                      { value: VALID_READABILITY[2], label: "13+" },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          userChangedSomething.current = true
                          setReadabilityLevel(value)
                        }}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          readabilityLevel === value
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-muted"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="formality_toggle" className="cursor-pointer font-medium">Formality</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">Flags content that doesn’t match the chosen tone.</p>
                </div>
                <Switch
                  id="formality_toggle"
                  checked={formalityEnabled}
                  onCheckedChange={(v) => {
                    userChangedSomething.current = true
                    setFormalityEnabled(v)
                    if (!v) setFormality("")
                  }}
                />
              </div>
              {formalityEnabled && (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: VALID_FORMALITY[0], label: "Formal" },
                      { value: VALID_FORMALITY[1], label: "Neutral" },
                      { value: VALID_FORMALITY[2], label: "Casual" },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          userChangedSomething.current = true
                          setFormality(value)
                        }}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          formality === value
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-muted"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Keyword Rules */}
        <section>
          <h2 className="font-serif text-2xl font-semibold mb-4">Keyword Rules</h2>
          <p className="text-sm text-muted-foreground mb-6">Flag specific terms in content</p>

          <div className="space-y-6">
            <div className="rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="flag_keywords_toggle" className="cursor-pointer font-medium">Flag keywords</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">Flags these terms wherever they appear (e.g. old product names, banned phrases).</p>
                </div>
                <Switch
                  id="flag_keywords_toggle"
                  checked={flagKeywordsEnabled}
                  onCheckedChange={(v) => {
                    userChangedSomething.current = true
                    setFlagKeywordsEnabled(v)
                  }}
                />
              </div>
              {flagKeywordsEnabled && (
                <div className="mt-4 space-y-3">
                  {flagKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {flagKeywords.map((k, i) => (
                        <Badge key={i} variant="secondary" className="gap-1 pr-1">
                          {k}
                          <button type="button" onClick={() => removeFlagKeyword(i)} className="rounded-full hover:bg-muted-foreground/20 p-0.5" aria-label={`Remove ${k}`}>
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="flag_keywords_input"
                      placeholder="Add term"
                      value={flagKeywordInput}
                      onChange={(e) => setFlagKeywordInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addFlagKeyword())}
                      maxLength={100}
                      className="max-w-[200px]"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={addFlagKeyword}>Add</Button>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="ignore_keywords_toggle" className="cursor-pointer font-medium">Ignore keywords</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">Don’t flag these terms (e.g. allowed variants, known misnomers).</p>
                </div>
                <Switch
                  id="ignore_keywords_toggle"
                  checked={ignoreKeywordsEnabled}
                  onCheckedChange={(v) => {
                    userChangedSomething.current = true
                    setIgnoreKeywordsEnabled(v)
                  }}
                />
              </div>
              {ignoreKeywordsEnabled && (
                <div className="mt-4 space-y-3">
                  {ignoreKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {ignoreKeywords.map((k, i) => (
                        <Badge key={i} variant="secondary" className="gap-1 pr-1">
                          {k}
                          <button type="button" onClick={() => removeIgnoreKeyword(i)} className="rounded-full hover:bg-muted-foreground/20 p-0.5" aria-label={`Remove ${k}`}>
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="ignore_keywords_input"
                      placeholder="Add term"
                      value={ignoreKeywordInput}
                      onChange={(e) => setIgnoreKeywordInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addIgnoreKeyword())}
                      maxLength={100}
                      className="max-w-[200px]"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={addIgnoreKeyword}>Add</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
