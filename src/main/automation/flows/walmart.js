import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'

export async function runWalmartFlow(
  context,
  { productUrl, cvv, account, notificationEngine, dropEvent, mode, onStep = () => {} }
) {
  const page = await context.newPage()
  const trace = await startTrace(context, {
    retailer: 'walmart',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout'
  })
  const isTestMode = mode === 'test-checkout'
  let requiresManual = false
  try {
    onStep('Opening product page')
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    await ensureWalmartSignedIn(page, account, notificationEngine, dropEvent, onStep, productUrl)

    // Check for queue first
    onStep('Checking Walmart queue')
    const queueBtn = page.locator(
      'button:has-text("Join Waitlist"), button:has-text("Get In Line"), button:has-text("Join queue")'
    )
    if ((await queueBtn.count()) > 0) {
      onStep('Joining Walmart queue')
      await queueBtn.first().click()
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      // Wait up to 10 minutes to exit queue
      await page.waitForSelector(
        '[class*="add-to-cart"]:not([disabled]), button[data-automation-id="atc"]:not([disabled])',
        { timeout: 600000 }
      )
    }

    // Add to cart
    onStep('Clicking Add to cart')
    const atcBtn = page.locator('button[data-automation-id="atc"], button:has-text("Add to cart")')
    await atcBtn.first().click({ timeout: 15000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Go to checkout
    onStep('Opening checkout')
    await page.goto('https://www.walmart.com/checkout', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Enter CVV
    onStep('Checking CVV field')
    const cvvField = page.locator(
      'input[name="cvv"], input[placeholder*="CVV"], input[aria-label*="CVV"], input[aria-label*="cvv"]'
    )
    if ((await cvvField.count()) > 0) {
      onStep('Filling CVV')
      await cvvField.first().fill(cvv)
    }

    // Place order
    const placeOrderBtn = page.locator(
      'button:has-text("Place order"), button[data-automation-id="place-order"], button:has-text("Place Order")'
    )
    if (isTestMode) {
      onStep('Waiting for Place order button')
      await placeOrderBtn.first().waitFor({ state: 'visible', timeout: 15000 })
      onStep('Reached Place order button; stopping for test mode')
      await trace.capture(page)
      await trace.stop()
      requiresManual = true
      return {
        success: true,
        testMode: true,
        requiresManualCheckout: true,
        tracePath: trace.tracePath,
        screenshotPath: trace.screenshotPath,
        message: 'Test checkout reached Place order and stopped before purchase'
      }
    }

    onStep('Clicking Place order')
    await placeOrderBtn.first().click({ timeout: 15000 })

    // Wait for confirmation
    onStep('Waiting for order confirmation')
    await page.waitForSelector(
      '[class*="order-confirmation"], [class*="thank-you"], [class*="orderConfirmation"]',
      { timeout: 30000 }
    )

    let orderId = 'unknown'
    try {
      orderId = await page.textContent('[class*="order-number"], [class*="orderNumber"]')
    } catch {
      // Some Walmart confirmation pages omit or delay the visible order number.
    }

    await trace.stop()
    return { success: true, orderId: orderId?.trim() || 'unknown', tracePath: trace.tracePath }
  } catch (err) {
    await trace.capture(page)
    await trace.stop()
    if (isTestMode) {
      onStep('Test checkout failed; leaving browser open for inspection')
      requiresManual = true
    }
    return {
      success: false,
      error: err.message,
      requiresManualCheckout: isTestMode,
      tracePath: trace.tracePath,
      screenshotPath: trace.screenshotPath
    }
  } finally {
    if (!requiresManual) {
      try {
        await page.close()
      } catch {
        // Best effort cleanup; checkout result has already been determined.
      }
    }
  }
}

async function ensureWalmartSignedIn(page, account, notificationEngine, dropEvent, onStep, productUrl) {
  onStep('Checking Walmart sign-in state')
  const signInLink = page.locator(
    'a:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Sign In"), [data-automation-id="sign-in"]'
  )
  if ((await signInLink.count()) === 0) {
    onStep('Already signed into Walmart')
    return
  }

  onStep('Walmart session is logged out; opening login')
  const username = account?.username || account?.email
  if (!username || !account?.password) {
    throw new Error('Walmart checkout requires a signed-in account with username and password')
  }

  await page.goto('https://www.walmart.com/account/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  onStep('Filling Walmart email')
  const usernameField = page.locator(
    'input[name="email"], input[type="email"], input[autocomplete*="username"], input[id*="email"]'
  )
  await usernameField.first().waitFor({ state: 'visible', timeout: 15000 })
  await usernameField.first().fill(username)

  const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]')
  if ((await continueBtn.count()) > 0) {
    onStep('Submitting Walmart email')
    await continueBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  }

  const passwordField = page.locator('input[name="password"], input[type="password"]')
  onStep('Filling Walmart password')
  await passwordField.first().waitFor({ state: 'visible', timeout: 15000 })
  await passwordField.first().fill(account.password)

  const signInBtn = page.locator(
    'button:has-text("Sign in"), button:has-text("Sign In"), button[type="submit"]'
  )
  onStep('Submitting Walmart sign-in')
  await signInBtn.first().click({ timeout: 10000 })
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  onStep('Returning to product page after Walmart sign-in')
  await page.goto(dropEvent?.productUrl || productUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
}
