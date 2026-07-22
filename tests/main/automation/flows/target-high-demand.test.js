import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn(async () => {})
}))

import {
  enableTargetCheckoutLiteMode,
  fillTargetCardVerification,
  getVisibleTargetAddToCartButton,
  isTargetCartApiCoolingDown,
  markTargetCartApiRateLimited,
  submitTargetOrder,
  waitForTargetAddToCartReady,
  waitForTargetOrderReview
} from '../../../../src/main/automation/flows/target.js'

function makeTargetPage() {
  const state = { submitClicks: 0, blockerVisible: false, confirmed: false }

  const page = {
    state,
    url: () => 'https://www.target.com/checkout',
    waitForTimeout: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    locator(selector) {
      if (selector.includes('placeOrderButton')) {
        return locator({
          isVisible: () => true,
          click: () => {
            state.submitClicks += 1
            if (state.submitClicks === 1) state.blockerVisible = true
            else state.confirmed = true
          }
        })
      }

      if (selector.includes('little busier than we expected')) {
        return locator({
          isVisible: () => state.blockerVisible,
          child: locator({
            click: () => {
              state.blockerVisible = false
            }
          })
        })
      }

      if (selector.includes('cvv')) return locator({ count: () => 0 })
      if (
        selector.includes('Order confirmed') ||
        selector.includes('Thank you') ||
        selector.includes('Order placed') ||
        selector.includes('order-confirmation') ||
        selector.includes('Your order is confirmed')
      ) {
        return locator({ count: () => (state.confirmed ? 1 : 0) })
      }

      return locator()
    }
  }

  return page
}

function locator({
  isVisible = () => false,
  isDisabled = () => false,
  click = () => {},
  count = () => 0,
  fill = () => {},
  child
} = {}) {
  return {
    first() {
      return this
    },
    locator() {
      return child || locator()
    },
    async isVisible() {
      return isVisible()
    },
    async click() {
      return click()
    },
    async count() {
      return count()
    },
    async isDisabled() {
      return isDisabled()
    },
    async isChecked() {
      return false
    },
    async check() {},
    async fill(value) {
      return fill(value)
    }
  }
}

function makeGenericErrorPage() {
  const page = makeTargetPage()
  const originalLocator = page.locator.bind(page)
  page.locator = (selector) => {
    if (selector.includes('could not complete your order')) {
      return locator({
        isVisible: () => page.state.blockerVisible,
        child: locator({
          click: () => {
            page.state.blockerVisible = false
          }
        })
      })
    }
    if (selector.includes('little busier than we expected')) return locator()
    return originalLocator(selector)
  }
  return page
}

