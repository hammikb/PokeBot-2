import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'
import { NativeInputBridge } from '../NativeInputBridge.js'
import { startCheckoutDiagnostics } from '../CheckoutDiagnostics.js'
import {
  ATC_SELECTOR,
  CART_CONFIRMATION_SELECTOR,
  QUEUE_JOIN_SELECTOR,
  ATC_AFTER_QUEUE_SELECTOR,
  CVV_SELECTOR,
  PLACE_ORDER_SELECTOR,
  CHECKOUT_READY_SELECTOR,
  SIGN_IN_LINK_SELECTOR,
  USERNAME_SELECTOR,
  PASSWORD_SELECTOR,
  CONTINUE_BTN_SELECTOR,
  SIGN_IN_BTN_SELECTOR,
  ORDER_CONFIRMATION_SELECTOR,
  ORDER_NUMBER_SELECTOR
} from './walmart-page-utils.js'
import { humanDelay } from './checkout-utils.js'
import { readRetailerCartItem, validateCheckoutSafety } from '../CheckoutSafety.js'

export async function runWalmartFlow(
  context,
  {
    productUrl,
    cvv,
    account,
    notificationEngine,
    dropEvent,
    mode,
    buyLimit = 1,
    maxPrice = null,
    requireRetailerSeller = true,
    recordCheckoutTrace = false,
    onStep = () => {},
    onBeforeSubmit = () => {},
    onMilestone = () => {}
  }
) {
  const page = await context.newPage()
  // Create native input bridge — uses nut-js OS-level mouse/keyboard instead of
  // CDP Input.dispatch*Event. Falls back to CDP silently if nut-js unavailable.
  const input = await NativeInputBridge.create(page)

  const trace = await startTrace(context, {
    retailer: 'walmart',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout',
    enabled: recordCheckoutTrace || mode === 'test-checkout'
  })
  const diagnostics = await startCheckoutDiagnostics(page, {
    retailer: 'walmart',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout',
    tracePath: trace.tracePath
  })
  const isTestMode = mode === 'test-checkout'
  let requiresManual = false
  let orderSubmissionAttempted = false
  try {
    onStep('Opening product page')
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    await ensureWalmartSignedIn(page, account, notificationEngine, dropEvent, onStep, productUrl)

    // Check for queue first
    onStep('Checking Walmart queue')
    const queueBtn = page.locator(QUEUE_JOIN_SELECTOR)
    if ((await queueBtn.count()) > 0) {
      onStep('Joining Walmart queue')
      await queueBtn.first().click()
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      // Wait up to 10 minutes to exit queue
      await page.waitForSelector(ATC_AFTER_QUEUE_SELECTOR, { timeout: 600000 })
    }

    // The extension clicks after a short interaction settle rather than sleeping
    // for several seconds. Keep a minimal pause, then wait on real page state.
    onStep('Clicking Add to cart')
    const atcBtn = page.locator(ATC_SELECTOR)

    // Hover before clicking (more human-like, optional for environments that don't support it)
    await atcBtn.first().hover?.()
    await page.waitForTimeout?.(100)

    await atcBtn.first().click({ timeout: 15000 })
    await humanDelay(300, 700)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    onStep('Waiting for cart confirmation')
    const cartSignal = page.locator(CART_CONFIRMATION_SELECTOR).first()
    await cartSignal.waitFor({ state: 'visible', timeout: 1200 }).catch(() => {})

    await humanDelay(200, 600)

    // Go to checkout
    onStep('Opening checkout')
    await page.goto('https://www.walmart.com/checkout', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    const checkoutReady = page.locator(CHECKOUT_READY_SELECTOR).first()
    await checkoutReady.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})

    const itemId = extractWalmartItemId(productUrl)
    if (!itemId) throw new Error(`Cannot extract Walmart item ID from URL: ${productUrl}`)
    onStep('Verifying Walmart checkout item, quantity, seller, and price')
    const cartItem = await readRetailerCartItem(page, itemId)
    validateCheckoutSafety({
      retailer: 'Walmart',
      expectedItemId: itemId,
      actualItemId: cartItem?.itemId,
      requestedQuantity: buyLimit,
      actualQuantity: cartItem?.quantity,
      maxUnitPrice: maxPrice,
      actualUnitPrice: cartItem?.unitPrice,
      seller: cartItem?.seller,
      requireRetailerSeller
    })

    await humanDelay(200, 500)

    // Enter CVV
    onStep('Checking CVV field')
    const cvvField = page.locator(CVV_SELECTOR)
    if ((await cvvField.count()) > 0) {
      onStep('Filling CVV')
      // Use native OS keyboard input — avoids CDP Input.dispatchKeyEvent detection
      await input.fill(CVV_SELECTOR, cvv)
    }

    // Place order
    const placeOrderBtn = page.locator(PLACE_ORDER_SELECTOR)
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

    await humanDelay(300, 800)
    onStep('Clicking Place order')
    await onBeforeSubmit()
    orderSubmissionAttempted = true
    onMilestone('order_submitted', 'Walmart Place order action initiated')
    // Use native OS mouse click — avoids CDP Input.dispatchMouseEvent detection
    await input.click(PLACE_ORDER_SELECTOR)

    // Wait for confirmation
    onStep('Waiting for order confirmation')
    await page.waitForSelector(ORDER_CONFIRMATION_SELECTOR, { timeout: 30000 })

    let orderId = 'unknown'
    try {
      orderId = await page.textContent(ORDER_NUMBER_SELECTOR)
    } catch {
      // Some Walmart confirmation pages omit or delay the visible order number.
    }

    await trace.stop()
    return { success: true, orderId: orderId?.trim() || 'unknown', tracePath: trace.tracePath }
  } catch (err) {
    const submissionUncertain = orderSubmissionAttempted && !isTestMode
    const diagnosticsPath = await diagnostics.capture(err).catch(() => null)
    await Promise.resolve()
      .then(() => trace.capture(page))
      .catch(() => {})
    await Promise.resolve()
      .then(() => trace.stop())
      .catch(() => {})
    if (submissionUncertain) {
      onStep('Walmart order status is uncertain; leaving checkout open for manual verification')
      requiresManual = true
    } else if (isTestMode) {
      onStep('Test checkout failed; leaving browser open for inspection')
      requiresManual = true
    }
    const submissionMessage =
      'Walmart order submission status is uncertain. Do not retry; verify the order history and cart manually.'
    return {
      success: false,
      error: submissionUncertain ? submissionMessage : err.message,
      cause: submissionUncertain ? err.message : undefined,
      terminal: submissionUncertain,
      orderSubmissionAttempted,
      submissionUncertain,
      requiresManualCheckout: isTestMode || submissionUncertain,
      tracePath: trace.tracePath,
      screenshotPath: trace.screenshotPath,
      diagnosticsPath
    }
  } finally {
    diagnostics.dispose()
    if (!requiresManual) {
      try {
        await page.close()
      } catch {
        // Best effort cleanup; checkout result has already been determined.
      }
    }
  }
}

export function extractWalmartItemId(productUrl) {
  return String(productUrl || '').match(/\/(\d{5,})(?:[/?#]|$)/)?.[1] || null
}

async function ensureWalmartSignedIn(
  page,
  account,
  notificationEngine,
  dropEvent,
  onStep,
  productUrl
) {
  onStep('Checking Walmart sign-in state')
  const signInLink = page.locator(SIGN_IN_LINK_SELECTOR)
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
  const usernameField = page.locator(USERNAME_SELECTOR)
  await usernameField.first().waitFor({ state: 'visible', timeout: 15000 })
  await usernameField.first().fill(username)

  const continueBtn = page.locator(CONTINUE_BTN_SELECTOR)
  if ((await continueBtn.count()) > 0) {
    onStep('Submitting Walmart email')
    await continueBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  }

  const passwordField = page.locator(PASSWORD_SELECTOR)
  onStep('Filling Walmart password')
  await passwordField.first().waitFor({ state: 'visible', timeout: 15000 })
  await passwordField.first().fill(account.password)

  const signInBtn = page.locator(SIGN_IN_BTN_SELECTOR)
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
