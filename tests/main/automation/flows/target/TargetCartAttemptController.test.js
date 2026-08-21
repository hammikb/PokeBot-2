import { describe, expect, it, vi } from 'vitest'

import { runTargetCartAttempt } from '../../../../../src/main/automation/flows/target/TargetCartAttemptController.js'
import { TARGET_CART_POLICY } from '../../../../../src/main/automation/flows/target/TargetCartPolicy.js'
import { classifyCheckoutFailure } from '../../../../../src/main/telemetry/CheckoutTelemetry.js'

function harness(
  outcomes,
  { verification = { present: true, quantity: 1, unitPrice: 19.99 } } = {}
) {
  let nowMs = 1000
  let productValid = true
  const sleeps = []
  const buttons = []
  const events = []
  const acquireButton = vi.fn(async () => {
    const button = { click: vi.fn(async () => {}) }
    buttons.push(button)
    return button
  })
  return {
    options: {
      tcin: '123456',
      requestedQuantity: 1,
      productUrl: 'https://www.target.com/p/example/-/A-123456',
      now: () => nowMs,
      sleep: vi.fn(async (ms) => {
        sleeps.push(ms)
        nowMs += ms
      }),
      acquireButton,
      getInventoryGate: vi.fn(async () => ({ mode: 'fallback' })),
      getProbableEvidence: vi.fn(async () => null),
      clickAndObserve: vi.fn(async () => outcomes.shift()),
      verifyCart: vi.fn(async () => verification),
      recoverAmbiguousCart: vi.fn(async () => null),
      dismissTransient: vi.fn(async () => {}),
      restoreProduct: vi.fn(async () => {
        productValid = true
      }),
      isProductPageValid: vi.fn(async () => productValid),
      onEvent: vi.fn((event) => events.push(event))
    },
    sleeps,
    buttons,
    events,
    advanceNow(ms) {
      nowMs += ms
    },
    setProductValid(value) {
      productValid = value
    }
  }
}

