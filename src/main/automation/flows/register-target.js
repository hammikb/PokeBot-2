import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runTargetRegistration(
  context,
  { email, password, firstName, lastName, notificationEngine }
) {
  const page = await context.newPage()
  const captchaCtx = {
    notificationEngine,
    dropEvent: { productName: `Register: ${email}`, dropType: 'registration' }
  }
  try {
    await page.goto('https://www.target.com/account/create-account', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    const firstNameField = page.locator('input[id="firstName"], input[name="firstName"]')
    await firstNameField.first().fill(firstName)

    const lastNameField = page.locator('input[id="lastName"], input[name="lastName"]')
    await lastNameField.first().fill(lastName)

    const emailField = page.locator('input[id="username"], input[type="email"]')
    await emailField.first().fill(email)

    const passwordField = page.locator('input[id="password"], input[type="password"]')
    await passwordField.first().fill(password)

    const confirmField = page.locator('input[id="confirmPassword"], input[name="confirmPassword"]')
    if ((await confirmField.count()) > 0) {
      await confirmField.first().fill(password)
    }

    const submitBtn = page.locator('button[type="submit"]')
    await submitBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    const errorEl = page.locator(
      '[data-test="errorMessage"], [class*="form-error"], [aria-live="polite"]'
    )
    if ((await errorEl.count()) > 0) {
      const errorText = await errorEl.first().textContent().catch(() => '')
      if (/already|registered|exists/i.test(errorText)) {
        return { success: false, alreadyExists: true, error: errorText.trim() }
      }
      return { success: false, alreadyExists: false, error: errorText.trim() }
    }

    await page.waitForURL(/target\.com\/account/, { timeout: 15000 })

    return { success: true, needsVerification: true }
  } catch (err) {
    return { success: false, alreadyExists: false, error: err.message }
  } finally {
    try {
      await page.close()
    } catch {}
  }
}
