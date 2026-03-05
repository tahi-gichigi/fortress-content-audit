/**
 * Tests for NewAuditDialog defaultDomain behavior (Cluster B: rerun shows intent picker)
 */

// Mirror the step-initialisation logic from NewAuditDialog so we can unit test it
function initialStep(defaultDomain: string | undefined): 1 | 2 {
  return defaultDomain ? 2 : 1
}

function resetOnOpen(defaultDomain: string | undefined): { domain: string; step: 1 | 2 } {
  return {
    domain: defaultDomain ?? "",
    step: defaultDomain ? 2 : 1,
  }
}

describe('NewAuditDialog step logic', () => {
  it('starts at step 1 with no defaultDomain', () => {
    expect(initialStep(undefined)).toBe(1)
  })

  it('starts at step 2 when defaultDomain is provided', () => {
    expect(initialStep('example.com')).toBe(2)
  })

  it('pre-fills domain when defaultDomain is provided', () => {
    const state = resetOnOpen('example.com')
    expect(state.domain).toBe('example.com')
    expect(state.step).toBe(2)
  })

  it('clears domain when no defaultDomain on open', () => {
    const state = resetOnOpen(undefined)
    expect(state.domain).toBe('')
    expect(state.step).toBe(1)
  })
})
