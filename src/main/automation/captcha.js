const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="captcha"]',
  '[class*="captcha"]',
  '#challenge-form',
  '[data-sitekey]'
]

async function isCaptchaPresent(page) {
  try {
    return await page.evaluate((selectors) => {
      return selectors.some(sel => !!document.querySelector(sel)) ||
        document.title.toLowerCase().includes('captcha') ||
        document.title.toLowerCase().includes('robot') ||
        document.title.toLowerCase().includes('access denied')
    }, CAPTCHA_SELECTORS)
  } catch {
    return false
  }
}

export async function waitForCaptchaIfNeeded(page, notificationEngine, dropEvent) {
  const hasCaptcha = await isCaptchaPresent(page)
  if (!hasCaptcha) return

  await notificationEngine.fire({
    ...dropEvent,
    productName: `CAPTCHA REQUIRED: ${dropEvent.productName || 'Unknown'}`,
    dropType: 'captcha'
  })

  // Wait up to 5 minutes for CAPTCHA to be solved manually
  try {
    await page.waitForFunction(
      (selectors) => {
        return !selectors.some(sel => !!document.querySelector(sel)) &&
          !document.title.toLowerCase().includes('captcha') &&
          !document.title.toLowerCase().includes('robot') &&
          !document.title.toLowerCase().includes('access denied')
      },
      CAPTCHA_SELECTORS,
      { timeout: 300000, polling: 2000 }
    )
  } catch {
    // Timeout — CAPTCHA was not solved in 5 minutes, caller handles failure
  }
}
