import { describe, expect, it, vi } from 'vitest'

import { runTargetCartAttempt } from '../../../../../src/main/automation/flows/target/TargetCartAttemptController.js'

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
      getProbableEvidence: vi.fn(async () => null),
      clickAndObserve: vi.fn(async () => outcomes.shift()),
      verifyCart: vi.fn(async () => verification),
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

  it('uses four additional no-response clicks then reloads the product once', async () => {
    const noResponse = { kind: 'no-response', status: null, evidence: null }
    const success = {
      kind: 'success',
      status: 200,
      evidence: { source: 'mutation-2xx', mutationStatus: 200 }
    }
    const h = harness([noResponse, noResponse, noResponse, noResponse, noResponse, success])
    const result = await runTargetCartAttempt(h.options)
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(6)
    expect(h.options.restoreProduct).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ clickCount: 6, retryCount: 5, reloadCount: 1 })
  })

  it('waits 400 ms for a transient modal and 1500 ms for 429 without Retry-After', async () => {
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
    expect(h.sleeps).toEqual([400, 1500])
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
    await expect(runTargetCartAttempt(tooLong.options)).rejects.toMatchObject({ code: 'deadline' })
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

  it('terminates after 30 additional recoverable clicks', async () => {
    const h = harness(
      Array.from({ length: 40 }, () => ({
        kind: 'transient',
        status: 503,
        evidence: null
      }))
    )
    await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'retry-limit' })
    expect(h.options.clickAndObserve).toHaveBeenCalledTimes(31)
  })

  it('terminates after two product reloads', async () => {
    const noResponse = { kind: 'no-response', status: null, evidence: null }
    const h = harness(Array.from({ length: 20 }, () => noResponse))
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
      'reason'
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
})
