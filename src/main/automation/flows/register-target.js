import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runTargetRegistration(
  context,
  { email, password, firstName, lastName, phone = '', notificationEngine }
) {
  const page = await context.newPage()
  const captchaCtx = {
    notificationEngine,
    dropEvent: { productName: `Register: ${email}`, dropType: 'registration' }
  }

  const log = (...args) => console.log('[target-register]', ...args)

  try {
    // ── Step 1: navigate ──────────────────────────────────────────────────────
    log('navigating to create-account page')
    await page.goto('https://www.target.com/account/create-account', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await page.waitForLoadState('networkidle').catch(() => {})
    log('url after load:', page.url())
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    // ── Step 1: fill email + Continue ─────────────────────────────────────────
    // Target login: id="username", autocomplete="username webauthn", placeholder=" ", type="text"
    const emailField = page.locator(
      'input[id="username"], input[name="username"], input[autocomplete*="username"], input[inputmode="email"]'
    )
    log('waiting for email field...')
    await emailField.first().waitFor({ state: 'visible', timeout: 15000 })
    log('email field found, filling:', email)
    await emailField.first().fill(email)

    const continueBtn = page.locator('button:has-text("Continue")')
    log('clicking Continue')
    await continueBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)
    log('url after Continue:', page.url())

    // ── Step 2: detect if create-account form appeared ────────────────────────
    // If email already exists, Target shows sign-in form (no firstname field)
    // firstname: id="firstname", name="firstnamecreateaccount"
    const firstNameField = page.locator(
      'input[id="firstname"], input[name="firstnamecreateaccount"]'
    )
    log('waiting for Create-an-account form (firstname field)...')
    try {
      await firstNameField.first().waitFor({ state: 'visible', timeout: 15000 })
    } catch {
      // Timeout: Target showed sign-in form instead — email already has an account
      log('firstname field did not appear — account already exists')
      return { success: false, alreadyExists: true, error: 'Account already exists for this email' }
    }
    log('firstname field found')

    // ── Step 2: fill profile ──────────────────────────────────────────────────
    log('filling firstName:', firstName)
    await firstNameField.first().fill(firstName)

    const lastNameField = page.locator('input[id="lastname"], input[name="lastnamecreateaccount"]')
    log('filling lastName:', lastName)
    await lastNameField.first().fill(lastName)

    if (phone) {
      const phoneField = page.locator('input[id="phone"], input[name="phonecreateAccount"]')
      const phoneCount = await phoneField.count()
      log('phone field count:', phoneCount)
      if (phoneCount > 0) {
        log('filling phone:', phone)
        await phoneField.first().fill(phone)
      }
    }

    // Passkey is selected by default — click password radio to switch
    // id="password-checkbox", name="auth-factor", value="password"
    const passwordRadio = page.locator('input[id="password-checkbox"]')
    log('clicking password radio')
    await passwordRadio.first().click()

    // Password field: id="password", name="passwordcreateaccount", autocomplete="new-password"
    const passwordField = page.locator(
      'input[id="password"], input[name="passwordcreateaccount"], input[autocomplete="new-password"]'
    )
    log('waiting for password field...')
    await passwordField.first().waitFor({ state: 'visible', timeout: 10000 })
    log('filling password')
    await passwordField.first().fill(password)

    // Button starts disabled — wait for it to become enabled after form is valid
    const createAccountBtn = page.locator(
      'button[id="createAccount"], button[data-test="form-submit-button"]'
    )
    log('waiting for Create account button to be enabled...')
    await waitForEnabled(createAccountBtn.first(), page, 10000)
    log('clicking Create account')
    await createAccountBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)
    log('url after submit:', page.url())

    // ── Check for inline errors ───────────────────────────────────────────────
    const errorEl = page.locator(
      '[data-test="errorMessage"], [class*="form-error"], [aria-live="polite"]'
    )
    if ((await errorEl.count()) > 0) {
      const errorText = await errorEl
        .first()
        .textContent()
        .catch(() => '')
      log('error element text:', errorText)
      if (/already|registered|exists/i.test(errorText)) {
        return { success: false, alreadyExists: true, error: errorText.trim() }
      }
      if (errorText.trim()) {
        return { success: false, alreadyExists: false, error: errorText.trim() }
      }
    }

    log('waiting for redirect away from login...')
    await page.waitForURL(/target\.com\/(?!login|account\/create-account)/, { timeout: 15000 })
    log('registration complete, final url:', page.url())

    return { success: true, needsVerification: true }
  } catch (err) {
    log('ERROR:', err.message)
    try {
      log('url at error:', page.url())
    } catch {
      // Page may already be closed.
    }
    return { success: false, alreadyExists: false, error: err.message }
  } finally {
    try {
      await page.close()
    } catch {
      // Best effort cleanup only.
    }
  }
}

async function waitForEnabled(locator, page, timeout = 10000) {
  await locator.waitFor({ state: 'visible', timeout })

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(250)
    else await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error('Create account button did not become enabled')
}
