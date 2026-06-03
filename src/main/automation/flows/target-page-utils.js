export function isPageUsable(page) {
  return page && !isClosedPage(page)
}

function isClosedPage(page) {
  try {
    return typeof page.isClosed === 'function' && page.isClosed()
  } catch {
    return false
  }
}

export function isBlankPage(page) {
  try {
    const url = typeof page.url === 'function' ? page.url() : ''
    return !url || url === 'about:blank'
  } catch {
    return false
  }
}

export async function getOrCreateTargetPage(context) {
  const pages = typeof context.pages === 'function' ? context.pages() : []
  const usable =
    pages.find((page) => isPageUsable(page) && !isBlankPage(page)) ||
    pages.find((page) => isPageUsable(page))
  const page = usable || (await context.newPage())

  for (const extraPage of pages) {
    if (extraPage === page) continue
    if (isBlankPage(extraPage)) {
      try {
        await extraPage.close()
      } catch {
        // Best-effort cleanup of Chromium's startup blank tab.
      }
    }
  }

  try {
    await page.bringToFront?.()
  } catch {
    // Focus is helpful but not required for automation.
  }

  return page
}

export async function enableFastNavigation(page) {
  if (typeof page.route !== 'function') return
  await page.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (['image', 'font', 'media'].includes(type)) return route.abort()
    return route.continue()
  })
}

export async function findFirstVisibleLocator(page, selectors, { timeout = 1000 } = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector)
    if ((await locator.count()) === 0) continue
    const first = locator.first()
    try {
      await first.waitFor({ state: 'visible', timeout })
      return first
    } catch {
      // Try next selector.
    }
  }
  return null
}

export async function findVisibleRoleButton(page, name, { timeout = 5000 } = {}) {
  if (typeof page.getByRole !== 'function') return null
  const locator = page.getByRole('button', { name }).first()
  try {
    await locator.waitFor({ state: 'visible', timeout })
    return locator
  } catch {
    return null
  }
}

export async function clickVisibleLocator(locator, options = {}) {
  await locator.scrollIntoViewIfNeeded?.().catch(() => {})
  try {
    await locator.click(options)
  } catch {
    await locator.click({ ...options, force: true })
  }
}

export async function waitForDomContentLoaded(page) {
  if (typeof page.waitForLoadState !== 'function') return
  await page.waitForLoadState('domcontentloaded').catch(() => {})
}

const SIGNIN_FIELD_SELECTOR =
  'input[id="username"], input[name="username"], input[autocomplete*="username"], input[inputmode="email"], input[type="email"]'

const PROFILE_INDICATOR_SELECTOR =
  '[data-test="accountNav-signOut"], a:has-text("Sign out"), button:has-text("Sign out"), [data-test="account-name"]'

// Returns 'signin' | 'profile' | 'unknown'.
// Races the sign-in email field against logged-in profile indicators.
export async function waitForSignInOrProfile(page) {
  const signinField = page.locator(SIGNIN_FIELD_SELECTOR)
  const profileIndicator = page.locator(PROFILE_INDICATOR_SELECTOR)
  try {
    await Promise.any([
      signinField.first().waitFor({ state: 'visible', timeout: 15000 }),
      profileIndicator.first().waitFor({ state: 'visible', timeout: 15000 })
    ])
  } catch {
    return 'unknown'
  }
  if (await signinField.first().isVisible().catch(() => false)) return 'signin'
  if (await profileIndicator.first().isVisible().catch(() => false)) return 'profile'
  return 'unknown'
}
