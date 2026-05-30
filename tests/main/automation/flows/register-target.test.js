import { describe, expect, it, vi } from 'vitest'
import { runTargetRegistration } from '../../../../src/main/automation/flows/register-target.js'

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
  // Matches the error locator: '[data-test="errorMessage"], [class*="error"], [class*="Error"]'
  const isErrorEl = /errorMessage|class\*="error|class\*="Error/.test(selector)
  const isConfirm = /confirmPassword/.test(selector)
  return {
    first() { return this },
    async count() {
      if (isErrorEl) return errorText ? 1 : 0
      if (isConfirm) return 0
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
  notificationEngine: { fire: vi.fn() }
}

describe('runTargetRegistration', () => {
  it('navigates to Target create-account page', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.lastUrl).toContain('target.com/account/create-account')
  })

  it('fills email, password, first and last name', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.fills.some(f => f.value === 'test@example.com')).toBe(true)
    expect(page.fills.some(f => f.value === 'SecurePass1!')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ash')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ketchum')).toBe(true)
  })

  it('returns success with needsVerification on registration', async () => {
    const page = makePage()
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: true, needsVerification: true })
  })

  it('returns alreadyExists when error text matches', async () => {
    const page = makePage({ errorText: 'This email is already registered' })
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: false, alreadyExists: true })
  })

  it('closes page on success', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
  })

  it('closes page on error', async () => {
    const page = makePage({ waitForUrlResolves: false })
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
    expect(result.success).toBe(false)
  })
})
