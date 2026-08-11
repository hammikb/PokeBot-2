import { describe, expect, it, vi } from 'vitest'

import {
  clickAndObserveTargetCart,
  dismissVisibleTargetCartTransient,
  getTargetProbableCartEvidence,
  getVisibleTargetAddToCartButton
} from '../../../../../src/main/automation/flows/target/TargetCartSignals.js'

function response(status, retryAfter = null) {
  return {
    status: () => status,
    url: () => 'https://carts.target.com/web_checkouts/v1/cart_items',
    request: () => ({ method: () => 'POST' }),
    headers: () => (retryAfter === null ? {} : { 'retry-after': retryAfter })
  }
}

function hiddenLocator() {
  return { first: () => ({ isVisible: async () => false }) }
}

describe('TargetCartSignals', () => {
  it('includes exact-TCIN and visible fulfillment selectors', () => {
    const result = { first: vi.fn(() => ({ id: 'button' })) }
    const page = { locator: vi.fn(() => result) }
    expect(getVisibleTargetAddToCartButton(page, '123456')).toEqual({ id: 'button' })
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('123456'))
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining(':visible'))
  })

  it('arms response observation before clicking and classifies 2xx as probable success', async () => {
    const order = []
    const page = {
      waitForResponse: vi.fn(() => {
        order.push('armed')
        return Promise.resolve(response(200))
      }),
      locator: vi.fn(() => hiddenLocator())
    }
    const button = { click: vi.fn(async () => order.push('clicked')) }
    const result = await clickAndObserveTargetCart({ page, button, tcin: '123456' })
    expect(order).toEqual(['armed', 'clicked'])
    expect(result).toMatchObject({
      kind: 'success',
      status: 200,
      evidence: { source: 'mutation-2xx', mutationStatus: 200 }
    })
  })

  it('returns a captured response without waiting for slow click settlement', async () => {
    const page = {
      waitForResponse: vi.fn(async () => response(429)),
      locator: vi.fn(() => hiddenLocator())
    }
    const button = { click: vi.fn(() => new Promise(() => {})) }

    await expect(
      Promise.race([
        clickAndObserveTargetCart({ page, button, tcin: '123456' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('waited for click')), 50))
      ])
    ).resolves.toMatchObject({ kind: 'rate-limit', status: 429 })
  })

  it('parses Retry-After and separates 429 from a transient modal', async () => {
    const page429 = {
      waitForResponse: vi.fn(async () => response(429, '2')),
      locator: vi.fn(() => hiddenLocator())
    }
    const button = { click: vi.fn(async () => {}) }
    await expect(
      clickAndObserveTargetCart({ page: page429, button, tcin: '123456', now: () => 1000 })
    ).resolves.toMatchObject({ kind: 'rate-limit', status: 429, retryAfterMs: 2000 })

    const pageModal = {
      waitForResponse: vi.fn(async () => null),
      locator: vi.fn((selector) => ({
        first: () => ({ isVisible: async () => selector.includes('High-demand item') })
      }))
    }
    await expect(
      clickAndObserveTargetCart({ page: pageModal, button, tcin: '123456' })
    ).resolves.toMatchObject({ kind: 'transient', status: null })
  })

  it('finds visible Added to cart evidence before another click', async () => {
    const page = {
      locator: vi.fn(() => ({ first: () => ({ isVisible: async () => true }) }))
    }
    await expect(getTargetProbableCartEvidence(page, '123456')).resolves.toEqual({
      source: 'visible-added-to-cart',
      mutationStatus: null
    })
  })

  it('dismisses only visible cart transients through passive controls', async () => {
    const click = vi.fn(async () => {})
    const child = { first: () => ({ click }) }
    const visibleDialog = { locator: vi.fn(() => child) }
    const dialog = { first: () => visibleDialog }
    const page = { locator: vi.fn(() => dialog) }

    await dismissVisibleTargetCartTransient(page)

    const dialogSelector = page.locator.mock.calls[0][0]
    const buttonSelector = visibleDialog.locator.mock.calls[0][0]
    expect(dialogSelector).toContain(':visible')
    expect(buttonSelector).toContain('Close')
    expect(buttonSelector).not.toContain('Try again')
    expect(buttonSelector).not.toContain('Continue')
    expect(click).toHaveBeenCalledWith({ timeout: 750 })
  })

  it.each([
    [401, 'session-error'],
    [403, 'session-error'],
    [409, 'success'],
    [503, 'transient']
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const page = {
      waitForResponse: vi.fn(async () => response(status)),
      locator: vi.fn(() => hiddenLocator())
    }
    const button = { click: vi.fn(async () => {}) }
    await expect(clickAndObserveTargetCart({ page, button, tcin: '123456' })).resolves.toMatchObject({
      kind,
      status
    })
  })
})
