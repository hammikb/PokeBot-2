import { describe, expect, it } from 'vitest'

import {
  TARGET_CART_POLICY,
  TARGET_CART_STRATEGY,
  TargetCartBudget,
  TargetCartBudgetError,
  parseTargetRetryAfterMs
} from '../../../../../src/main/automation/flows/target/TargetCartPolicy.js'

describe('TargetCartPolicy', () => {
  it('uses the approved browser-only retry limits', () => {
    expect(TARGET_CART_STRATEGY).toBe('browser')
    expect(TARGET_CART_POLICY).toEqual({
      pollMs: 100,
      outcomeMs: 1500,
      transientDelayMs: 400,
      rateLimitDelayMs: 1500,
      maxNoResponseRetriesPerDocument: 4,
      maxRecoverableRetries: 30,
      maxReloads: 2,
      deadlineMs: 120000
    })
  })

  it('parses delta-seconds and HTTP-date Retry-After values', () => {
    const now = Date.parse('2026-08-10T12:00:00.000Z')
    expect(parseTargetRetryAfterMs('2', now)).toBe(2000)
    expect(parseTargetRetryAfterMs('Mon, 10 Aug 2026 12:00:03 GMT', now)).toBe(3000)
    expect(parseTargetRetryAfterMs('invalid', now)).toBeNull()
  })

  it('counts only additional clicks as recoverable retries', () => {
    const budget = new TargetCartBudget({ startedAt: 1000 })
    budget.authorizeClick(null, 1000)
    budget.authorizeClick('no-response', 1100)
    expect(budget.snapshot()).toMatchObject({
      clickCount: 2,
      retryCount: 1,
      noResponseRetries: 1,
      reloadCount: 0
    })
  })

  it('resets only the per-document no-response count after reload', () => {
    const budget = new TargetCartBudget({ startedAt: 1000 })
    budget.authorizeClick(null, 1000)
    budget.authorizeClick('no-response', 1100)
    budget.recordReload(1200)
    expect(budget.snapshot()).toMatchObject({
      clickCount: 2,
      retryCount: 1,
      noResponseRetries: 0,
      reloadCount: 1
    })
  })

  it('throws precise codes for no-response, retry, reload, and deadline exhaustion', () => {
    const noResponse = new TargetCartBudget({
      startedAt: 0,
      policy: { ...TARGET_CART_POLICY, maxNoResponseRetriesPerDocument: 1 }
    })
    noResponse.authorizeClick(null, 0)
    noResponse.authorizeClick('no-response', 1)
    expect(() => noResponse.authorizeClick('no-response', 2)).toThrowError(
      expect.objectContaining({ code: 'no-response-limit' })
    )

    const retries = new TargetCartBudget({
      startedAt: 0,
      policy: { ...TARGET_CART_POLICY, maxRecoverableRetries: 1 }
    })
    retries.authorizeClick(null, 0)
    retries.authorizeClick('transient', 1)
    expect(() => retries.authorizeClick('rate-limit', 2)).toThrowError(
      expect.objectContaining({ code: 'retry-limit' })
    )

    const reloads = new TargetCartBudget({
      startedAt: 0,
      policy: { ...TARGET_CART_POLICY, maxReloads: 1 }
    })
    reloads.recordReload(1)
    expect(() => reloads.recordReload(2)).toThrowError(
      expect.objectContaining({ code: 'reload-limit' })
    )

    const deadline = new TargetCartBudget({ startedAt: 0 })
    expect(() => deadline.assertTimeRemaining(120000)).toThrowError(
      expect.objectContaining({ code: 'deadline' })
    )
    expect(TargetCartBudgetError.prototype).toBeInstanceOf(Error)
  })

  it('rejects a delay that lands exactly on the deadline', () => {
    const budget = new TargetCartBudget({ startedAt: 1000 })
    expect(() => budget.assertDelayFits(120000, 1000)).toThrowError(
      expect.objectContaining({ code: 'deadline' })
    )
  })
})
