import { describe, expect, it, vi } from 'vitest'
import { runWalmartRegistration } from '../../../../src/main/automation/flows/register-walmart.js'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

function makePage({ errorText = null, waitForUrlResolves = true } = {}) {
  const page = {
    fills: [],
    clicks: [],
    closed: false,
    lastUrl: null,
    async goto(url) {
      this.lastUrl = url
    },
    locator(selector) {
      return makeLocator(page, selector, errorText)
    },
    async waitForURL() {
      if (!waitForUrlResolves) throw new Error('URL did not change')
    },
    async close() {
      this.closed = true
    }
  }
  return page
}

function makeLocator(page, selector, errorText) {
  // Matches the error locator: '[class*="error-text"], [class*="ErrorText"], [role="alert"]'
  const isErrorEl = /error-text|ErrorText|role="alert"/.test(selector)
  return {
    first() { return this },
    async count() {
      if (isErrorEl) return errorText ? 1 : 0
      return 1
    },
    async fill(value) {
      page.fills.push({ selector, value })
    },
    async click() {
      page.clicks.push(selector)
    },
    async textContent() {
      return errorText || ''
    }
  }
}

function makeContext(page) {
  return { async newPage() { return page } }
}

const baseArgs = {
  email: 'test@example.com',
  password: 'SecurePass1!',
  firstName: 'Ash',
  lastName: 'Ketchum',
  phone: '5551234567',
  notificationEngine: { fire: vi.fn() }
}

describe('runWalmartRegistration', () => {
  it('navigates to Walmart signup page', async () => {
    const page = makePage()
    await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.lastUrl).toContain('walmart.com/account/signup')
  })

  it('fills all fields including phone', async () => {
    const page = makePage()
    await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.fills.some(f => f.value === 'test@example.com')).toBe(true)
    expect(page.fills.some(f => f.value === 'SecurePass1!')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ash')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ketchum')).toBe(true)
    expect(page.fills.some(f => f.value === '5551234567')).toBe(true)
  })

  it('returns success with needsVerification on registration', async () => {
    const page = makePage()
    const result = await runWalmartRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: true, needsVerification: true })
  })

  it('returns alreadyExists when error text matches', async () => {
    const page = makePage({ errorText: 'An account already exists with this email' })
    const result = await runWalmartRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: false, alreadyExists: true })
  })

  it('closes page on success', async () => {
    const page = makePage()
    await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
  })

  it('closes page on error', async () => {
    const page = makePage({ waitForUrlResolves: false })
    const result = await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
    expect(result.success).toBe(false)
  })
})
