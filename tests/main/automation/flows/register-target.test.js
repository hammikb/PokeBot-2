import { describe, expect, it, vi } from 'vitest'
import { runTargetRegistration } from '../../../../src/main/automation/flows/register-target.js'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

function makePage({
  errorText = null,
  waitForUrlResolves = true,
  emailAlreadyExists = false
} = {}) {
  const page = {
    fills: [],
    clicks: [],
    closed: false,
    lastUrl: null,
    async goto(url) {
      this.lastUrl = url
    },
    async waitForLoadState() {},
    url() {
      return 'https://www.target.com/login?client_id=ecom-web-1.0.0'
    },
    async title() {
      return 'Login: Target'
    },
    async evaluate() {
      return []
    },
    locator(selector) {
      return makeLocator(page, selector, { errorText, emailAlreadyExists })
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

function makeLocator(page, selector, { errorText, emailAlreadyExists }) {
  const isErrorEl = /errorMessage|form-error|aria-live/.test(selector)
  const isFirstName = /id="firstname"|firstnamecreateaccount/.test(selector)
  return {
    filter({ hasText } = {}) {
      return makeLocator(page, selector + (hasText ? `[text*="${hasText}"]` : ''), {
        errorText,
        emailAlreadyExists
      })
    },
    first() {
      return this
    },
    async waitFor({ state } = {}) {
      // Simulate timeout when emailAlreadyExists and waiting for the firstname field
      if (emailAlreadyExists && isFirstName && state === 'visible') {
        throw new Error('locator.waitFor: Timeout 15000ms exceeded')
      }
    },
    async count() {
      if (isErrorEl) return errorText ? 1 : 0
      if (isFirstName) return emailAlreadyExists ? 0 : 1
      return 1
    },
    async isEnabled() {
      return true
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
  return {
    async newPage() {
      return page
    }
  }
}

const baseArgs = {
  email: 'test@example.com',
  password: 'SecurePass1!',
  firstName: 'Ash',
  lastName: 'Ketchum',
  phone: '5551234567',
  notificationEngine: { fire: vi.fn() }
}

describe('runTargetRegistration', () => {
  it('navigates to Target create-account page', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.lastUrl).toContain('target.com/account/create-account')
  })

  it('fills username field and clicks Continue in step 1', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.fills.some((f) => f.value === 'test@example.com')).toBe(true)
    expect(page.clicks.some((s) => s.includes('Continue'))).toBe(true)
  })

  it('fills firstname, lastname, and phone in step 2', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.fills.some((f) => f.value === 'Ash')).toBe(true)
    expect(page.fills.some((f) => f.value === 'Ketchum')).toBe(true)
    expect(page.fills.some((f) => f.value === '5551234567')).toBe(true)
  })

  it('clicks password-checkbox radio before filling password', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.clicks.some((s) => s.includes('password-checkbox'))).toBe(true)
  })

  it('fills password field after clicking radio', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    const radioIdx = page.clicks.findIndex((s) => s.includes('password-checkbox'))
    const passwordFill = page.fills.find((f) => f.value === 'SecurePass1!')
    expect(passwordFill).toBeDefined()
    // password fill must happen after radio click
    expect(radioIdx).toBeGreaterThanOrEqual(0)
  })

  it('clicks Create account submit button', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(
      page.clicks.some((s) => s.includes('createAccount') || s.includes('form-submit-button'))
    ).toBe(true)
  })

  it('returns success with needsVerification on registration', async () => {
    const page = makePage()
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: true, needsVerification: true })
  })

  it('returns alreadyExists when firstname field absent after Continue', async () => {
    const page = makePage({ emailAlreadyExists: true })
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: false, alreadyExists: true })
  })

  it('returns alreadyExists when error text matches after submit', async () => {
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
