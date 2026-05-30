import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runWalmartRegistration(
  context,
  { email, password, firstName, lastName, phone = '', notificationEngine }
) {
  const page = await context.newPage()
  const captchaCtx = {
    notificationEngine,
    dropEvent: { productName: `Register: ${email}`, dropType: 'registration' }
  }
  try {
    await page.goto('https://www.walmart.com/account/signup', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    const firstNameField = page.locator('input[name="firstName"], input[id="first-name"]')
    await firstNameField.first().fill(firstName)

    const lastNameField = page.locator('input[name="lastName"], input[id="last-name"]')
    await lastNameField.first().fill(lastName)

    const emailField = page.locator('input[type="email"], input[name="email"]')
    await emailField.first().fill(email)

    const passwordField = page.locator('input[type="password"], input[name="password"]')
    await passwordField.first().fill(password)

    if (phone) {
      const phoneField = page.locator('input[name="phone"], input[id="phone"]')
      if ((await phoneField.count()) > 0) {
        await phoneField.first().fill(phone)
      }
    }

    const submitBtn = page.locator('button[type="submit"]')
    await submitBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    const errorEl = page.locator(
      '[class*="error-text"], [class*="ErrorText"], [role="alert"]'
    )
    if ((await errorEl.count()) > 0) {
      const errorText = await errorEl.first().textContent().catch(() => '')
      if (/already|registered|exists/i.test(errorText)) {
        return { success: false, alreadyExists: true, error: errorText.trim() }
      }
      return { success: false, alreadyExists: false, error: errorText.trim() }
    }

    await page.waitForURL(/walmart\.com\/(?!account\/signup)/, { timeout: 15000 })

    return { success: true, needsVerification: true }
  } catch (err) {
    return { success: false, alreadyExists: false, error: err.message }
  } finally {
    try {
      await page.close()
    } catch {}
  }
}
