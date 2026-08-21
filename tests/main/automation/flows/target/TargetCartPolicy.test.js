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
      outcomeMs: 3000,
      transientDelayMs: 0,
      rateLimitDelayMs: 250,
      maxRateLimitDelayMs: 2000,
      maxRecoverableRetries: 60,
      maxReloads: 2,
      verificationAttempts: 3,
      verificationRetryMs: 400,
      deadlineMs: 120000,
      inventoryDeadlineMs: 600000
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
    // no-response is deliberately uncapped now: it must never end a run on its own.
    const noResponse = new TargetCartBudget({ startedAt: 0 })
    for (let i = 0; i < 25; i += 1) {
      expect(() => noResponse.authorizeClick('no-response', 1)).not.toThrow()
    }

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

  it('applies explicit deadlines without changing retry or reload caps', () => {
    const budget = new TargetCartBudget({ startedAt: 0 })
    expect(() => budget.assertTimeRemaining(121000)).toThrowError(
      expect.objectContaining({ code: 'deadline' })
    )
    expect(() => budget.assertTimeRemaining(121000, 600000)).not.toThrow()
    expect(() => budget.assertDelayFits(479000, 121000, 600000)).toThrowError(
      expect.objectContaining({ code: 'deadline' })
    )
  })

  it('keeps clicking past the count caps while inventory is confirmed in stock', () => {
    const budget = new TargetCartBudget({ startedAt: 0 })
    budget.setInventoryExtended(true)
    for (let i = 0; i < TARGET_CART_POLICY.maxRecoverableRetries + 10; i += 1) {
      expect(() => budget.authorizeClick('no-response', 1000)).not.toThrow()
    }
    for (let i = 0; i < TARGET_CART_POLICY.maxReloads + 5; i += 1) {
      expect(() => budget.recordReload(1000)).not.toThrow()
    }
  })

  it('still enforces the hard inventory deadline while in stock', () => {
    const budget = new TargetCartBudget({ startedAt: 0 })
    budget.setInventoryExtended(true)
    expect(() =>
      budget.authorizeClick(
        null,
        TARGET_CART_POLICY.inventoryDeadlineMs,
        TARGET_CART_POLICY.inventoryDeadlineMs
      )
    ).toThrow(TargetCartBudgetError)
  })

  it('restores the count caps once inventory is no longer confirmed', () => {
    const budget = new TargetCartBudget({ startedAt: 0 })
    budget.setInventoryExtended(true)
    for (let i = 0; i < TARGET_CART_POLICY.maxReloads + 3; i += 1) budget.recordReload(1000)
    budget.setInventoryExtended(false)
    expect(() => budget.recordReload(1000)).toThrow(TargetCartBudgetError)
  })
})
