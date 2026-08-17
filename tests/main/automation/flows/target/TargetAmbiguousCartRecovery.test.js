import { describe, expect, it, vi } from 'vitest'

import { recoverAmbiguousTargetCart } from '../../../../../src/main/automation/flows/target.js'

function makePage({ url = 'https://www.target.com/p/example/-/A-123456', gotoError = null } = {}) {
  let currentUrl = url
  return {
    url: vi.fn(() => currentUrl),
    goto: vi.fn(async (nextUrl) => {
      if (gotoError) throw gotoError
      currentUrl = nextUrl
    })
  }
}

describe('recoverAmbiguousTargetCart', () => {
  it('returns authoritative state for the exact requested TCIN within the probe budget', async () => {
    const page = makePage()
    const waitForCartState = vi.fn(async (_page, tcin) => ({
      present: true,
      quantity: 1,
      unitPrice: 24.99,
      source: `cart-${tcin}`
    }))

    await expect(
      recoverAmbiguousTargetCart(page, '123456', { waitForCartState, timeoutMs: 2000 })
    ).resolves.toEqual({
      present: true,
      quantity: 1,
      unitPrice: 24.99,
      source: 'cart-123456'
    })
    expect(page.goto).toHaveBeenCalledWith('https://www.target.com/co-cart', {
      waitUntil: 'commit',
      timeout: 1200
    })
    expect(waitForCartState).toHaveBeenCalledWith(page, '123456', expect.any(Number), null)
  })

  it('returns absent when the cart settles without the requested item', async () => {
    const page = makePage({ url: 'https://www.target.com/co-cart' })
    const waitForCartState = vi.fn(async () => ({
      present: false,
      quantity: null,
      source: 'target-cart-page'
    }))

    await expect(
      recoverAmbiguousTargetCart(page, '123456', { waitForCartState, timeoutMs: 2000 })
    ).resolves.toMatchObject({ present: false, recoveryOutcome: 'absent' })
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('returns timeout instead of blocking retries when cart navigation exceeds its budget', async () => {
    const page = makePage({ gotoError: new Error('page.goto: Timeout 1200ms exceeded') })
    const waitForCartState = vi.fn()

    await expect(
      recoverAmbiguousTargetCart(page, '123456', { waitForCartState, timeoutMs: 2000 })
    ).resolves.toEqual({
      present: false,
      quantity: null,
      unitPrice: null,
      source: 'ambiguous-cart-recovery',
      recoveryOutcome: 'timeout'
    })
    expect(waitForCartState).not.toHaveBeenCalled()
  })

  it('passes only the remaining portion of the 2-second budget to cart-state polling', async () => {
    const page = makePage()
    const timestamps = [1000, 2200, 2200]
    const now = vi.fn(() => timestamps.shift() ?? 2200)
    const waitForCartState = vi.fn(async () => ({ present: false, quantity: null, source: 'none' }))

    await recoverAmbiguousTargetCart(page, '123456', {
      waitForCartState,
      timeoutMs: 2000,
      now
    })

    expect(waitForCartState).toHaveBeenCalledWith(page, '123456', 800, null)
  })
})
