import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runWalmartFlow(context, { productUrl, cvv, notificationEngine, dropEvent }) {
  const page = await context.newPage()
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Check for queue first
    const queueBtn = page.locator('button:has-text("Join Waitlist"), button:has-text("Get In Line"), button:has-text("Join queue")')
    if (await queueBtn.count() > 0) {
      await queueBtn.first().click()
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      // Wait up to 10 minutes to exit queue
      await page.waitForSelector('[class*="add-to-cart"]:not([disabled]), button[data-automation-id="atc"]:not([disabled])', { timeout: 600000 })
    }

    // Add to cart
    const atcBtn = page.locator('button[data-automation-id="atc"], button:has-text("Add to cart")')
    await atcBtn.first().click({ timeout: 15000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Go to checkout
    await page.goto('https://www.walmart.com/checkout', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Enter CVV
    const cvvField = page.locator('input[name="cvv"], input[placeholder*="CVV"], input[aria-label*="CVV"], input[aria-label*="cvv"]')
    if (await cvvField.count() > 0) {
      await cvvField.first().fill(cvv)
    }

    // Place order
    const placeOrderBtn = page.locator('button:has-text("Place order"), button[data-automation-id="place-order"], button:has-text("Place Order")')
    await placeOrderBtn.first().click({ timeout: 15000 })

    // Wait for confirmation
    await page.waitForSelector('[class*="order-confirmation"], [class*="thank-you"], [class*="orderConfirmation"]', { timeout: 30000 })

    let orderId = 'unknown'
    try { orderId = await page.textContent('[class*="order-number"], [class*="orderNumber"]') } catch {}

    return { success: true, orderId: orderId?.trim() || 'unknown' }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    try { await page.close() } catch {}
  }
}
