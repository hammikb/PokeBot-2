import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runCostcoFlow(context, { productUrl, notificationEngine, dropEvent }) {
  const page = await context.newPage()
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Join queue if present (Costco uses virtual waiting room)
    const queueBtn = page.locator('button:has-text("Join Queue"), button:has-text("Enter Waiting Room"), [class*="waiting-room"] button')
    if (await queueBtn.count() > 0) {
      await queueBtn.first().click()
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      // Wait up to 10 minutes for queue to clear
      await page.waitForSelector('#add-to-cart-btn:not([disabled]), button:has-text("Add to Cart"):not([disabled])', { timeout: 600000 })
    }

    // Costco checkout is manual — alert user and leave page open
    await notificationEngine.fire({
      ...dropEvent,
      productName: `QUEUE CLEARED — COMPLETE CHECKOUT: ${dropEvent.productName || 'Unknown'}`,
      dropType: 'queue_open'
    })

    return { success: true, requiresManualCheckout: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    try { await page.close() } catch {}
  }
}
