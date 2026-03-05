/**
 * Tests for language/locale settings (Cluster E: off/on toggle with selector)
 */

// Mirror the locale state logic from audit-options/page.tsx
function loadLocaleState(savedLocale: string | null | undefined): { locale: string; localeEnabled: boolean } {
  const locale = savedLocale || ""
  return { locale, localeEnabled: !!locale }
}

function buildLocalePayload(localeEnabled: boolean, locale: string): string | null {
  // null when off means auditor infers from site content
  return localeEnabled ? locale || null : null
}

describe('locale settings logic', () => {
  it('is disabled when no locale saved', () => {
    const state = loadLocaleState(null)
    expect(state.localeEnabled).toBe(false)
    expect(state.locale).toBe("")
  })

  it('is enabled with correct variant when en-GB saved', () => {
    const state = loadLocaleState("en-GB")
    expect(state.localeEnabled).toBe(true)
    expect(state.locale).toBe("en-GB")
  })

  it('is enabled with correct variant when en-US saved', () => {
    const state = loadLocaleState("en-US")
    expect(state.localeEnabled).toBe(true)
    expect(state.locale).toBe("en-US")
  })

  it('sends null to API when locale is off (model infers)', () => {
    expect(buildLocalePayload(false, "en-GB")).toBeNull()
    expect(buildLocalePayload(false, "")).toBeNull()
  })

  it('sends locale to API when locale is on', () => {
    expect(buildLocalePayload(true, "en-GB")).toBe("en-GB")
    expect(buildLocalePayload(true, "en-US")).toBe("en-US")
  })
})
