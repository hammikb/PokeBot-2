import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'

export async function runTargetFlow(
  context,
  { productUrl, cvv, account, notificationEngine, dropEvent, mode, buyLimit = 1, onStep = () => {} }
) {
  const page = await context.newPage()
  const trace = await startTrace(context, {
    retailer: 'target',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout'
  })
  const isTestMode = mode === 'test-checkout'
  let requiresManual = false

  try {
    onStep('Opening Target product page')
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Check if signed in
    onStep('Checking Target sign-in status')
    const signInBtn = page.locator('a:has-text("Sign in"), button:has-text("Sign in")')
    if ((await signInBtn.count()) > 0) {
      onStep('Not signed in - please sign in manually or use auto-login first')
      requiresManual = true
      const { screenshotPath } = await trace.stop()
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath,
        message: 'Not signed in - use Target auto-login feature first'
      }
    }

    // Handle quantity if buyLimit > 1
    if (buyLimit > 1) {
      onStep(`Setting quantity to ${buyLimit}`)
      const quantitySelect = page.locator('select[data-test="@web/QuantitySelector"]')
      if ((await quantitySelect.count()) > 0) {
        await quantitySelect.selectOption({ value: String(buyLimit) })
        await page.waitForTimeout(500)
      }
    }

    // Add to cart
    onStep('Adding to cart')
    const addToCartBtn = page.locator(
      'button[data-test="@web/AddToCartButton"], button[data-test="orderPickupButton"], button:has-text("Add to cart")'
    )
    await addToCartBtn.first().click({ timeout: 15000 })
    await page.waitForTimeout(2000)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Handle "View cart & check out" modal if it appears
    const viewCartBtn = page.locator('a[href="/cart"]:has-text("View cart")')
    if ((await viewCartBtn.count()) > 0) {
      onStep('Navigating to cart')
      await viewCartBtn.first().click()
      await page.waitForLoadState('domcontentloaded')
    }

    // Go to checkout
    onStep('Opening Target checkout')
    await page.goto('https://www.target.com/co-cart', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Click "Checkout" button
    onStep('Proceeding to checkout')
    const checkoutBtn = page.locator(
      'button[data-test="checkout-button"], button:has-text("Checkout"), a:has-text("Checkout")'
    )
    if ((await checkoutBtn.count()) > 0) {
      await checkoutBtn.first().click({ timeout: 10000 })
      await page.waitForLoadState('domcontentloaded')
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    }

    // Wait for checkout page to load
    await page.waitForTimeout(2000)

    // Shipping address should already be saved in Target account
    onStep('Using saved shipping address')
    await page.waitForTimeout(1000)

    // Continue to payment
    onStep('Continuing to payment')
    const continueToPaymentBtn = page.locator(
      'button:has-text("Continue to payment"), button:has-text("Save and continue")'
    )
    if ((await continueToPaymentBtn.count()) > 0) {
      await continueToPaymentBtn.first().click({ timeout: 10000 })
      await page.waitForLoadState('domcontentloaded')
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    }

    // Handle payment
    onStep('Verifying payment method')
    await page.waitForTimeout(2000)

    // Check if CVV is needed
    const cvvInput = page.locator('input[id*="cvv"], input[name*="cvv"], input[placeholder*="CVV"]')
    if ((await cvvInput.count()) > 0 && cvv) {
      onStep('Entering CVV')
      await cvvInput.first().fill(cvv)
      await page.waitForTimeout(500)
    }

    // If no payment method, require manual intervention
    const addPaymentBtn = page.locator('button:has-text("Add payment"), button:has-text("Add card")')
    if ((await addPaymentBtn.count()) > 0) {
      onStep('Payment method required - please add manually')
      requiresManual = true
      const { screenshotPath } = await trace.stop()
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath,
        message: 'Payment method not saved - add in Target account first'
      }
    }

    // Continue to review order
    onStep('Continuing to review order')
    const continueToReviewBtn = page.locator(
      'button:has-text("Continue to review order"), button:has-text("Save and continue")'
    )
    if ((await continueToReviewBtn.count()) > 0) {
      await continueToReviewBtn.first().click({ timeout: 10000 })
      await page.waitForLoadState('domcontentloaded')
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    }

    // Wait for review page
    await page.waitForTimeout(2000)

    if (isTestMode) {
      onStep('TEST MODE: Stopping before final submission')
      requiresManual = true
      const { screenshotPath } = await trace.stop()
      return {
        success: true,
        testMode: true,
        requiresManualCheckout: true,
        screenshotPath,
        message: 'Test checkout ready - review and place order manually'
      }
    }

    // Place order
    onStep('Placing order')
    const placeOrderBtn = page.locator(
      'button[data-test="placeOrderButton"], button:has-text("Place your order"), button:has-text("Place order")'
    )

    if ((await placeOrderBtn.count()) === 0) {
      onStep('Place order button not found - manual intervention required')
      requiresManual = true
      const { screenshotPath } = await trace.stop()
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath,
        message: 'Could not find place order button - complete manually'
      }
    }

    await placeOrderBtn.first().click({ timeout: 10000 })
    await page.waitForLoadState('domcontentloaded')

    // Wait for confirmation
    onStep('Waiting for order confirmation')
    await page.waitForTimeout(5000)

    // Check for confirmation
    const confirmationIndicators = [
      'text="Order confirmed"',
      'text="Thank you"',
      'text="Order placed"',
      '[data-test="order-confirmation"]',
      'text="Your order is confirmed"'
    ]

    let confirmed = false
    for (const indicator of confirmationIndicators) {
      if ((await page.locator(indicator).count()) > 0) {
        confirmed = true
        break
      }
    }

    const { screenshotPath, tracePath } = await trace.stop()

    if (confirmed) {
      onStep('Order confirmed!')
      return {
        success: true,
        testMode: false,
        requiresManualCheckout: false,
        screenshotPath,
        tracePath,
        message: 'Target order placed successfully'
      }
    } else {
      onStep('Order status unclear - check manually')
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath,
        tracePath,
        message: 'Order may have been placed - verify manually'
      }
    }
  } catch (err) {
    onStep(`Error: ${err.message}`)
    const { screenshotPath, tracePath } = await trace.stop()
    return {
      success: false,
      requiresManualCheckout: requiresManual,
      screenshotPath,
      tracePath,
      error: err.message,
      message: `Target checkout failed: ${err.message}`
    }
  }
}