describe('Target high-demand checkout submission', () => {
  it('holds the current checkout page without reloading when Target shows high demand', async () => {
    const state = { highDemand: true }
    const page = {
      frames: () => [],
      reload: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector) => {
        if (selector.includes('placeOrderButton')) {
          return locator({
            isVisible: () => !state.highDemand,
            isDisabled: () => false
          })
        }
        if (selector.includes('little busier than we expected')) {
          return locator({
            isVisible: () => state.highDemand,
            child: locator({
              click: () => {
                state.highDemand = false
              }
            })
          })
        }
        return locator()
      })
    }

    const button = await waitForTargetOrderReview(page, {
      onStep: vi.fn(),
      notificationEngine: null,
      dropEvent: {},
      maxHighDemandRetries: 2
    })

    expect(button).toBeTruthy()
    expect(page.reload).not.toHaveBeenCalled()
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('enters the complete saved card number when Target requests verification', async () => {
    const fill = vi.fn(async () => {})
    const page = {
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn(() => locator({ isVisible: () => true, fill }))
    }
    const onStep = vi.fn()

    const filled = await fillTargetCardVerification(page, '4111 1111-1111 1111', onStep)

    expect(filled).toBe(true)
    expect(fill).toHaveBeenCalledWith('4111111111111111')
    expect(onStep).toHaveBeenCalledWith('Entering full card number for Target verification')
  })

  it('finds Target card verification inside a secure payment frame', async () => {
    const fill = vi.fn(async () => {})
    const hidden = locator({ isVisible: () => false })
    const secureInput = locator({ isVisible: () => true, fill })
    const page = {
      frames: () => [{ locator: vi.fn(() => hidden) }, { locator: vi.fn(() => secureInput) }],
      waitForTimeout: vi.fn(async () => {})
    }

    const filled = await fillTargetCardVerification(page, '4111111111111111')

    expect(filled).toBe(true)
    expect(fill).toHaveBeenCalledWith('4111111111111111')
  })

  it('lite mode blocks heavy and known ad traffic but preserves Target checkout requests', async () => {
    let handler
    const page = {
      route: vi.fn(async (_pattern, routeHandler) => {
        handler = routeHandler
      })
    }
    await enableTargetCheckoutLiteMode(page)

    const media = makeRoute('media', 'https://www.target.com/video/demo.mp4')
    const font = makeRoute('font', 'https://www.target.com/fonts/site.woff2')
    const ad = makeRoute('script', 'https://stats.doubleclick.net/ad.js')
    const checkout = makeRoute('fetch', 'https://carts.target.com/web_checkouts/v1/cart')

    await handler(media)
    await handler(font)
    await handler(ad)
    await handler(checkout)

    expect(media.abort).toHaveBeenCalledTimes(1)
    expect(font.abort).toHaveBeenCalledTimes(1)
    expect(ad.abort).toHaveBeenCalledTimes(1)
    expect(checkout.continue).toHaveBeenCalledTimes(1)
    expect(checkout.abort).not.toHaveBeenCalled()
  })

  it('temporarily bypasses the cart API after Target rate limits it', () => {
    markTargetCartApiRateLimited(1_000)

    expect(isTargetCartApiCoolingDown(1_001)).toBe(true)
    expect(isTargetCartApiCoolingDown(601_001)).toBe(false)
  })

  it('targets only visible Add to cart buttons so hidden disabled duplicates are ignored', () => {
    const visibleButton = { id: 'visible-product-button' }
    const locatorResult = { first: vi.fn(() => visibleButton) }
    const page = { locator: vi.fn(() => locatorResult) }

    expect(getVisibleTargetAddToCartButton(page)).toBe(visibleButton)
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining(':visible'))
  })

  it('waits for Target fulfillment to settle before treating the cart button as unavailable', async () => {
    const state = { loading: true, disabled: true }
    const addButton = locator({
      isVisible: () => true,
      isDisabled: () => state.disabled
    })
    const page = {
      frames: () => [],
      waitForTimeout: vi.fn(async () => {
        state.loading = false
        state.disabled = false
      }),
      locator: vi.fn((selector) => {
        if (selector.includes('Add to cart')) return addButton
        if (selector.includes('fulfillment')) {
          return locator({ count: () => (state.loading ? 1 : 0) })
        }
        return locator({ count: () => 0 })
      })
    }

    await expect(
      waitForTargetAddToCartReady(page, {
        timeoutMs: 100,
        pollMs: 1,
        onStep: vi.fn(),
        notificationEngine: null,
        dropEvent: {}
      })
    ).resolves.toBe(addButton)
    expect(page.waitForTimeout).toHaveBeenCalled()
  })

  it('dismisses the post-submit busy dialog and retries Place your order', async () => {
    const page = makeTargetPage()
    const onStep = vi.fn()
    const placeOrderButton = page.locator('button[data-test="placeOrderButton"]')

    const confirmed = await submitTargetOrder(page, placeOrderButton, {
      cvv: null,
      onStep,
      notificationEngine: null,
      dropEvent: {},
      maxSubmitRetries: 2
    })

    expect(confirmed).toBe(true)
    expect(page.state.submitClicks).toBe(2)
    expect(page.reload).not.toHaveBeenCalled()
    expect(onStep).toHaveBeenCalledWith(
      'Target rejected checkout - clearing the message (retry 1/2)'
    )
    expect(onStep).toHaveBeenCalledWith('Retrying Place your order (1/2)')
  })

  it('retries Target generic order-completion errors without rebuilding checkout', async () => {
    const page = makeGenericErrorPage()
    const placeOrderButton = page.locator('button[data-test="placeOrderButton"]')

    const confirmed = await submitTargetOrder(page, placeOrderButton, {
      cvv: null,
      onStep: vi.fn(),
      notificationEngine: null,
      dropEvent: {},
      maxSubmitRetries: 2
    })

    expect(confirmed).toBe(true)
    expect(page.state.submitClicks).toBe(2)
    expect(page.reload).not.toHaveBeenCalled()
  })
})

function makeRoute(resourceType, url) {
  return {
    request: () => ({ resourceType: () => resourceType, url: () => url }),
    abort: vi.fn(async () => {}),
    continue: vi.fn(async () => {})
  }
}
