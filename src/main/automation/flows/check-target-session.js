import { mkdirSync } from 'fs'
import { join } from 'path'
import { waitForCaptchaIfNeeded } from '../captcha.js'
import {
  getOrCreateTargetPage,
  enableFastNavigation,
  waitForSignInOrProfile
} from './target-page-utils.js'
import { validateTargetSession, regenerateTargetSensorData } from '../akamaiSensor.js'

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
      // Validate the Akamai sensor data by probing a protected endpoint.
      // A present _abck cookie is not enough — it must be valid for the
      // current fingerprint. If the probe returns a challenge, regenerate.
      onStep('Validating Target session against protected endpoint')
      const validation = await validateTargetSession(page, {
        endpoint: 'https://www.target.com/account?prehydrateClick=true'
      })

      if (!validation.valid) {
        onStep('Target session validation failed - regenerating sensor data')
        const regenerated = await regenerateTargetSensorData(page, {
          endpoint: 'https://www.target.com/co-cart',
          timeoutMs: 15000
        })

        if (!regenerated.success) {
          return {
            success: false,
            loggedIn: true,
            sessionValid: false,
            screenshotPath,
            message:
              'Target profile is signed in but the session failed Akamai validation. Sensor regeneration was unsuccessful.'
          }
        }

        onStep('Target sensor data regenerated successfully')
      }

      return {
        success: true,
        loggedIn: true,
        sessionValid: true,
        screenshotPath,
        message: 'Target profile is confirmed signed in with a valid session.'
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
