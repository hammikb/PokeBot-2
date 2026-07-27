import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

vi.mock('../../../../src/main/automation/TraceRecorder.js', () => ({
  startTrace: vi.fn(async () => ({
    tracePath: 'trace.zip',
    screenshotPath: 'screenshot.png',
    capture: vi.fn(),
    stop: vi.fn()
  }))
}))

vi.mock('../../../../src/main/automation/CheckoutDiagnostics.js', () => ({
  startCheckoutDiagnostics: vi.fn(async () => ({
    capture: vi.fn(async () => 'diagnostics.json'),
    dispose: vi.fn()
  }))
}))

vi.mock('../../../../src/main/automation/NativeInputBridge.js', () => ({
  NativeInputBridge: {
    create: vi.fn(async (page) => ({
      click: vi.fn(async (selector) => page.locator(selector).first().click()),
      fill: vi.fn(async (selector, value) => page.locator(selector).first().fill(value))
    }))
  }
}))

vi.mock('../../../../src/main/automation/flows/checkout-fields.js', () => ({
  fillCheckoutPayment: vi.fn(async () => ({ filled: [], missing: [] }))
}))

import { runWalmartFlow } from '../../../../src/main/automation/flows/walmart.js'
import { runSamsClubFlow } from '../../../../src/main/automation/flows/samsclub.js'
import { runPokemonCenterFlow } from '../../../../src/main/automation/flows/pokemon-center.js'
import { submitTargetOrder } from '../../../../src/main/automation/flows/target.js'

function baseLocator(page, selector, { count = 1, innerText = '', onClick = null } = {}) {
  return {
    first() {
      return this
    },
    locator(childSelector) {
      return page.locator(childSelector)
    },
    async count() {
      return count
    },
    async isVisible() {
      return count > 0
    },
    async isDisabled() {
      return false
    },
    async waitFor() {
      if (/thank you|order \(confirmed\|number\)|we received your order/i.test(selector)) {
        throw new Error('Confirmation timeout')
      }
    },
    async click() {
      onClick?.()
      page.clicks.push(selector)
    },
    async fill() {},
    async hover() {},
    async innerText() {
      return innerText
    },
    async getAttribute() {
      return ''
    }
  }
}

function contextFor(page) {
  return {
    newPage: vi.fn(async () => page),
    pages: vi.fn(() => [page])
  }
}

