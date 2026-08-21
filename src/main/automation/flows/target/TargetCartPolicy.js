export const TARGET_CART_STRATEGY = 'browser'

export const TARGET_CART_POLICY = Object.freeze({
  pollMs: 100,
  // 1500ms lost real cart POSTs on slow drops and mislabelled them 'no-response',
  // which bounced the page to /co-cart and burned the retry budget.
  outcomeMs: 3000,
  // No pause before re-clicking after we dismiss an error sheet - dismissal itself is
  // the only gap. There is no artificial delay between ordinary clicks anywhere in the
  // loop; the only sleeps are the refusal backoffs below.
  transientDelayMs: 0,
  // ==== Retry speed knobs ====
  // These delays apply ONLY after Target refuses a click (429 / "item not added").
  // The first click and the success path have no added delay at all, so lowering these
  // does not make a good add faster - it only makes refusals retry sooner.
  // A literal 0 is what produced 607 back-to-back clicks, then HTTP 401s, then a dead
  // session. Keep a small floor; tune here rather than removing the backoff.
  rateLimitDelayMs: 250,
  maxRateLimitDelayMs: 2000,
  // No no-response cap on purpose. Reloading the product page after N silent clicks
  // cost a measured ~2.5s blackout (~24 clicks of lost cadence) and fixed nothing:
  // no-response kept occurring at the same rate afterwards. The deadline governs now.
  maxRecoverableRetries: 60,
  maxReloads: 2,
  // A 2xx from the cart API is Target confirming the add. When the cart-page DOM read
  // disagrees, the DOM read is the unreliable one - retry it instead of discarding a
  // cart we already won. 17 confirmed adds have been thrown away this way.
  verificationAttempts: 3,
  verificationRetryMs: 400,
  deadlineMs: 120000,
  inventoryDeadlineMs: 600000
})

export class TargetCartBudgetError extends Error {
  constructor(code, snapshot) {
    super(`Target cart acquisition exhausted ${code}`)
    this.name = 'TargetCartBudgetError'
    this.code = code
    this.snapshot = snapshot
  }
}

export function parseTargetRetryAfterMs(rawValue, nowMs = Date.now()) {
  const value = String(rawValue ?? '').trim()
  if (!value) return null
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000))
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null
}

export class TargetCartBudget {
  constructor({ startedAt, policy = TARGET_CART_POLICY }) {
    this.startedAt = startedAt
    this.policy = policy
    this.clickCount = 0
    this.retryCount = 0
    this.noResponseRetries = 0
    this.reloadCount = 0
    // While the monitor keeps confirming the item in stock, count-based caps stop
    // ending the run: a drop that is still live deserves more clicks, not a 'failed'
    // alert. The inventory deadline stays the hard ceiling so a stale feed can't
    // loop forever, and a confirmed out-of-stock still aborts immediately.
    this.inventoryExtended = false
  }

  setInventoryExtended(extended) {
    this.inventoryExtended = Boolean(extended)
  }

  snapshot(nowMs = this.startedAt) {
    return {
      clickCount: this.clickCount,
      retryCount: this.retryCount,
      noResponseRetries: this.noResponseRetries,
      reloadCount: this.reloadCount,
      elapsedMs: Math.max(0, nowMs - this.startedAt)
    }
  }

  assertTimeRemaining(nowMs, deadlineMs = this.policy.deadlineMs) {
    if (nowMs - this.startedAt >= deadlineMs) {
      throw new TargetCartBudgetError('deadline', this.snapshot(nowMs))
    }
  }

  assertDelayFits(delayMs, nowMs, deadlineMs = this.policy.deadlineMs) {
    this.assertTimeRemaining(nowMs, deadlineMs)
    if (nowMs + Math.max(0, delayMs) - this.startedAt >= deadlineMs) {
      throw new TargetCartBudgetError('deadline', this.snapshot(nowMs))
    }
  }

  authorizeClick(retryKind, nowMs, deadlineMs = this.policy.deadlineMs) {
    this.assertTimeRemaining(nowMs, deadlineMs)
    const stillInStock = this.inventoryExtended
    if (retryKind !== null) {
      if (!stillInStock && this.retryCount >= this.policy.maxRecoverableRetries) {
        throw new TargetCartBudgetError('retry-limit', this.snapshot(nowMs))
      }
      this.retryCount += 1
      if (retryKind === 'no-response') this.noResponseRetries += 1
    }
    this.clickCount += 1
  }

  recordReload(nowMs, deadlineMs = this.policy.deadlineMs) {
    this.assertTimeRemaining(nowMs, deadlineMs)
    if (!this.inventoryExtended && this.reloadCount >= this.policy.maxReloads) {
      throw new TargetCartBudgetError('reload-limit', this.snapshot(nowMs))
    }
    this.reloadCount += 1
    this.noResponseRetries = 0
  }
}
