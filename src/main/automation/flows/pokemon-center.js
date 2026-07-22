import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'
import { fillCheckoutPayment } from './checkout-fields.js'
import { startCheckoutDiagnostics } from '../CheckoutDiagnostics.js'

export async function runPokemonCenterFlow(
  context,
  { productUrl, account, payment, notificationEngine, dropEvent, mode, onStep = () => {} }
) {
  const page = await context.newPage()
  const trace = await startTrace(context, {
    retailer: 'pokemon-center',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout'
  })
  const diagnostics = await startCheckoutDiagnostics(page, {
    retailer: 'pokemon-center',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout',
    tracePath: trace.tracePath
  })
  const isTestMode = mode === 'test-checkout'
  let requiresManual = false

  try {
    onStep('Opening Pokémon Center product')
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    const queueButton = page
      .locator(
        'button:visible:has-text("Join Queue"), button:visible:has-text("Enter Queue"), #btn-queue'
      )
      .first()
    if ((await queueButton.count()) > 0) {
      onStep('Joining Pokémon Center queue')
      await queueButton.click({ timeout: 10000 })
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    }

    const addToCart = page
      .locator(
        'button:visible:has-text("Add to Cart"), button:visible:has-text("Add to cart"), button:visible:has-text("Preorder: Add to Cart")'
      )
      .first()
    onStep('Waiting for Add to Cart')
    await addToCart.waitFor({ state: 'visible', timeout: 600000 })
    if (await addToCart.isDisabled().catch(() => false)) {
      throw new Error('Pokémon Center Add to Cart is not active')
    }
    await addToCart.click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    onStep('Opening cart')
    await page.goto('https://www.pokemoncenter.com/cart', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    const checkout = page
      .locator('button:visible:has-text("Checkout"), a:visible:has-text("Checkout")')
      .first()
    await checkout.waitFor({ state: 'visible', timeout: 15000 })
    await checkout.click({ timeout: 10000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    await signInAtCheckout(page, account, onStep)
    await advancePokemonCheckout(page, onStep)
    await fillCheckoutPayment(context, payment, onStep)

    const placeOrder = page
      .locator(
        'button:visible:has-text("Place Order"), button:visible:has-text("Place order"), button[type="submit"]:visible:has-text("Order")'
      )
      .first()
    onStep('Waiting for Place Order')
    await placeOrder.waitFor({ state: 'visible', timeout: 30000 })

    if (isTestMode) {
      onStep('Reached Place Order; stopping safely in test mode')
      await trace.capture(page)
      await trace.stop()
      requiresManual = true
      return {
        success: true,
        testMode: true,
        requiresManualCheckout: true,
        tracePath: trace.tracePath,
        screenshotPath: trace.screenshotPath,
        message: 'Pokémon Center test reached Place Order and stopped before purchase'
      }
    }

    if (await placeOrder.isDisabled().catch(() => false)) {
      throw new Error('Pokémon Center Place Order is disabled; verify checkout details')
    }
    onStep('Placing Pokémon Center order')
    await placeOrder.click({ timeout: 10000 })
    await page
      .locator('text=/thank you|order (confirmed|number)|order has been placed/i')
      .first()
      .waitFor({ state: 'visible', timeout: 45000 })
    await trace.stop()
    return { success: true, tracePath: trace.tracePath }
  } catch (error) {
    const diagnosticsPath = await diagnostics.capture(error)
    await trace.capture(page)
    await trace.stop()
    requiresManual = isTestMode
    return {
      success: false,
      error: error.message,
      requiresManualCheckout: isTestMode,
      tracePath: trace.tracePath,
      screenshotPath: trace.screenshotPath,
      diagnosticsPath
    }
  } finally {
    diagnostics.dispose()
    if (!requiresManual) await page.close().catch(() => {})
  }
}

async function signInAtCheckout(page, account, onStep) {
  const email = page
    .locator('input[type="email"], input[name*="email" i], input[autocomplete="username"]')
    .first()
  if ((await email.count()) === 0 || !(await email.isVisible().catch(() => false))) return
  if (!account?.username || !account?.password) {
    throw new Error('Pokémon Center checkout needs a signed-in account')
  }
  onStep('Signing into Pokémon Center')
  await email.fill(account.username)
  const password = page.locator('input[type="password"], input[name*="password" i]').first()
  await password.fill(account.password)
  await page
    .locator('button:visible:has-text("Sign In"), button[type="submit"]:visible')
    .first()
    .click({ timeout: 10000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
}

async function advancePokemonCheckout(page, onStep) {
  for (let step = 0; step < 4; step += 1) {
    if (
      (await page
        .locator('button:visible:has-text("Place Order"), button:visible:has-text("Place order")')
        .count()) > 0
    )
      return
    const next = page
      .locator(
        'button:visible:has-text("Continue"), button:visible:has-text("Continue to Payment"), button:visible:has-text("Review Order"), button:visible:has-text("Save and Continue")'
      )
      .first()
    if ((await next.count()) === 0) return
    onStep('Advancing Pokémon Center checkout')
    await next.click({ timeout: 10000 })
    await page.waitForTimeout(500)
  }
}
