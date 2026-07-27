const DEFAULT_THRESHOLD = 3
const DEFAULT_WINDOW_MS = 2 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000

export class RetailerCircuitBreaker {
  constructor({
    threshold = DEFAULT_THRESHOLD,
    windowMs = DEFAULT_WINDOW_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    now = () => Date.now()
  } = {}) {
    this.threshold = threshold
    this.windowMs = windowMs
    this.cooldownMs = cooldownMs
    this.now = now
    this.states = new Map()
  }

  allow(retailer) {
    const state = this.states.get(retailer)
    if (!state?.openedAt) return { allowed: true }
    const remainingMs = this.cooldownMs - (this.now() - state.openedAt)
    if (remainingMs > 0) return { allowed: false, remainingMs, reason: state.reason }
    if (state.halfOpenInFlight) {
      return { allowed: false, remainingMs: 1000, reason: 'half-open probe in progress' }
    }
    state.halfOpenInFlight = true
    return { allowed: true, halfOpen: true }
  }

  recordSuccess(retailer) {
    this.states.delete(retailer)
  }

  recordFailure(retailer, error) {
    const classification = classifyCircuitFailure(error)
    const existing = this.states.get(retailer)
    if (!classification.tripEligible) {
      // A half-open probe that reached a normal, task-specific failure proves the
      // retailer checkout itself is responding again. Close the systemic circuit.
      if (existing?.halfOpenInFlight) this.states.delete(retailer)
      return { opened: false, classification }
    }

    const now = this.now()
    const state = existing || { failures: [] }
    const wasHalfOpen = state.halfOpenInFlight === true
    state.failures = state.failures.filter((failure) => now - failure.at <= this.windowMs)
    state.failures.push({ at: now, reason: classification.reason })
    state.reason = classification.reason
    state.halfOpenInFlight = false
    // A failed half-open probe starts a fresh cooldown instead of immediately
    // allowing another probe because the previous cooldown already elapsed.
    if (wasHalfOpen || state.failures.length >= this.threshold) state.openedAt = now
    this.states.set(retailer, state)
    return { opened: Boolean(state.openedAt), classification, failures: state.failures.length }
  }

  reset(retailer) {
    this.states.delete(retailer)
  }

  snapshot() {
    const now = this.now()
    return Object.fromEntries(
      [...this.states.entries()].map(([retailer, state]) => [
        retailer,
        {
          failures: state.failures.length,
          openedAt: state.openedAt || null,
          reason: state.reason || null,
          open: Boolean(state.openedAt && now - state.openedAt < this.cooldownMs),
          remainingMs: state.openedAt ? Math.max(0, this.cooldownMs - (now - state.openedAt)) : 0
        }
      ])
    )
  }
}

export function classifyCircuitFailure(error) {
  const value = String(error?.message || error || '').toLowerCase()
  if (/captcha|security challenge|access denied|http 403|\b403\b/.test(value)) {
    return { tripEligible: true, reason: 'security-challenge' }
  }
  if (/http 429|\b429\b|rate limit|request throttled/.test(value)) {
    return { tripEligible: true, reason: 'rate-limited' }
  }
  if (
    /checkout controls were not found|place order control.*not found|selector.*not found|page structure/.test(
      value
    )
  ) {
    return { tripEligible: true, reason: 'checkout-structure' }
  }
  return { tripEligible: false, reason: 'task-specific' }
}
