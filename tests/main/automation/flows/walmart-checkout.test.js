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

// Mock NativeInputBridge so tests don't need nut-js or a real browser window.
// The mock delegates back to page.locator() so existing test assertions still work.
vi.mock('../../../../src/main/automation/NativeInputBridge.js', () => ({
  NativeInputBridge: {
    create: vi.fn(async (page) => ({
      isNative: false,
      click: vi.fn(async (selector) => page.locator(selector).first().click()),
      fill: vi.fn(async (selector, value) => page.locator(selector).first().fill(value)),
      type: vi.fn(async (selector, text) => page.locator(selector).first().fill(text)),
      press: vi.fn(async (key) => page.keyboard?.press(key))
    }))
  }
}))

function makePage({ counts = {}, throws = {}, orderId = 'order-123' } = {}) {
  const page = {
    fills: [],
    clicks: [],
    waits: [],
    closed: false,
    urls: [],
    async goto(url) {
      this.urls.push(url)
      this.lastUrl = url
    },
    locator(selector) {
      return makeLocator(page, selector, counts, throws)
    },
    async waitForSelector(sel) {
      this.waits.push(sel)
    },
    async textContent() {
      return orderId
    },
    async close() {
      this.closed = true
    }
  }
  return page
}

function makeLocator(page, selector, counts, throws) {
  return {
    first() {
      return this
    },
    async count() {
      for (const [key, val] of Object.entries(counts)) {
        if (selector.includes(key)) return val
      }
      if (selector.includes('Sign in') || selector.includes('Sign In')) return 0
      return 1
    },
    async fill(value) {
      page.fills.push({ selector, value })
    },
    async click() {
      for (const [key, msg] of Object.entries(throws)) {
        if (selector.includes(key)) throw new Error(msg)
      }
      page.clicks.push(selector)
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

const BASE = {
  productUrl: 'https://www.walmart.com/ip/pokemon-cards/123456',
  cvv: '456',
  account: { username: 'ash@example.com', password: 'SecurePass1!' },
  notificationEngine: { fire: vi.fn() },
  dropEvent: {
    productName: 'Pokemon Cards',
    productUrl: 'https://www.walmart.com/ip/pokemon-cards/123456'
  },
  mode: 'monitor-and-buy'
}

describe('runWalmartFlow', () => {
  it('full checkout: skips queue, adds to cart, navigates to checkout, fills CVV, places order, returns orderId', async () => {
    const page = makePage({ counts: { 'Join Waitlist': 0 } })
    const result = await runWalmartFlow(makeContext(page), BASE)

    expect(result).toMatchObject({ success: true, orderId: 'order-123' })
    expect(page.urls).toContain('https://www.walmart.com/checkout')
    expect(page.fills.some((f) => f.value === '456')).toBe(true)
    expect(page.clicks.some((s) => s.includes('Place order') || s.includes('place-order'))).toBe(
      true
    )
    expect(page.closed).toBe(true)
  })

  it('joins queue when waitlist button is present then continues checkout', async () => {
    const page = makePage({ counts: { 'Join Waitlist': 1 } })
    const result = await runWalmartFlow(makeContext(page), BASE)

    expect(result).toMatchObject({ success: true })
    expect(page.clicks.some((s) => s.includes('Join Waitlist'))).toBe(true)
    expect(page.waits.some((s) => s.includes('add-to-cart') || s.includes('atc'))).toBe(true)
  })

  it('signs into Walmart before checkout when the session is logged out', async () => {
    const page = makePage({ counts: { 'Sign in': 1, 'Join Waitlist': 0 } })
    const result = await runWalmartFlow(makeContext(page), BASE)

    expect(result).toMatchObject({ success: true })
    expect(page.urls).toContain('https://www.walmart.com/account/login')
    expect(page.fills.some((f) => f.value === 'ash@example.com')).toBe(true)
    expect(page.fills.some((f) => f.value === 'SecurePass1!')).toBe(true)
    expect(page.urls.at(-1)).toBe('https://www.walmart.com/checkout')
  })

  it('returns a clear error when Walmart sign-in is required without credentials', async () => {
    const page = makePage({ counts: { 'Sign in': 1 } })
    const result = await runWalmartFlow(makeContext(page), { ...BASE, account: {} })

    expect(result).toMatchObject({
      success: false,
      error: 'Walmart checkout requires a signed-in account with username and password'
    })
  })

  it('returns error when add to cart throws', async () => {
    const page = makePage({
      counts: { 'Join Waitlist': 0 },
      throws: { 'data-automation-id="atc"': 'Product sold out' }
    })
    const result = await runWalmartFlow(makeContext(page), BASE)

    expect(result).toMatchObject({ success: false, error: 'Product sold out' })
  })

  it('closes page on error', async () => {
    const page = makePage({ throws: { 'data-automation-id="atc"': 'Network timeout' } })
    await runWalmartFlow(makeContext(page), BASE)

    expect(page.closed).toBe(true)
  })

  it('skips CVV fill when CVV field is not present on checkout page', async () => {
    const page = makePage({ counts: { 'Join Waitlist': 0, cvv: 0 } })
    const result = await runWalmartFlow(makeContext(page), BASE)

    expect(result).toMatchObject({ success: true })
    expect(page.fills.some((f) => f.value === '456')).toBe(false)
  })

  it('handles missing order number gracefully', async () => {
    const page = makePage({ counts: { 'Join Waitlist': 0 } })
    page.textContent = async () => {
      throw new Error('element not found')
    }
    const result = await runWalmartFlow(makeContext(page), BASE)

    expect(result).toMatchObject({ success: true, orderId: 'unknown' })
  })

  it('navigates to product URL first', async () => {
    const page = makePage({ counts: { 'Join Waitlist': 0 } })
    await runWalmartFlow(makeContext(page), BASE)

    expect(page.urls[0]).toBe('https://www.walmart.com/ip/pokemon-cards/123456')
  })
})
