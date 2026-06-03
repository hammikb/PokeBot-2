import { describe, expect, it, vi } from 'vitest'
import { runWalmartFlow } from '../../../../src/main/automation/flows/walmart.js'

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

function makePage({ throws = {} } = {}) {
  const page = {
    clicks: [],
    fills: [],
    waits: [],
    closed: false,
    async goto(url) {
      this.lastUrl = url
    },
    locator(selector) {
      return makeLocator(page, selector, throws)
    },
    async waitForSelector(selector) {
      this.waits.push(selector)
    },
    async textContent() {
      return 'order-123'
    },
    async close() {
      this.closed = true
    }
  }
  return page
}

function makeLocator(page, selector, throws) {
  return {
    first() {
      return this
    },
    async click() {
      for (const [key, msg] of Object.entries(throws)) {
        if (selector.includes(key)) throw new Error(msg)
      }
      page.clicks.push(selector)
    },
    async count() {
      if (selector.includes('Sign in') || selector.includes('Sign In')) return 0
      if (selector.includes('input[name="password"][type="password"]')) return 0
      if (selector.includes('Join Waitlist')) return 0
      return 1
    },
    async fill(value) {
      page.fills.push({ selector, value })
    },
    async waitFor() {
      page.waits.push(selector)
    }
  }
}

function makeContext(page) {
  return {
    async newPage() {
      return page
    }
  }
}

describe('checkout test mode', () => {
  it('stops Walmart checkout before clicking Place order', async () => {
    const page = makePage()
    const onStep = vi.fn()

    const result = await runWalmartFlow(makeContext(page), {
      productUrl: 'https://www.walmart.com/ip/example/123',
      cvv: '456',
      mode: 'test-checkout',
      onStep
    })

    expect(result).toMatchObject({
      success: true,
      testMode: true,
      requiresManualCheckout: true
    })
    expect(page.fills).toContainEqual({
      selector: expect.stringContaining('cvv'),
      value: '456'
    })
    expect(
      page.clicks.some(
        (selector) => selector.includes('Place order') || selector.includes('place-order')
      )
    ).toBe(false)
    expect(page.closed).toBe(false)
    expect(onStep).toHaveBeenCalledWith('Opening product page')
    expect(onStep).toHaveBeenCalledWith('Waiting for Place order button')
    expect(onStep).toHaveBeenCalledWith('Reached Place order button; stopping for test mode')
  })
})
