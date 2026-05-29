import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runPokemonCenterFlow(context, { productUrl, notificationEngine, dropEvent }) {
  const page = await context.newPage()
  let requiresManual = false
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    const queueBtn = page.locator('button:has-text("Join Queue"), button:has-text("Enter Queue"), button:has-text("Join the Queue"), #btn-queue')
    if (await queueBtn.count() > 0) {
      await queueBtn.first().click()
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      await page.waitForSelector('button:has-text("Add to Cart"):not([disabled]), button:has-text("Add to cart"):not([disabled])', { timeout: 600000 })
    }

    requiresManual = true
    await notificationEngine.fire({
      ...dropEvent,
      productName: `QUEUE CLEARED — COMPLETE CHECKOUT: ${dropEvent.productName || 'Unknown'}`,
      dropType: 'queue_open'
    })

    return { success: true, requiresManualCheckout: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    if (!requiresManual) {
      try { await page.close() } catch {}
    }
  }
}
