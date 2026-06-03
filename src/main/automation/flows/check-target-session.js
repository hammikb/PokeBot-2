import { mkdirSync } from 'fs'
import { join } from 'path'
import { waitForCaptchaIfNeeded } from '../captcha.js'
import {
  getOrCreateTargetPage,
  enableFastNavigation,
  waitForSignInOrProfile
} from './target-page-utils.js'

const ACCOUNT_URL = 'https://www.target.com/account?prehydrateClick=true'

export async function checkTargetSession(
  context,
  { notificationEngine, dropEvent, onStep = () => {}, accountName = 'target-account' } = {}
) {
  const page = await getOrCreateTargetPage(context)
  let screenshotPath = null
  try {
    await enableFastNavigation(page)
    onStep('Opening Target account page for session check')
    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    const state = await waitForSignInOrProfile(page)
    screenshotPath = await captureSessionScreenshot(page, accountName)
    onStep(`Target session check result: ${state}`)

    if (state === 'profile') {
      return {
        success: true,
        loggedIn: true,
        screenshotPath,
        message: 'Target profile is confirmed signed in.'
      }
    }

    if (state === 'signin') {
      return {
        success: false,
        loggedIn: false,
        screenshotPath,
        message: 'Target account page shows the sign-in form — profile is not logged in.'
      }
    }

    return {
      success: false,
      loggedIn: false,
      unknown: true,
      screenshotPath,
      message: 'Target account page did not load a recognisable sign-in or profile state.'
    }
  } catch (err) {
    return { success: false, loggedIn: false, error: err.message, screenshotPath }
  }
}

async function captureSessionScreenshot(page, accountName) {
  if (typeof page.screenshot !== 'function') return null
  const dir = join(getAppDataDir(), 'session-checks')
  mkdirSync(dir, { recursive: true })
  const safeName = String(accountName || 'target-account').replace(/[^a-z0-9_-]+/gi, '_')
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName}.png`)
  await page.screenshot({ path })
  return path
}

function getAppDataDir() {
  return process.env.APPDATA
    ? join(process.env.APPDATA, 'pokebot2')
    : join(process.cwd(), '.pokebot2')
}
