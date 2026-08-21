import { describe, expect, it, vi } from 'vitest'

import {
  clickAndObserveTargetCart,
  dismissVisibleTargetCartTransient,
  readTargetHeaderCartQuantity,
  getTargetProbableCartEvidence,
  getVisibleTargetAddToCartButton,
  isTargetCartMutationResponse
} from '../../../../../src/main/automation/flows/target/TargetCartSignals.js'

function response(
  status,
  retryAfter = null,
  url = 'https://carts.target.com/web_checkouts/v1/cart_items',
  method = 'POST'
) {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ method: () => method }),
    headers: () => (retryAfter === null ? {} : { 'retry-after': retryAfter })
  }
}

function hiddenLocator() {
  return { first: () => ({ isVisible: async () => false }) }
}

describe('TargetCartSignals', () => {
  it('matches only the exact HTTPS Target cart mutation boundary while allowing a query', () => {
    expect(
      isTargetCartMutationResponse(
        response(200, null, 'https://carts.target.com/web_checkouts/v1/cart_items?channel=web')
      )
    ).toBe(true)

    const wrongBoundaries = [
      ['protocol', 'http://carts.target.com/web_checkouts/v1/cart_items', 'POST'],
      ['host', 'https://carts.target.com.evil.example/web_checkouts/v1/cart_items', 'POST'],
      ['path prefix', 'https://carts.target.com/api/web_checkouts/v1/cart_items', 'POST'],
      ['path suffix', 'https://carts.target.com/web_checkouts/v1/cart_items/extra', 'POST'],
      ['method', 'https://carts.target.com/web_checkouts/v1/cart_items', 'GET']
    ]

    for (const [, url, method] of wrongBoundaries) {
      expect(isTargetCartMutationResponse(response(200, null, url, method))).toBe(false)
    }
  })

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

  it('goes for the X first and does not wait out the slide-in animation', async () => {
    let open = true
    const click = vi.fn(async () => {
      open = false
    })
    const child = { first: () => ({ click }) }
    const visibleDialog = { isVisible: vi.fn(async () => open), locator: vi.fn(() => child) }
    const page = { locator: vi.fn(() => ({ first: () => visibleDialog })) }

    await expect(dismissVisibleTargetCartTransient(page)).resolves.toBe(true)

    expect(page.locator.mock.calls[0][0]).toContain(':visible')
    // The close control is tried on its own before any text button, because a selector
    // union resolves in DOM order and the X is rendered last in Target's side sheet.
    const firstSelector = visibleDialog.locator.mock.calls[0][0]
    expect(firstSelector).toContain('close')
    expect(firstSelector).not.toContain('Continue shopping')
    expect(visibleDialog.locator).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledWith({ timeout: 250, force: true })
  })

  it('falls back to the passive text controls when the X will not take a click', async () => {
    const click = vi.fn(async () => {
      throw new Error('intercepted by overlay')
    })
    const visibleDialog = {
      isVisible: vi.fn(async () => true),
      locator: vi.fn(() => ({ first: () => ({ click }) })),
      press: vi.fn(async () => {})
    }
    const page = { locator: vi.fn(() => ({ first: () => visibleDialog })) }

    await expect(dismissVisibleTargetCartTransient(page)).resolves.toBe(false)

    const fallbackSelector = visibleDialog.locator.mock.calls[1][0]
    expect(fallbackSelector).toContain('Continue shopping')
    expect(fallbackSelector).not.toContain('Try again')
    // Dismissal must stay passive: never a control that advances checkout.
    expect(fallbackSelector).not.toMatch(/Continue(?! shopping)/)
    expect(fallbackSelector).not.toContain('checkout')
    expect(visibleDialog.press).toHaveBeenCalledWith('Escape')
  })

  it('does not wait for a close button when no cart transient is visible', async () => {
    const click = vi.fn(async () => {})
    const hiddenDialog = {
      isVisible: vi.fn(async () => false),
      locator: vi.fn(() => ({ first: () => ({ click }) }))
    }
    const page = { locator: vi.fn(() => ({ first: () => hiddenDialog })) }

    await expect(dismissVisibleTargetCartTransient(page)).resolves.toBe(false)

    expect(hiddenDialog.locator).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'session-error'],
    [403, 'session-error'],
    [409, 'success'],
    [418, 'transient'],
    [503, 'transient']
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const page = {
      waitForResponse: vi.fn(async () => response(status)),
      locator: vi.fn(() => hiddenLocator())
    }
    const button = { click: vi.fn(async () => {}) }
    await expect(
      clickAndObserveTargetCart({ page, button, tcin: '123456' })
    ).resolves.toMatchObject({
      kind,
      status
    })
  })

  it('stops waiting on the outcome window once the not-added sheet appears', async () => {
    // The HTTP response never arrives; without the early exit this would sit out the
    // full outcomeMs with the side sheet on screen before anything dismissed it.
    let responseSettled = false
    const page = {
      waitForResponse: vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              responseSettled = true
              resolve(null)
            }, 3000)
          })
      ),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector) => ({
        first: () => ({
          isVisible: async () => selector.includes('item was not added'),
          waitFor: async () =>
            selector.includes('item was not added') ? undefined : new Promise(() => {})
        })
      }))
    }
    const button = { click: vi.fn(async () => {}) }

    const outcome = await clickAndObserveTargetCart({
      page,
      button,
      tcin: '123456',
      outcomeMs: 3000,
      transientGraceMs: 0
    })

    expect(outcome).toMatchObject({ kind: 'transient' })
    expect(responseSettled).toBe(false)
  })

  it('does not report success when a forced click is swallowed by the overlay', async () => {
    // force:true skips the "receives events" check, so the click resolves even when the
    // overlay ate it. The panel still being on screen is the only trustworthy signal.
    const click = vi.fn(async () => {})
    const visibleDialog = {
      isVisible: vi.fn(async () => true),
      locator: vi.fn(() => ({ first: () => ({ click }) })),
      press: vi.fn(async () => {})
    }
    const page = { locator: vi.fn(() => ({ first: () => visibleDialog })) }

    await expect(dismissVisibleTargetCartTransient(page)).resolves.toBe(false)
    expect(visibleDialog.press).toHaveBeenCalledWith('Escape')
  })

  it('prefers the aria-label count over the badge span', async () => {
    // Verified against a live page: <a data-test="@web/CartLink" aria-label="cart 0 items">
    // The badge span is absent entirely at zero, so the label is the only source of a
    // trustworthy 0 - and 0 is the baseline every add is measured against.
    const make = (label, badgeText) => ({
      locator: (selector) => ({
        first: () => ({
          count: async () =>
            selector.includes('CartLinkQuantity') ? (badgeText === null ? 0 : 1) : 1,
          getAttribute: async () => label,
          textContent: async () => badgeText
        })
      })
    })
    await expect(readTargetHeaderCartQuantity(make('cart 0 items', null))).resolves.toBe(0)
    await expect(readTargetHeaderCartQuantity(make('cart 3 items', '9'))).resolves.toBe(3)
    await expect(readTargetHeaderCartQuantity(make('cart 1 item', null))).resolves.toBe(1)
  })

  it('falls back to the badge, then to 0, when the label is unusable', async () => {
    const page = (label, badge) => ({
      locator: (selector) => ({
        first: () => ({
          count: async () => (selector.includes('CartLinkQuantity') ? (badge === null ? 0 : 1) : 1),
          getAttribute: async () => label,
          textContent: async () => badge
        })
      })
    })
    await expect(readTargetHeaderCartQuantity(page(null, '4'))).resolves.toBe(4)
    await expect(readTargetHeaderCartQuantity(page(null, null))).resolves.toBe(0)
  })

  it('returns null when the header has not rendered, never a guessed 0', async () => {
    const page = { locator: () => ({ first: () => ({ count: async () => 0 }) }) }
    await expect(readTargetHeaderCartQuantity(page)).resolves.toBeNull()
  })
})