describe('runTargetCartAttempt', () => {
  it('returns authoritative evidence after one immediate successful click', async () => {
    const h = harness([
      {
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }
    ])
    await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({
      tcin: '123456',
      quantity: 1,
      unitPrice: 19.99,
      source: 'mutation-2xx',
      mutationStatus: 200,
      clickCount: 1,
      retryCount: 0,
      reloadCount: 0
    })
    expect(h.sleeps).toEqual([])
  })

  it('continues after 120 seconds while healthy inventory remains in stock', async () => {
    const h = harness([
      { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
    ])
    h.options.getProbableEvidence.mockImplementationOnce(async () => {
      h.advanceNow(121_000)
      return null
    })
    h.options.getInventoryGate.mockResolvedValue({ mode: 'extend' })

    await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({ quantity: 1 })
  })

  it('stops before another click after a newer valid out-of-stock event', async () => {
    const h = harness([
      { kind: 'no-response', status: null, evidence: null },
      { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
    ])
    h.options.getInventoryGate
      .mockResolvedValueOnce({ mode: 'extend' })
      .mockResolvedValueOnce({ mode: 'extend' })
      .mockResolvedValueOnce({ mode: 'stop', reason: 'confirmed-out-of-stock' })

    await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'out-of-stock' })
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
  })

  it('uses the fallback deadline and enforces the hard inventory deadline', async () => {
    const fallback = harness([])
    fallback.options.getProbableEvidence.mockImplementationOnce(async () => {
      fallback.advanceNow(120_000)
      return null
    })
    await expect(runTargetCartAttempt(fallback.options)).rejects.toMatchObject({ code: 'deadline' })

    const extended = harness([])
    extended.options.getProbableEvidence.mockImplementationOnce(async () => {
      extended.advanceNow(600_000)
      return null
    })
    extended.options.getInventoryGate.mockResolvedValue({ mode: 'extend' })
    await expect(runTargetCartAttempt(extended.options)).rejects.toMatchObject({ code: 'deadline' })
  })

  it('returns cart evidence before inventory is evaluated again', async () => {
    const h = harness([{ kind: 'no-response', status: null, evidence: null }])
    h.options.getProbableEvidence
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ source: 'visible-added-to-cart', mutationStatus: null })
    h.options.getInventoryGate.mockResolvedValue({ mode: 'extend' })
    const result = await runTargetCartAttempt(h.options)
    expect(result.source).toBe('visible-added-to-cart')
    expect(h.options.getInventoryGate).toHaveBeenCalledTimes(2)
  })

  it('recovers an authoritative cart after no response before issuing a second click', async () => {
    const h = harness([{ kind: 'no-response', status: null, evidence: null }])
    h.options.recoverAmbiguousCart.mockResolvedValueOnce({
      present: true,
      quantity: 1,
      unitPrice: 19.99,
      source: 'target-cart-page'
    })

    await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({
      tcin: '123456',
      quantity: 1,
      unitPrice: 19.99,
      source: 'ambiguous-cart-recovery',
      clickCount: 1,
      retryCount: 0
    })
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
    expect(h.options.recoverAmbiguousCart).toHaveBeenCalledTimes(1)
    expect(h.events).toContainEqual(
      expect.objectContaining({
        state: 'ambiguous_cart_recovery',
        outcome: 'present',
        clickCount: 1
      })
    )
  })

  it('continues the normal retry when ambiguous cart recovery finds no item', async () => {
    const h = harness([
      { kind: 'no-response', status: null, evidence: null },
      { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
    ])

    await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({
      source: 'mutation-2xx',
      clickCount: 2,
      retryCount: 1
    })
    expect(h.options.recoverAmbiguousCart).toHaveBeenCalledTimes(1)
    expect(h.events).toContainEqual(
      expect.objectContaining({ state: 'ambiguous_cart_recovery', outcome: 'absent' })
    )
  })

  it('does not probe the cart when the add result is not ambiguous', async () => {
    const h = harness([
      { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
    ])

    await runTargetCartAttempt(h.options)

    expect(h.options.recoverAmbiguousCart).not.toHaveBeenCalled()
  })

  it('keeps clicking through no-response instead of reloading the product', async () => {
    // Reloading after N silent clicks cost a measured ~2.5s blackout and did not reduce
    // the no-response rate, so no-response no longer triggers a reload at all.
    const noResponse = { kind: 'no-response', status: null, evidence: null }
    const success = {
      kind: 'success',
      status: 200,
      evidence: { source: 'mutation-2xx', mutationStatus: 200 }
    }
    const h = harness([noResponse, noResponse, noResponse, noResponse, noResponse, success])
    const result = await runTargetCartAttempt(h.options)
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(6)
    expect(h.options.restoreProduct).not.toHaveBeenCalled()
    expect(result).toMatchObject({ clickCount: 6, retryCount: 5, reloadCount: 0 })
  })

  it('emits each scheduled no-response retry with the counter before the next click', async () => {
    const h = harness([
      { kind: 'no-response', status: null, evidence: null },
      {
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }
    ])

    await runTargetCartAttempt(h.options)

    const scheduledRetries = h.events.filter((event) => event.state === 'no_response_retry')
    expect(scheduledRetries).toEqual([
      expect.objectContaining({ clickCount: 2, retryCount: 1, noResponseRetries: 1 })
    ])
    expect(scheduledRetries[0]).not.toHaveProperty('delayMs')
  })

  it('does not emit a no-response retry when the global retry budget rejects it', async () => {
    const h = harness([{ kind: 'no-response', status: null, evidence: null }])
    h.options.policy = {
      ...TARGET_CART_POLICY,
      maxRecoverableRetries: 0
    }

    await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'retry-limit' })

    expect(h.events.filter((event) => event.state === 'no_response_retry')).toEqual([])
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
  })

  it('waits the transient delay for a modal and the rate-limit floor for a 429 without Retry-After', async () => {
    const h = harness([
      { kind: 'transient', status: null, evidence: null },
      { kind: 'rate-limit', status: 429, retryAfterMs: null, evidence: null },
      {
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }
    ])
    await runTargetCartAttempt(h.options)
    expect(h.sleeps).toEqual([
      TARGET_CART_POLICY.transientDelayMs,
      TARGET_CART_POLICY.rateLimitDelayMs
    ])
    expect(h.options.dismissTransient).toHaveBeenCalledTimes(2)
  })

  it('honors Retry-After only when it fits the remaining deadline', async () => {
    const h = harness([
      { kind: 'rate-limit', status: 429, retryAfterMs: 2000, evidence: null },
      {
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }
    ])
    await runTargetCartAttempt(h.options)
    expect(h.sleeps).toEqual([2000])
    expect(h.events).toContainEqual(
      expect.objectContaining({
        state: 'outcome_classified',
        kind: 'rate-limit',
        status: 429,
        clickCount: 1,
        retryCount: 0
      })
    )
    expect(h.events).toContainEqual(
      expect.objectContaining({
        state: 'rate_limited',
        delayMs: 2000,
        retryAfterHonored: true,
        clickCount: 1,
        retryCount: 0
      })
    )

    const tooLong = harness([
      { kind: 'rate-limit', status: 429, retryAfterMs: 120000, evidence: null }
    ])
    let deadlineError
    await runTargetCartAttempt(tooLong.options).catch((error) => {
      deadlineError = error
    })
    expect(deadlineError).toMatchObject({ code: 'deadline' })
    expect(classifyCheckoutFailure(deadlineError.message, 'cart_attempted')).toEqual({
      code: 'cart_rate_limited',
      stage: 'cart_attempted'
    })
    expect(tooLong.options.clickAndObserve).toHaveBeenCalledTimes(1)
    expect(tooLong.sleeps).toEqual([])
    expect(tooLong.options.restoreProduct).not.toHaveBeenCalled()
  })

  it('classifies the real repeated-rate-limit terminal error without changing retry behavior', async () => {
    const h = harness(
      Array.from({ length: 3 }, () => ({
        kind: 'rate-limit',
        status: 429,
        retryAfterMs: null,
        evidence: null
      }))
    )
    h.options.policy = {
      ...TARGET_CART_POLICY,
      rateLimitDelayMs: 25,
      maxRecoverableRetries: 1
    }

    let terminalError
    await runTargetCartAttempt(h.options).catch((error) => {
      terminalError = error
    })

    expect(terminalError).toMatchObject({ code: 'retry-limit' })
    expect(classifyCheckoutFailure(terminalError.message, 'cart_attempted')).toEqual({
      code: 'cart_rate_limited',
      stage: 'cart_attempted'
    })
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(2)
    expect(h.sleeps).toEqual([25, 50])
    expect(h.options.restoreProduct).not.toHaveBeenCalled()
  })

  it('lets the deadline end a no-response run rather than reloading through it', async () => {
    const h = harness(
      Array.from({ length: 40 }, () => ({
        kind: 'no-response',
        status: null,
        evidence: null
      }))
    )
    h.options.getProbableEvidence.mockImplementation(async () => {
      h.advanceNow(20_000)
      return null
    })

    let terminalError
    await runTargetCartAttempt(h.options).catch((error) => {
      terminalError = error
    })

    expect(terminalError).toMatchObject({ code: 'deadline' })
    expect(h.options.restoreProduct).not.toHaveBeenCalled()
    expect(h.sleeps).toEqual([])
  })

  it('checks probable evidence before acquiring another button', async () => {
    const h = harness([{ kind: 'no-response', status: null, evidence: null }])
    h.options.getProbableEvidence
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ source: 'visible-added-to-cart', mutationStatus: null })
    const result = await runTargetCartAttempt(h.options)
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('visible-added-to-cart')
  })

  it('stops on session errors and emits sanitized counter-only events', async () => {
    const h = harness([{ kind: 'session-error', status: 403, evidence: null }])
    await expect(runTargetCartAttempt(h.options)).rejects.toThrow(
      'Target cart session rejected with HTTP 403'
    )
    expect(h.events.every((event) => !('url' in event) && !('email' in event))).toBe(true)
  })

  it.each([
    [{ kind: 'session-error', status: 401, evidence: null }, /HTTP 401/],
    [{ kind: 'session-error', status: 403, evidence: null }, /HTTP 403/]
  ])('terminates session failures without another click', async (outcome, message) => {
    const h = harness([outcome])
    await expect(runTargetCartAttempt(h.options)).rejects.toThrow(message)
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
  })

  it('terminates after 60 additional recoverable clicks', async () => {
    const h = harness(
      Array.from({ length: 70 }, () => ({
        kind: 'transient',
        status: 503,
        evidence: null
      }))
    )
    await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'retry-limit' })
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(61)
  })

  it('terminates after two product reloads', async () => {
    // Driven by the reload trigger that remains: a product page that keeps getting
    // replaced. no-response no longer reloads, so it cannot drive this any more.
    const h = harness(
      Array.from({ length: 20 }, () => ({
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }))
    )
    // Stays invalid across reloads, so the reload budget is what ends the run.
    h.options.isProductPageValid = vi.fn(async () => false)
    await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'reload-limit' })
    expect(h.options.restoreProduct).toHaveBeenCalledTimes(2)
  })

  it('restores a replaced product page before acquiring a button', async () => {
    const h = harness([
      {
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }
    ])
    h.setProductValid(false)
    const result = await runTargetCartAttempt(h.options)
    expect(h.options.restoreProduct).toHaveBeenCalledTimes(1)
    expect(result.reloadCount).toBe(1)
  })

  it('freezes clicking when evidence appears after transient-modal dismissal', async () => {
    const h = harness([{ kind: 'transient', status: null, evidence: null }])
    h.options.getProbableEvidence
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ source: 'visible-added-to-cart', mutationStatus: null })
    const result = await runTargetCartAttempt(h.options)
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
    expect(h.options.dismissTransient).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('visible-added-to-cart')
  })

  it('emits only sanitized state and counter fields', async () => {
    const h = harness([
      {
        kind: 'success',
        status: 200,
        evidence: { source: 'mutation-2xx', mutationStatus: 200 }
      }
    ])
    await runTargetCartAttempt(h.options)
    const allowed = new Set([
      'state',
      'clickCount',
      'retryCount',
      'noResponseRetries',
      'reloadCount',
      'elapsedMs',
      'kind',
      'status',
      'delayMs',
      'retryAfterHonored',
      'evidenceSource',
      'mutationStatus',
      'reason',
      'outcome'
    ])
    for (const event of h.events) {
      expect(Object.keys(event).every((key) => allowed.has(key))).toBe(true)
    }
  })

  it.each([
    ['Item is out of stock (Target availability settled)'],
    ['Target security challenge did not clear before fulfillment timeout']
  ])('passes through terminal readiness error: %s', async (message) => {
    const h = harness([])
    h.options.acquireButton.mockRejectedValueOnce(new Error(message))
    await expect(runTargetCartAttempt(h.options)).rejects.toThrow(message)
    expect(h.options.clickAndObserve).not.toHaveBeenCalled()
  })

  it('floors a zero Retry-After instead of hot-looping the click', async () => {
    // Target answers its 429s with `Retry-After: 0`; honoring that literally produced
    // hundreds of back-to-back clicks with no backoff at all.
    const h = harness(
      Array.from({ length: 3 }, () => ({
        kind: 'rate-limit',
        status: 429,
        retryAfterMs: 0,
        evidence: null
      }))
    )
    h.options.policy = { ...TARGET_CART_POLICY, rateLimitDelayMs: 25, maxRecoverableRetries: 2 }
    await runTargetCartAttempt(h.options).catch(() => {})
    expect(h.sleeps).not.toContain(0)
    expect(h.sleeps).toEqual([25, 50, 100])
  })

  it('still honors a real Retry-After exactly rather than escalating it', async () => {
    const h = harness(
      Array.from({ length: 2 }, () => ({
        kind: 'rate-limit',
        status: 429,
        retryAfterMs: 40,
        evidence: null
      }))
    )
    h.options.policy = { ...TARGET_CART_POLICY, rateLimitDelayMs: 25, maxRecoverableRetries: 1 }
    await runTargetCartAttempt(h.options).catch(() => {})
    expect(h.sleeps).toEqual([40, 40])
  })

  it('caps the rate-limit backoff so a long 429 storm cannot stall the run', async () => {
    const h = harness(
      Array.from({ length: 8 }, () => ({
        kind: 'rate-limit',
        status: 429,
        retryAfterMs: null,
        evidence: null
      }))
    )
    h.options.policy = {
      ...TARGET_CART_POLICY,
      rateLimitDelayMs: 25,
      maxRateLimitDelayMs: 100,
      maxRecoverableRetries: 7
    }
    await runTargetCartAttempt(h.options).catch(() => {})
    expect(Math.max(...h.sleeps)).toBe(100)
  })

  it('does not discard a confirmed cart when the first DOM read comes back empty', async () => {
    // Reproduces the real loss: Target answered 2xx, the cart-page read said "empty",
    // and the attempt reloaded the product page and eventually failed out-of-stock.
    const h = harness([{ kind: 'success', status: 200, evidence: { source: 'mutation-2xx' } }])
    h.options.verifyCart = vi
      .fn()
      .mockResolvedValueOnce({ present: false, quantity: null })
      .mockResolvedValueOnce({ present: true, quantity: 2, unitPrice: 69.99 })

    await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({
      quantity: 2,
      source: 'mutation-2xx'
    })
    expect(h.options.verifyCart).toHaveBeenCalledTimes(2)
    expect(h.options.restoreProduct).not.toHaveBeenCalled()
  })

  it('accepts the header cart count when the cart-row parser keeps failing', async () => {
    const h = harness([{ kind: 'success', status: 200, evidence: { source: 'mutation-2xx' } }])
    h.options.verifyCart = vi.fn(async () => ({ present: false, quantity: null }))
    h.options.recoverAmbiguousCart = vi.fn(async () => ({
      present: true,
      quantity: 2,
      unitPrice: null
    }))

    await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({
      quantity: 2,
      source: 'header-cart-badge'
    })
    expect(h.options.restoreProduct).not.toHaveBeenCalled()
  })

  it('still retries the product page when nothing ever confirms the cart', async () => {
    const h = harness([
      { kind: 'success', status: 200, evidence: { source: 'mutation-2xx' } },
      { kind: 'success', status: 200, evidence: { source: 'mutation-2xx' } }
    ])
    h.options.verifyCart = vi.fn(async () => ({ present: false, quantity: null }))
    h.options.recoverAmbiguousCart = vi.fn(async () => ({ present: false, quantity: null }))

    await runTargetCartAttempt(h.options).catch(() => {})
    expect(h.options.restoreProduct).toHaveBeenCalled()
  })

  it('does not spend extra verification attempts on weak evidence', async () => {
    // Only Target's own confirmation earns the retries; a guess does not.
    const h = harness([{ kind: 'no-response', status: null, evidence: null }])
    h.options.getProbableEvidence = vi
      .fn()
      .mockResolvedValueOnce({ source: 'speculative', mutationStatus: null })
      .mockResolvedValue(null)
    h.options.verifyCart = vi.fn(async () => ({ present: false, quantity: null }))

    await runTargetCartAttempt(h.options).catch(() => {})
    expect(h.options.verifyCart).toHaveBeenCalledTimes(1)
  })
})
