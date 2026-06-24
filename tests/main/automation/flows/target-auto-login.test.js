import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runTargetAutoLogin } from '../../../../src/main/automation/flows/target-auto-login.js'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

// Simulate checkTargetSession so auto-login tests don't depend on its internals.
vi.mock('../../../../src/main/automation/flows/check-target-session.js', () => ({
  checkTargetSession: vi.fn()
}))

import { checkTargetSession } from '../../../../src/main/automation/flows/check-target-session.js'

beforeEach(() => vi.resetAllMocks())

function makePage({ visibleSelectors = new Set() } = {}) {
  const page = {
    clicks: [],
    checks: [],
    fills: [],
    waits: [],
    routes: [],
    focused: false,
    closed: false,
    navigations: [],
    async goto(url) {
      this.navigations.push(url)
      this.lastUrl = url
    },
    // Stubs so the post-login settle helper resolves instantly in tests.
    async waitForURL() {},
    async waitForLoadState() {},
    async waitForTimeout() {},

    async route(pattern, handler) {
      this.routes.push({ pattern, handler })
    },
    locator(selector) {
      return makeLocator(page, selector, visibleSelectors)
    },
    getByRole(role, options = {}) {
      const name = typeof options.name === 'string' ? options.name : ''
      return makeLocator(page, `role=${role} name=${name}`, visibleSelectors)
    },
    url() {
      return this.lastUrl || 'about:blank'
    },
    isClosed() {
      return this.closed
    },
    async bringToFront() {
      this.focused = true
    },
    async close() {
      this.closed = true
    }
  }
  return page
}

function makeLocator(page, selector, visibleSelectors) {
  const visible = [...visibleSelectors].some((s) => selector.includes(s))
  return {
    first() {
      return this
    },
    async count() {
      return visible ? 1 : 0
    },
    async isVisible() {
      return visible
    },
    async click() {
      page.clicks.push(selector)
    },
    async scrollIntoViewIfNeeded() {
      page.waits.push(`scroll:${selector}`)
    },
    async check() {
      page.checks.push(selector)
      // Selecting the "Login with password" radio reveals the password field,
      // mirroring Target's real sign-in behavior.
      if (selector.includes('password-checkbox') || selector.includes('auth-factor')) {
        visibleSelectors.add('input[id="password"]')
      }
    },

    async isChecked() {
      return false
    },
    async fill(value) {
      page.fills.push({ selector, value })
    },
    // fastFill() calls locator.evaluate(fn, value) to set the value directly; record the
    // resulting value the same way fill() does so the flow's assertions still see it.
    async evaluate(_fn, value) {
      if (typeof value === 'string') page.fills.push({ selector, value })
      return true
    },

    async waitFor({ state } = {}) {
      if (state === 'visible' && !visible) throw new Error(`Not visible: ${selector}`)
      page.waits.push(selector)
    },
    async evaluateAll() {
      return []
    }
  }
}

function makeContext(pages) {
  let index = 0
  return {
    pages() {
      return pages
    },
    async newPage() {
      return pages[index++] ?? pages[pages.length - 1]
    }
  }
}

const account = {
  name: 'target-kai',
  username: 'kai@example.com',
  password: 'SecurePass1!'
}

describe('runTargetAutoLogin', () => {
  it('returns requiresManualLogin when no credentials provided', async () => {
    const page = makePage()
    const result = await runTargetAutoLogin(makeContext([page]), { account: {} })
    expect(result).toMatchObject({ success: false, requiresManualLogin: true })
  })

  it('detects already-logged-in state via profile indicator and returns early', async () => {
    const page = makePage({ visibleSelectors: new Set(['accountNav-signOut']) })
    checkTargetSession.mockResolvedValueOnce({ success: true, loggedIn: true })

    const result = await runTargetAutoLogin(makeContext([page]), { account })

    expect(result).toMatchObject({ success: true, loggedIn: true, alreadyLoggedIn: true })
    expect(page.navigations).toContain('https://www.target.com/account?prehydrateClick=true')
    expect(page.fills).toHaveLength(0)
  })

  it('selects the Login with password radio, then fills email and password', async () => {
    const page = makePage({
      visibleSelectors: new Set([
        'username',
        'Continue',
        'keepMeSignedIn',
        'password-checkbox',
        'Sign in'
      ])
    })
    checkTargetSession.mockResolvedValueOnce({ success: true, loggedIn: true })

    const result = await runTargetAutoLogin(makeContext([page]), { account })

    expect(result).toMatchObject({ success: true, loggedIn: true })
    expect(page.checks.some((selector) => selector.includes('keepMeSignedIn'))).toBe(true)
    // The real Target "Login with password" control is the radio input password-checkbox;
    // it must be selected (checked) before the password field is revealed.
    expect(page.checks.some((selector) => selector.includes('password-checkbox'))).toBe(true)
    expect(page.fills.some((f) => f.value === 'kai@example.com')).toBe(true)
    expect(page.fills.some((f) => f.value === 'SecurePass1!')).toBe(true)
    expect(page.navigations).toContain('https://www.target.com/account?prehydrateClick=true')
  })

  it('returns requiresManualLogin when session check fails after fill', async () => {
    const page = makePage({
      visibleSelectors: new Set(['username', 'Continue', 'password', 'Sign in'])
    })
    checkTargetSession.mockResolvedValueOnce({
      success: false,
      loggedIn: false,
      message: 'Target still shows a sign-in button for this profile.'
    })

    const result = await runTargetAutoLogin(makeContext([page]), { account })

    expect(result).toMatchObject({ success: false, requiresManualLogin: true })
  })

  it('returns unknown when neither sign-in form nor profile loads', async () => {
    // No visible selectors at all → waitForSignInOrProfile times out → 'unknown'
    const page = makePage({ visibleSelectors: new Set() })

    const result = await runTargetAutoLogin(makeContext([page]), { account })

    expect(result).toMatchObject({ success: false, requiresManualLogin: true })
    expect(page.fills).toHaveLength(0)
  })

  it('closes blank extra tabs and reuses an existing page', async () => {
    const mainPage = makePage({ visibleSelectors: new Set(['accountNav-signOut']) })
    mainPage.lastUrl = 'https://www.target.com/'
    const blankPage = makePage()
    checkTargetSession.mockResolvedValueOnce({ success: true, loggedIn: true })

    const result = await runTargetAutoLogin(makeContext([mainPage, blankPage]), { account })

    expect(result).toMatchObject({ success: true, alreadyLoggedIn: true })
    expect(mainPage.focused).toBe(true)
    expect(blankPage.closed).toBe(true)
  })
})
