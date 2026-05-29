import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runTargetFlow(context, { productUrl, cvv, account, notificationEngine, dropEvent }) {
  const page = await context.newPage()
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Add to cart
    const atcBtn = page.locator('button[data-test="shippingCardStepper-cta-button"], button[data-test="fulfillmentSection-shipIt-button"], button:has-text("Add to cart"), button:has-text("Add to Cart")')
    await atcBtn.first().click({ timeout: 15000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Go to cart/checkout
    await page.goto('https://www.target.com/co-cart', { waitUntil: 'domcontentloaded', timeout: 30000 })
    const checkoutBtn = page.locator('button[data-test="checkout-button"], a[data-test="checkout-button"]')
    await checkoutBtn.first().click({ timeout: 15000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Target may prompt for password re-entry
    const passwordPrompt = page.locator('input[name="password"][type="password"]')
    if (await passwordPrompt.count() > 0) {
      if (!account?.password) {
        throw new Error('Target requires password re-entry but no account credentials were provided')
      }
      if (account.password) {
        await passwordPrompt.fill(account.password)
        const signInBtn = page.locator('button[type="submit"]:has-text("Sign in"), button:has-text("Sign In")')
        await signInBtn.first().click({ timeout: 10000 })
        await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      }
    }

    // Enter CVV
    const cvvField = page.locator('input[name="cvv"], input[id*="cvv"], input[aria-label*="CVV"]')
    if (await cvvField.count() > 0) {
      await cvvField.first().fill(cvv)
    }

    // Place order
    const placeOrderBtn = page.locator('button[data-test="placeOrderButton"], button:has-text("Place order"), button:has-text("Place Order")')
    await placeOrderBtn.first().click({ timeout: 15000 })

    // Wait for confirmation
    await page.waitForSelector('[data-test="orderConfirmationContainer"], [class*="order-confirm"]', { timeout: 30000 })

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    try { await page.close() } catch {}
  }
}
