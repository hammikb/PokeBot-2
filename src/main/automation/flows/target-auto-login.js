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
const KEEP_ME_SIGNED_IN_SELECTORS = [
  'input#keepMeSignedIn[name="keepMeSignedIn"]',
  'input[id="keepMeSignedIn"]'
]
const PASSWORD_METHOD_SELECTORS = [
  '#password[role="button"]',
  '[id="password"][role="button"]:has-text("Enter your password")',
  'div[id="password"][role="button"]',
  'button:has-text("Enter your password")',
  'a:has-text("Enter your password")',
  '[role="button"]:has-text("Enter your password")',
  'button:has-text("Use password")',
  'a:has-text("Use password")'
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
        message: 'Target account page did not load the sign-in form. Complete login manually, then run check login.'
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

async function fillTargetCredentials(page, account, notificationEngine, dropEvent, onStep) {
  const usernameField = page.locator(USERNAME_SELECTOR)
  onStep('Filling Target email')
  await usernameField.first().waitFor({ state: 'visible', timeout: 15000 })
  await usernameField.first().fill(account.username)

  const continueButton = await findFirstVisibleLocator(page, CONTINUE_SELECTORS)
  if (continueButton) {
    onStep('Submitting Target email')
    await clickVisibleLocator(continueButton, { timeout: 10000 })
    await waitForDomContentLoaded(page)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    await waitForTargetAuthMethod(page, onStep)
  }

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
  await passwordField.first().fill(account.password)

  const submitButton = await findFirstVisibleLocator(page, PASSWORD_SUBMIT_SELECTORS)
  if (!submitButton) throw new Error('Target password submit button was not found')

  onStep('Submitting Target password')
  await clickVisibleLocator(submitButton, { timeout: 10000 })
  await waitForDomContentLoaded(page)
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
}

async function keepTargetSessionSignedIn(page, onStep) {
  const keepMeSignedIn = await findFirstVisibleLocator(page, KEEP_ME_SIGNED_IN_SELECTORS)
  if (!keepMeSignedIn) return

  const alreadyChecked = await keepMeSignedIn.isChecked().catch(() => false)
  if (alreadyChecked) {
    onStep('Target Keep Me Signed In is already selected')
    return
  }

  onStep('Selecting Target Keep Me Signed In')
  await keepMeSignedIn.check({ timeout: 10000 })
}

async function clickTargetPasswordMethod(page, notificationEngine, dropEvent, onStep) {
  const enterPasswordButton =
    (await findVisibleRoleButton(page, 'Enter your password')) ||
    (await findFirstVisibleLocator(page, PASSWORD_METHOD_SELECTORS, { timeout: 5000 }))
  if (!enterPasswordButton) {
    onStep('Target Enter your password option was not found')
    return false
  }

  onStep('Clicking Enter your password')
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
  return page.locator(PASSWORD_SELECTOR).first().isVisible().catch(() => false)
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
