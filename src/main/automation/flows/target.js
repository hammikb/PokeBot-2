import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'
import {
  ensureTargetSignedIn,
  fillTargetShipping,
  fillTargetPayment
} from './target-page-utils.js'

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

    // Ensure signed in
    await ensureTargetSignedIn(page, account, notificationEngine, dropEvent, onStep, productUrl)

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

    // Handle shipping address
    onStep('Verifying shipping address')
    const shippingSection = page.locator('[data-test="shipping-address-section"]')
    if ((await shippingSection.count()) > 0) {
      const editShippingBtn = page.locator('button:has-text("Edit"), button:has-text("Change")')
      if ((await editShippingBtn.count()) > 0) {
        onStep('Updating shipping address')
        await editShippingBtn.first().click()
        await page.waitForTimeout(1000)
        await fillTargetShipping(page, account.shipping_json ? JSON.parse(account.shipping_json) : {})
      }
    }

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

    // If no payment method, try to add one
    const addPaymentBtn = page.locator('button:has-text("Add payment"), button:has-text("Add card")')
    if ((await addPaymentBtn.count()) > 0) {
      onStep('Adding payment method')
      await addPaymentBtn.first().click()
      await page.waitForTimeout(1000)
      await fillTargetPayment(page, cvv)
      requiresManual = true
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