describe('irreversible order submission safety', () => {
  it('marks the Target submission boundary before a Place order click can become ambiguous', async () => {
    const placeOrder = {
      first() {
        return this
      },
      isVisible: vi.fn(async () => true),
      isDisabled: vi.fn(async () => false),
      click: vi.fn(async () => {
        throw new Error('Network timeout after click dispatch')
      })
    }
    const hidden = {
      first() {
        return this
      },
      locator() {
        return this
      },
      isVisible: vi.fn(async () => false),
      isDisabled: vi.fn(async () => true)
    }
    const page = {
      locator(selector) {
        return /placeOrderButton|Place your order|Place order/.test(selector) ? placeOrder : hidden
      }
    }
    const onSubmissionAttempted = vi.fn()
    const onMilestone = vi.fn()

    await expect(
      submitTargetOrder(page, placeOrder, {
        cvv: '',
        onStep: vi.fn(),
        onMilestone,
        maxSubmitRetries: 0,
        orderSubmissionGate: { claim: () => true },
        orderSubmissionKey: 'account-1:1',
        onSubmissionAttempted
      })
    ).rejects.toThrow('Network timeout after click dispatch')

    expect(onSubmissionAttempted).toHaveBeenCalledTimes(1)
    expect(onMilestone).toHaveBeenCalledWith('order_submitted', 'Target Place your order clicked')
  })

  it('leaves Walmart open for manual review when confirmation times out after Place order', async () => {
    const page = {
      clicks: [],
      closed: false,
      locator(selector) {
        const count =
          /Join Waitlist|Sign in|Sign In/.test(selector) &&
          !/place-order|Place order/i.test(selector)
            ? 0
            : 1
        return baseLocator(this, selector, { count })
      },
      goto: vi.fn(),
      waitForSelector: vi.fn(async (selector) => {
        if (/order-confirmation|thank you|order number/i.test(selector)) {
          throw new Error('Network timeout waiting for confirmation')
        }
      }),
      waitForTimeout: vi.fn(),
      evaluate: vi.fn(async () => ({
        itemId: '123456',
        quantity: 1,
        unitPrice: 29.97,
        seller: 'Sold and shipped by Walmart.com'
      })),
      close: vi.fn(async function () {
        this.closed = true
      })
    }
    const onMilestone = vi.fn()

    const result = await runWalmartFlow(contextFor(page), {
      productUrl: 'https://www.walmart.com/ip/example/123456',
      cvv: '123',
      account: {},
      mode: 'monitor-and-buy',
      onMilestone
    })

    expect(result).toMatchObject({
      success: false,
      terminal: true,
      orderSubmissionAttempted: true,
      submissionUncertain: true,
      requiresManualCheckout: true,
      cause: 'Network timeout waiting for confirmation'
    })
    expect(result.error).toContain('Do not retry')
    expect(onMilestone).toHaveBeenCalledWith(
      'order_submitted',
      'Walmart Place order action initiated'
    )
    expect(page.closed).toBe(false)
  })

  it("leaves Sam's Club open for manual review when confirmation is uncertain", async () => {
    const page = {
      clicks: [],
      closed: false,
      currentUrl: 'https://www.samsclub.com/p/example/19170800669',
      url() {
        return this.currentUrl
      },
      locator(selector) {
        if (selector === 'body') {
          return baseLocator(this, selector, {
            innerText: this.currentUrl.includes('/checkout')
              ? 'Checkout Review order Place order'
              : 'Shipping Arrives tomorrow Add to Cart'
          })
        }
        if (
          /Sign In to See Price|button\[aria-label\*="Account"|input\[type="email"|input\[type="password"/i.test(
            selector
          )
        ) {
          return baseLocator(this, selector, { count: 0 })
        }
        if (
          /select\[aria-label\*="quantity"|input\[aria-label\*="quantity"|button\[aria-label\*="quantity"|Increase quantity|Decrease quantity/i.test(
            selector
          )
        ) {
          return baseLocator(this, selector, { count: 0 })
        }
        const onClick = /main button.*Add to Cart/i.test(selector)
          ? () => {
              this.currentUrl = 'https://www.samsclub.com/pac?id=19170800669'
            }
          : /Check Out|Checkout|Begin checkout/.test(selector)
            ? () => {
                this.currentUrl = 'https://www.samsclub.com/checkout/review-order'
              }
            : null
        return baseLocator(this, selector, {
          innerText: '$29.97',
          onClick
        })
      },
      getByRole() {
        return baseLocator(this, 'role', { count: 0 })
      },
      async goto(url) {
        this.currentUrl = url
      },
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {
        throw new Error('Confirmation network timeout')
      }),
      close: vi.fn(async function () {
        this.closed = true
      })
    }
    const onMilestone = vi.fn()

    const result = await runSamsClubFlow(contextFor(page), {
      productUrl: 'https://www.samsclub.com/p/example/19170800669',
      account: {},
      mode: 'monitor-and-buy',
      onMilestone
    })

    expect(result).toMatchObject({
      success: false,
      terminal: true,
      orderSubmissionAttempted: true,
      submissionUncertain: true,
      requiresManualCheckout: true
    })
    expect(result.error).toContain('Do not retry')
    expect(onMilestone).toHaveBeenCalledWith(
      'order_submitted',
      "Sam's Club Place order action initiated"
    )
    expect(page.closed).toBe(false)
  })

  it('leaves Pokémon Center open for manual review when confirmation times out', async () => {
    const page = {
      clicks: [],
      closed: false,
      locator(selector) {
        const count = /Join Queue|Enter Queue|#btn-queue|input\[type="email"/i.test(selector)
          ? 0
          : 1
        return baseLocator(this, selector, { count })
      },
      goto: vi.fn(),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      close: vi.fn(async function () {
        this.closed = true
      })
    }
    const onMilestone = vi.fn()

    const result = await runPokemonCenterFlow(contextFor(page), {
      productUrl: 'https://www.pokemoncenter.com/product/example',
      account: {},
      mode: 'monitor-and-buy',
      onMilestone
    })

    expect(result).toMatchObject({
      success: false,
      terminal: true,
      orderSubmissionAttempted: true,
      submissionUncertain: true,
      requiresManualCheckout: true,
      cause: 'Confirmation timeout'
    })
    expect(result.error).toContain('Do not retry')
    expect(onMilestone).toHaveBeenCalledWith(
      'order_submitted',
      'Pokémon Center Place Order action initiated'
    )
    expect(page.closed).toBe(false)
  })
})
