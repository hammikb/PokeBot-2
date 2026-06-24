import { mkdirSync } from 'fs'
import { join } from 'path'
import { waitForCaptchaIfNeeded } from '../captcha.js'
import { checkTargetSession } from './check-target-session.js'
import {
  getOrCreateTargetPage,
  enableFastNavigation,
  findFirstVisibleLocator,
  findVisibleRoleButton,
  clickVisibleLocator,
  waitForDomContentLoaded,
  waitForSignInOrProfile
} from './target-page-utils.js'

const ACCOUNT_URL = 'https://www.target.com/account?prehydrateClick=true'
const USERNAME_SELECTOR =
  'input[id="username"], input[name="username"], input[autocomplete*="username"], input[inputmode="email"], input[type="email"]'
const PASSWORD_SELECTOR =
  'input[id="password"], input[name="password"], input[autocomplete="current-password"], input[type="password"]'
const CONTINUE_SELECTORS = ['button:has-text("Continue")', 'button[type="submit"]']

// Target's sign-in step shows auth-factor options as radio inputs (passkey is selected by
// default). The real "Login with password" control is the radio input below — it must be
// selected before the password field is revealed. Older text/role-button variants are kept
// as fallbacks for any A/B variant of the page.
// The actual radio input that switches Target's sign-in to password auth.
// NOTE: The auth-factor chooser also offers "Get a code" (one-time passcode), which
// defaults to selected — we must target ONLY the password option by its value/id and
// never a generic auth-factor control, or we end up triggering the email code flow.
const PASSWORD_RADIO_SELECTOR = [
  'input[name="auth-factor"][value="password"]',
  'input[id="password-checkbox"]',
  'input[type="radio"][value="password"]',
  'input[type="radio"][id="password"]'
].join(', ')
// Password-only method selectors. Every entry is scoped to "password" wording/value so
// they can never match the "Get a code" / OTP option on the auth-factor chooser.
const PASSWORD_METHOD_SELECTORS = [
  'input[name="auth-factor"][value="password"]',
  'label:has-text("Enter your password")',
  '#password[role="button"]',
  '[id="password"][role="button"]:has-text("Enter your password")',
  'div[id="password"][role="button"]',
  'button:has-text("Enter your password")',
  'a:has-text("Enter your password")',
  '[role="button"]:has-text("Enter your password")'
]

const PASSWORD_SUBMIT_SELECTORS = [
  'button[type="submit"]:has-text("Sign in")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button[type="submit"]'
]

export async function runTargetAutoLogin(
  context,
  { account, notificationEngine, dropEvent, onStep = () => {} }
) {
  if (!account?.username || !account?.password) {
    return {
      success: false,
      requiresManualLogin: true,
      message: 'Target auto-login requires an account username and password.'
    }
  }

  const page = await getOrCreateTargetPage(context)
  try {
    await enableFastNavigation(page)
    onStep('Opening Target account page for auto-login')
    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Wait for either the sign-in form or the logged-in account profile to render.
    const signInOrProfile = await waitForSignInOrProfile(page)

    if (signInOrProfile === 'profile') {
      onStep('Target account page shows profile — already signed in')
      return {
        success: true,
        loggedIn: true,
        alreadyLoggedIn: true,
        message: 'Target profile is already signed in.'
      }
    }

    if (signInOrProfile !== 'signin') {
      return {
        success: false,
        loggedIn: false,
        requiresManualLogin: true,
        message:
          'Target account page did not load the sign-in form. Complete login manually, then run check login.'
      }
    }

    await fillTargetCredentials(page, account, notificationEngine, dropEvent, onStep)

    onStep('Confirming Target session after auto-login')
    const session = await checkTargetSession(context, {
      accountName: account.name,
      notificationEngine,
      dropEvent,
      onStep
    })
    if (session.success) {
      return {
        ...session,
        message: 'Target auto-login completed and profile is signed in.'
      }
    }

    return {
      ...session,
      success: false,
      loggedIn: false,
      requiresManualLogin: true,
      message:
        session.message ||
        'Target did not confirm login. Complete any visible Target prompt manually, then run check login.'
    }
  } catch (err) {
    const screenshotPath = await captureAutoLoginScreenshot(page, account.name)
    return {
      success: false,
      loggedIn: false,
      requiresManualLogin: true,
      error: err.message,
      screenshotPath,
      message:
        'Target auto-login needs manual attention. Complete any visible Target prompt, then run check login.'
    }
  }
}

