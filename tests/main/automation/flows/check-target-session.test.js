import { describe, expect, it, vi, beforeEach } from 'vitest'
import { checkTargetSession } from '../../../../src/main/automation/flows/check-target-session.js'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

beforeEach(() => vi.resetAllMocks())

function makePage({ visibleSelectors = new Set() } = {}) {
  const page = {
    clicks: [],
    routes: [],
    navigations: [],
    focused: false,
    closed: false,
    async goto(url) {
      this.navigations.push(url)
      this.lastUrl = url
    },
    async route(pattern, handler) {
      this.routes.push({ pattern, handler })
    },
    locator(selector) {
      return makeLocator(page, selector, visibleSelectors)
    },
    async screenshot() {
      return Buffer.from('screenshot')
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
    async waitFor({ state } = {}) {
      if (state === 'visible' && !visible) throw new Error(`Not visible: ${selector}`)
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

describe('checkTargetSession', () => {
  it('reports signed in when profile indicator is visible', async () => {
    const page = makePage({ visibleSelectors: new Set(['accountNav-signOut']) })

    const result = await checkTargetSession(makeContext([page]), {})

    expect(result).toMatchObject({
      success: true,
      loggedIn: true,
      message: 'Target profile is confirmed signed in.'
    })
    expect(page.navigations).toContain('https://www.target.com/account?prehydrateClick=true')
  })

  it('reports signed out when sign-in form is visible', async () => {
    const page = makePage({ visibleSelectors: new Set(['username']) })

    const result = await checkTargetSession(makeContext([page]), {})

    expect(result).toMatchObject({
      success: false,
      loggedIn: false,
      message: 'Target account page shows the sign-in form — profile is not logged in.'
    })
  })

  it('reports unknown when neither sign-in form nor profile loads', async () => {
    const page = makePage({ visibleSelectors: new Set() })

    const result = await checkTargetSession(makeContext([page]), {})

    expect(result).toMatchObject({ success: false, loggedIn: false, unknown: true })
  })

  it('reuses an existing page and closes extra blank tabs', async () => {
    const mainPage = makePage({ visibleSelectors: new Set(['accountNav-signOut']) })
    mainPage.lastUrl = 'https://www.target.com/'
    const blankPage = makePage()

    const result = await checkTargetSession(makeContext([mainPage, blankPage]), {})

    expect(result).toMatchObject({ success: true, loggedIn: true })
    expect(mainPage.focused).toBe(true)
    expect(blankPage.closed).toBe(true)
  })

  it('navigates to account URL and sets status from session check', async () => {
    const page = makePage({ visibleSelectors: new Set(['accountNav-signOut']) })

    await checkTargetSession(makeContext([page]), { accountName: 'kai' })

    expect(page.navigations[0]).toBe('https://www.target.com/account?prehydrateClick=true')
    expect(page.routes).toHaveLength(1)
    expect(page.focused).toBe(true)
  })
})
