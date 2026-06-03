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
    // Wait for JS render to settle before looking for form fields
    await page.waitForLoadState('networkidle').catch(() => {})
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    // Wait for first name field to confirm the form is ready
    const firstNameField = page.locator(
      'input[name="firstName"], input[id="first-name"], input[autocomplete="given-name"]'
    )
    await firstNameField.first().waitFor({ state: 'visible', timeout: 15000 })
    await firstNameField.first().fill(firstName)

    const lastNameField = page.locator(
      'input[name="lastName"], input[id="last-name"], input[autocomplete="family-name"]'
    )
    await lastNameField.first().waitFor({ state: 'visible', timeout: 10000 })
    await lastNameField.first().fill(lastName)

    const emailField = page.locator(
      'input[type="email"], input[name="email"], input[autocomplete="email"]'
    )
    await emailField.first().waitFor({ state: 'visible', timeout: 10000 })
    await emailField.first().fill(email)

    const passwordField = page.locator(
      'input[name="password"][type="password"], input[autocomplete="new-password"]'
    )
    await passwordField.first().waitFor({ state: 'visible', timeout: 10000 })
    await passwordField.first().fill(password)

    if (phone) {
      const phoneField = page.locator(
        'input[name="phone"], input[id="phone"], input[autocomplete="tel"]'
      )
      if ((await phoneField.count()) > 0) {
        await phoneField.first().fill(phone)
      }
    }

    const submitBtn = page.locator('button[type="submit"]')
    await submitBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    const errorEl = page.locator('[class*="error-text"], [class*="ErrorText"], [role="alert"]')
    if ((await errorEl.count()) > 0) {
      const errorText = await errorEl
        .first()
        .textContent()
        .catch(() => '')
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
    } catch {
      // Best effort cleanup; registration result has already been returned.
    }
  }
}
