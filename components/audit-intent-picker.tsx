"use client"

import * as React from "react"
import { useState } from "react"
import { ArrowLeft, Zap, Search, SlidersHorizontal, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { AuditPreset } from "@/types/fortress"

// Must match VALID_READABILITY in lib/brand-voice-constants.ts
const READABILITY_LEVELS = [
  { value: "grade_6_8", label: "Grade 6-8" },
  { value: "grade_10_12", label: "Grade 10-12" },
  { value: "grade_13_plus", label: "13+" },
] as const

const FORMALITY_LEVELS = [
  { value: "casual", label: "Casual" },
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
] as const

/** Options sent to the API when using custom preset */
export interface CustomAuditOptions {
  flagAiWriting?: boolean
  readabilityLevel?: string
  formality?: string
  locale?: string
  includeLongform?: boolean
  voiceSummary?: string
}

interface AuditIntentPickerProps {
  isAuthenticated: boolean
  /** User's plan - controls which options are available */
  plan?: 'free' | 'pro' | 'enterprise'
  onSelect: (preset: AuditPreset, options?: CustomAuditOptions) => void
  onBack?: () => void
  /** Domain being audited, shown in heading context */
  domain?: string
  /** Compact mode for use inside dialogs */
  compact?: boolean
}

interface PresetOption {
  value: AuditPreset
  label: string
  description: string
  icon: React.ReactNode
  badge?: string
}

const PRESETS: PresetOption[] = [
  {
    value: "quick",
    label: "Quick check",
    description: "Grammar, spelling, broken links, inconsistencies (~1 min)",
    icon: <Zap className="h-5 w-5" />,
  },
  {
    value: "full",
    label: "Full content audit",
    description: "Plus AI pattern detection, readability check (~3 min)",
    icon: <Search className="h-5 w-5" />,
    badge: "Recommended",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Choose exactly what to check",
    icon: <SlidersHorizontal className="h-5 w-5" />,
  },
]

const BUTTON_LABELS: Record<AuditPreset, string> = {
  quick: "Run Quick Check",
  full: "Run Full Audit",
  custom: "Run Custom Audit",
}

// Reusable pill selector for picking one value from a short list
function PillSelect({ options, value, onChange }: {
  options: ReadonlyArray<{ value: string; label: string }>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5 animate-in fade-in duration-150">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "text-xs px-2.5 py-1 rounded-full border transition-colors",
            value === opt.value
              ? "border-primary bg-primary/10 text-primary font-medium"
              : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// Small lock + "Pro" badge for gated features
function ProBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
      <Lock className="h-2.5 w-2.5" />
      Pro
    </span>
  )
}

export function AuditIntentPicker({
  isAuthenticated,
  plan = 'free',
  onSelect,
  onBack,
  domain,
  compact = false,
}: AuditIntentPickerProps) {
  const [selected, setSelected] = useState<AuditPreset>("full")

  const isPaid = plan === 'pro' || plan === 'enterprise'

  // Custom options state - defaults mirror the "full" preset
  const [flagAiWriting, setFlagAiWriting] = useState(true)
  const [readabilityEnabled, setReadabilityEnabled] = useState(true)
  const [readabilityLevel, setReadabilityLevel] = useState("grade_10_12")
  const [formalityEnabled, setFormalityEnabled] = useState(false)
  const [formality, setFormality] = useState("neutral")
  const [locale, setLocale] = useState<"en-GB" | "en-US">("en-US")
  const [includeLongform, setIncludeLongform] = useState(false)
  const [brandVoiceEnabled, setBrandVoiceEnabled] = useState(false)
  const [voiceSummary, setVoiceSummary] = useState("")

  const handleSubmit = () => {
    if (selected === "custom") {
      onSelect(selected, {
        flagAiWriting,
        readabilityLevel: readabilityEnabled ? readabilityLevel : undefined,
        formality: formalityEnabled ? formality : undefined,
        locale,
        includeLongform: isPaid ? includeLongform : false,
        voiceSummary: isPaid && brandVoiceEnabled && voiceSummary.trim() ? voiceSummary.trim() : undefined,
      })
    } else {
      onSelect(selected)
    }
  }

  return (
    <div className={cn(
      "w-full",
      compact ? "space-y-4" : "space-y-6 max-w-xl mx-auto"
    )}>
      {/* Header */}
      <div className={compact ? "" : "text-center"}>
        {onBack && (
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        )}
        <h2 className={cn(
          "font-serif font-light tracking-tight",
          compact ? "text-xl mb-1" : "text-3xl md:text-4xl mb-3"
        )}>
          What kind of audit do you need?
        </h2>
        {domain && !compact && (
          <p className="text-muted-foreground text-sm">{domain}</p>
        )}
      </div>

      {/* Preset cards */}
      <div className="space-y-3">
        {PRESETS.map((preset) => {
          const isSelected = selected === preset.value
          return (
            <button
              key={preset.value}
              type="button"
              onClick={() => setSelected(preset.value)}
              className={cn(
                "w-full text-left rounded-lg border p-4 transition-all duration-150",
                "hover:border-foreground/30",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isSelected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border bg-card"
              )}
            >
              <div className="flex items-start gap-3">
                {/* Radio indicator */}
                <div className={cn(
                  "mt-0.5 h-4 w-4 shrink-0 rounded-full border transition-colors",
                  isSelected
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/40"
                )}>
                  {isSelected && (
                    <div className="flex h-full w-full items-center justify-center">
                      <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                    </div>
                  )}
                </div>

                {/* Icon */}
                <div className={cn(
                  "shrink-0 transition-colors",
                  isSelected ? "text-primary" : "text-muted-foreground"
                )}>
                  {preset.icon}
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">
                      {preset.label}
                    </span>
                    {preset.badge && (
                      <span className="text-[10px] font-medium uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        {preset.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {preset.description}
                  </p>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Custom options - expand when Custom is selected */}
      {selected === "custom" && (
        <div className="rounded-lg border border-border bg-muted/30 divide-y divide-border/60 animate-in fade-in slide-in-from-top-2 duration-200 text-left">
          {/* --- Free options --- */}

          {/* AI pattern detection */}
          <label htmlFor="flag-ai-writing" className="flex items-center justify-between px-4 py-3 cursor-pointer">
            <div className="pr-4">
              <span className="text-sm font-medium block">AI pattern detection</span>
              <span className="text-xs text-muted-foreground">Flag AI-generated text</span>
            </div>
            <Switch
              id="flag-ai-writing"
              checked={flagAiWriting}
              onCheckedChange={setFlagAiWriting}
            />
          </label>

          {/* Readability check */}
          <div className="px-4 py-3">
            <label htmlFor="readability-check" className="flex items-center justify-between cursor-pointer">
              <div className="pr-4">
                <span className="text-sm font-medium block">Readability</span>
                <span className="text-xs text-muted-foreground">Flag pages above a reading level</span>
              </div>
              <Switch
                id="readability-check"
                checked={readabilityEnabled}
                onCheckedChange={setReadabilityEnabled}
              />
            </label>
            {readabilityEnabled && (
              <PillSelect
                options={READABILITY_LEVELS}
                value={readabilityLevel}
                onChange={setReadabilityLevel}
              />
            )}
          </div>

          {/* Spelling standard */}
          <div className="px-4 py-3">
            <span className="text-sm font-medium block">Spelling standard</span>
            <span className="text-xs text-muted-foreground">Which English do you write in?</span>
            <div className="flex gap-1.5 mt-2.5">
              {([
                { value: "en-GB" as const, label: "British" },
                { value: "en-US" as const, label: "American" },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setLocale(opt.value)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full border transition-colors",
                    locale === opt.value
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* --- Pro-gated options --- */}

          {/* Formality - Pro only */}
          <div className="px-4 py-3">
            <label htmlFor="formality-check" className={cn(
              "flex items-center justify-between",
              isPaid ? "cursor-pointer" : "cursor-not-allowed"
            )}>
              <div className="pr-4">
                <span className="text-sm font-medium flex items-center gap-1.5">
                  Formality
                  {!isPaid && <ProBadge />}
                </span>
                <span className="text-xs text-muted-foreground">
                  Flag content that doesn't match your tone
                </span>
              </div>
              <Switch
                id="formality-check"
                checked={formalityEnabled}
                onCheckedChange={isPaid ? setFormalityEnabled : undefined}
                disabled={!isPaid}
              />
            </label>
            {formalityEnabled && isPaid && (
              <PillSelect
                options={FORMALITY_LEVELS}
                value={formality}
                onChange={setFormality}
              />
            )}
          </div>

          {/* Include blog/longform pages - Pro only */}
          <label
            htmlFor="include-longform"
            className={cn(
              "flex items-center justify-between px-4 py-3",
              isPaid ? "cursor-pointer" : "cursor-not-allowed"
            )}
          >
            <div className="pr-4">
              <span className="text-sm font-medium flex items-center gap-1.5">
                Include blog/articles
                {!isPaid && <ProBadge />}
              </span>
              <span className="text-xs text-muted-foreground">
                Audit blog and article pages too
              </span>
            </div>
            <Switch
              id="include-longform"
              checked={includeLongform}
              onCheckedChange={isPaid ? setIncludeLongform : undefined}
              disabled={!isPaid}
            />
          </label>

          {/* Brand voice - Pro only */}
          <div className="px-4 py-3">
            <label htmlFor="brand-voice-check" className={cn(
              "flex items-center justify-between",
              isPaid ? "cursor-pointer" : "cursor-not-allowed"
            )}>
              <div className="pr-4">
                <span className="text-sm font-medium flex items-center gap-1.5">
                  Brand voice
                  {!isPaid && <ProBadge />}
                </span>
                <span className="text-xs text-muted-foreground">
                  Audit against your writing style
                </span>
              </div>
              <Switch
                id="brand-voice-check"
                checked={brandVoiceEnabled}
                onCheckedChange={isPaid ? setBrandVoiceEnabled : undefined}
                disabled={!isPaid}
              />
            </label>
            {brandVoiceEnabled && isPaid && (
              <div className="mt-2.5 animate-in fade-in duration-150">
                <Textarea
                  placeholder="Describe your brand voice - e.g. 'Friendly and direct. Short sentences. Avoid jargon. Never use exclamation marks.'"
                  value={voiceSummary}
                  onChange={(e) => setVoiceSummary(e.target.value)}
                  rows={3}
                  className="text-sm resize-none"
                  maxLength={2000}
                />
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  The auditor will flag content that doesn't match this voice
                </p>
              </div>
            )}
          </div>

          {/* More options link for authenticated users */}
          {isAuthenticated && (
            <div className="px-4 py-3">
              <a
                href="/dashboard/audit-options"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Keyword rules, saved settings &rarr;
              </a>
            </div>
          )}
        </div>
      )}

      {/* Submit button */}
      <Button
        size="lg"
        className={cn(
          "font-medium",
          compact ? "w-full h-11" : "w-full h-14 text-lg"
        )}
        onClick={handleSubmit}
      >
        {BUTTON_LABELS[selected]}
      </Button>
    </div>
  )
}