// CloakBrowser launches with `humanize: true`, which makes typing/`type()` simulate a real
// person (per-character delays, thinking pauses, occasional typos). That realism is great
// near captchas but needlessly slow for the login email/password fields, so we set the value
// in one shot via the DOM and fire the input/change events React listens for. If the direct
// path fails for any reason we fall back to Playwright's instant `fill()`.
async function fastFill(locator, value) {
  try {
    const handled = await locator.evaluate((el, val) => {
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      if (setter) setter.call(el, val)
      else el.value = val
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, value)
    if (handled) return
  } catch {
    // Fall through to the standard fill below.
  }
  await locator.fill(value)
}

async function fillTargetCredentials(page, account, notificationEngine, dropEvent, onStep) {
  const usernameField = page.locator(USERNAME_SELECTOR)
  onStep('Filling Target email')
  await usernameField.first().waitFor({ state: 'visible', timeout: 15000 })
  await fastFill(usernameField.first(), account.username)

  // "Keep me signed in" is rendered on the email step (before Continue), so select it now.
  await keepTargetSessionSignedIn(page, onStep)

  const continueButton = await findFirstVisibleLocator(page, CONTINUE_SELECTORS)
  if (continueButton) {
    onStep('Submitting Target email')
    await clickVisibleLocator(continueButton, { timeout: 10000 })
    await waitForDomContentLoaded(page)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    await waitForTargetAuthMethod(page, onStep)
  }

  // Re-check in case the option is also shown on the auth-method step in some variants.
  await keepTargetSessionSignedIn(page, onStep)

  const clickedPasswordMethod = await clickTargetPasswordMethod(
    page,
    notificationEngine,
    dropEvent,
    onStep
  )
  if (!clickedPasswordMethod && !(await isPasswordFieldVisible(page))) {
    throw new Error('Target password option was not available after submitting email')
  }

  const passwordField = page.locator(PASSWORD_SELECTOR)
  onStep('Filling Target password')
  await passwordField.first().waitFor({ state: 'visible', timeout: 15000 })
  await fastFill(passwordField.first(), account.password)

  const submitButton = await findFirstVisibleLocator(page, PASSWORD_SUBMIT_SELECTORS)
  if (!submitButton) throw new Error('Target password submit button was not found')

  onStep('Submitting Target password')
  await clickVisibleLocator(submitButton, { timeout: 10000 })
  await waitForDomContentLoaded(page)
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  // Target processes the sign-in (sets session cookies + redirects away from /login)
  // asynchronously. Give it time to settle before the session check runs, otherwise the
  // check fires while the login page is still up and reports a false "not signed in".
  await waitForTargetLoginToSettle(page, onStep)
}

// Wait for Target to finish processing the sign-in before checking the session.
async function waitForTargetLoginToSettle(page, onStep) {
  onStep('Waiting for Target to finish signing in')

  // 1) Prefer to wait for navigation off the login/sign-in page.
  if (typeof page.waitForURL === 'function') {
    try {
      await page.waitForURL((url) => !/\/login|sign-?in|account\/?$/i.test(String(url)), {
        timeout: 15000
      })
    } catch {
      // Ignore — fall through to the network/settle waits below.
    }
  }

  // 2) Let in-flight auth requests/redirects complete.
  if (typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  }

  // 3) Final fixed settle delay so cookies are written before we read the session.
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(2500).catch(() => {})
  } else {
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
}

async function keepTargetSessionSignedIn(page, onStep) {
  // The checkbox (input#keepMeSignedIn) is a styled control whose real <input> is often
  // visually hidden behind a custom label, so locate it by id directly (not by visibility)
  // and toggle it with check({ force }). Clicking the label is the fallback. We must never
  // fall through to a generic visible-element search, which previously clicked the wrong
  // control on the email step.
  const checkbox = page.locator('input[id="keepMeSignedIn"]').first()
  if ((await checkbox.count()) === 0) return

  const alreadyChecked = await checkbox.isChecked().catch(() => false)
  if (alreadyChecked) {
    onStep('Target Keep Me Signed In is already selected')
    return
  }

  onStep('Selecting Target Keep Me Signed In')
  try {
    await checkbox.check({ force: true, timeout: 10000 })
  } catch {
    // Fall back to clicking the associated label.
    const label = page
      .locator('label[for="keepMeSignedIn"], label:has-text("Keep me signed in")')
      .first()
    if ((await label.count()) > 0) {
      await clickVisibleLocator(label, { timeout: 10000 }).catch(() => {})
    }
  }
}

async function clickTargetPasswordMethod(page, notificationEngine, dropEvent, onStep) {
  // If the password field is already visible (no method picker shown), nothing to do.
  if (await isPasswordFieldVisible(page)) return true

  // 1) Most reliable: the auth-method "cell" Target renders on the sign-in chooser is
  //    a div with role="button" and id="password" whose primary text is "Enter your
  //    password" (sibling cells exist for passkey and "Get a code"). Target this exact
  //    cell directly so we can never resolve to the "Get a code" cell.
  const passwordCell = page
    .locator('[id="password"][role="button"], [role="button"]:has-text("Enter your password")')
    .first()
  if ((await passwordCell.count()) > 0) {
    onStep('Clicking Enter your password')
    await clickVisibleLocator(passwordCell, { timeout: 10000 })
    await waitForDomContentLoaded(page)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    await page
      .locator(PASSWORD_SELECTOR)
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {})
    return true
  }

  // 2) Registration-style variant: the password method is a radio input
  //    (id="password-checkbox" / name="auth-factor" value="password") that is often
  //    visually hidden behind a styled label, so select it with check({ force }).
  const passwordRadio = page.locator(PASSWORD_RADIO_SELECTOR).first()
  if ((await passwordRadio.count()) > 0) {
    onStep('Selecting Target Login with password')
    let selected = false
    try {
      await passwordRadio.check({ force: true, timeout: 10000 })
      selected = true
    } catch {
      // Fall back to clicking the radio's label.
      const radioLabel = await findFirstVisibleLocator(
        page,
        ['label[for="password-checkbox"]', 'label:has-text("Login with password")'],
        { timeout: 5000 }
      )
      if (radioLabel) {
        await clickVisibleLocator(radioLabel, { timeout: 10000 })
        selected = true
      }
    }

    if (selected) {
      await waitForDomContentLoaded(page)
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      // The password field is revealed after the radio is selected.
      await page
        .locator(PASSWORD_SELECTOR)
        .first()
        .waitFor({ state: 'visible', timeout: 10000 })
        .catch(() => {})
      return true
    }
  }

  // 3) Fallback: older A/B variants expose a button/link. Use EXACT accessible-name
  //    matching so a substring match can never land on the "Get a code" / OTP option.
  const enterPasswordButton =
    (await findVisibleRoleButton(page, /^Login with password$/i)) ||
    (await findVisibleRoleButton(page, /^Enter your password$/i)) ||
    (await findVisibleRoleButton(page, /^Use (your )?password$/i)) ||
    (await findFirstVisibleLocator(page, PASSWORD_METHOD_SELECTORS, { timeout: 5000 }))
  if (!enterPasswordButton) {
    onStep('Target Login with password option was not found')
    return false
  }

  // Final safety guard: never click a control whose text mentions a one-time code.
  const buttonText = (await enterPasswordButton.textContent().catch(() => '')) || ''
  if (/\bcode\b/i.test(buttonText)) {
    onStep('Target password option resolved to a code option — skipping to avoid OTP flow')
    return false
  }

  onStep('Clicking Login with password')
  await clickVisibleLocator(enterPasswordButton, { timeout: 10000 })
  await waitForDomContentLoaded(page)
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  return true
}

async function waitForTargetAuthMethod(page, onStep) {
  onStep('Waiting for Target auth method options')
  const authMethod = await findFirstVisibleLocator(
    page,
    [...PASSWORD_METHOD_SELECTORS, PASSWORD_SELECTOR],
    { timeout: 10000 }
  )
  if (!authMethod) {
    onStep('Target auth method options did not appear yet')
  }
}

async function isPasswordFieldVisible(page) {
  return page
    .locator(PASSWORD_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false)
}

async function captureAutoLoginScreenshot(page, accountName) {
  if (typeof page?.screenshot !== 'function') return null
  try {
    const dir = join(getAppDataDir(), 'auto-login-checks')
    mkdirSync(dir, { recursive: true })
    const safeName = String(accountName || 'target-account').replace(/[^a-z0-9_-]+/gi, '_')
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName}.png`)
    await page.screenshot({ path })
    return path
  } catch {
    return null
  }
}

function getAppDataDir() {
  return process.env.APPDATA
    ? join(process.env.APPDATA, 'pokebot2')
    : join(process.cwd(), '.pokebot2')
}
