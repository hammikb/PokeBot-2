export const TARGET_CART_STRATEGY = 'browser'

export const TARGET_CART_POLICY = Object.freeze({
  pollMs: 100,
  outcomeMs: 1500,
  transientDelayMs: 400,
  rateLimitDelayMs: 1500,
  maxNoResponseRetriesPerDocument: 4,
  maxRecoverableRetries: 30,
  maxReloads: 2,
  deadlineMs: 120000
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

  assertTimeRemaining(nowMs) {
    if (nowMs - this.startedAt >= this.policy.deadlineMs) {
      throw new TargetCartBudgetError('deadline', this.snapshot(nowMs))
    }
  }

  authorizeClick(retryKind, nowMs) {
    this.assertTimeRemaining(nowMs)
    if (retryKind !== null) {
      if (this.retryCount >= this.policy.maxRecoverableRetries) {
        throw new TargetCartBudgetError('retry-limit', this.snapshot(nowMs))
      }
      if (
        retryKind === 'no-response' &&
        this.noResponseRetries >= this.policy.maxNoResponseRetriesPerDocument
      ) {
        throw new TargetCartBudgetError('no-response-limit', this.snapshot(nowMs))
      }
      this.retryCount += 1
      if (retryKind === 'no-response') this.noResponseRetries += 1
    }
    this.clickCount += 1
  }

  canRetryNoResponse() {
    return this.noResponseRetries < this.policy.maxNoResponseRetriesPerDocument
  }

  recordReload(nowMs) {
    this.assertTimeRemaining(nowMs)
    if (this.reloadCount >= this.policy.maxReloads) {
      throw new TargetCartBudgetError('reload-limit', this.snapshot(nowMs))
    }
    this.reloadCount += 1
    this.noResponseRetries = 0
  }
}
