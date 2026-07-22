import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'
import { fillCheckoutPayment } from './checkout-fields.js'
import { startCheckoutDiagnostics } from '../CheckoutDiagnostics.js'

const PLACE_ORDER_SELECTOR =
  'button:visible:has-text("Place order"), button:visible:has-text("Place Order"), button[data-testid*="place-order" i]:visible'
const SAMS_TRAFFIC_GATE_TIMEOUT_MS = 15 * 60 * 1000
const SAMS_CHECKOUT_RETRIES = 8
const SAMS_ADD_TO_CART_TIMEOUT_MS = 90 * 1000

export async function runSamsClubFlow(
  context,
  {
    productUrl,
    account,
    payment,
    cvv,
    notificationEngine,
    dropEvent,
    mode,
    buyLimit = 1,
    onStep = () => {},
    onMilestone = () => {}
  }
) {
  const page = await context.newPage()
  const trace = await startTrace(context, {
    retailer: 'samsclub',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout'
  })
  const diagnostics = await startCheckoutDiagnostics(page, {
    retailer: 'samsclub',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout',
    tracePath: trace.tracePath
  })
  const isTestMode = mode === 'test-checkout'
  const itemId = extractSamsItemId(productUrl)
  let requiresManual = false

  try {
    if (!itemId) throw new Error(`Cannot extract item ID from Sam's Club URL: ${productUrl}`)

    onStep("Opening Sam's Club product")
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForSamsTrafficGate(page, onStep)
    onMilestone('product_opened', `Sam's Club item ${itemId} loaded`)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    await ensureSamsSignedIn(page, account, notificationEngine, dropEvent, onStep, productUrl)
    onMilestone('session_checked', "Sam's Club member session verified")

    const addToCart = page
      .locator(
        'main button:visible:has-text("Add to Cart"), main button:visible:has-text("Add to cart"), main button[aria-label^="Add to Cart" i]:visible, main button[data-testid*="add-to-cart" i]:visible'
      )
      .first()
    onStep('Waiting for actionable Add to Cart')
    await waitForSamsAddToCart(page, addToCart, onStep)
    if (await addToCart.isDisabled().catch(() => false)) {
      throw new Error("Sam's Club Add to Cart is not active yet")
    }

    onStep('Adding exact item to cart')
    await addToCart.click({ timeout: 10000 })
    onMilestone('cart_attempted', `Requested Sam's Club item ${itemId}`)
    await waitForSamsTrafficGate(page, onStep)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    const cartAcknowledged = await waitForCartAcknowledgement(page)
    if (cartAcknowledged) {
      onMilestone('cart_acknowledged', `Sam's Club acknowledged item ${itemId}`)
    } else {
      onStep("Sam's Club did not show a cart confirmation; verifying the cart directly")
    }

    onStep('Opening cart')
    await page.goto('https://www.samsclub.com/cart', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForSamsTrafficGate(page, onStep)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    const cartItem = await waitForExactCartItem(page, itemId, onStep)
    if (!cartItem) {
      throw new Error(`Sam's Club cart does not contain requested item ${itemId}`)
    }
    const cartQuantity = await setCartQuantity(page, cartItem, buyLimit, onStep)
    onMilestone('cart_ready', `Item ${itemId} verified in cart at quantity ${cartQuantity}`)

    await openSamsCheckout(page, itemId, onStep, onMilestone)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    await advanceCheckout(page, onStep)
    const checkoutText = await visibleBodyText(page)
    const savedCardLast4 = samsSavedCardLast4(checkoutText)
    const assignedCardLast4 = payment?.cardNumber?.slice(-4) || null
    if (savedCardLast4 && assignedCardLast4 && savedCardLast4 !== assignedCardLast4) {
      throw new Error(
        `Sam's Club saved card ending ${savedCardLast4} does not match this account's assigned payment ending ${assignedCardLast4}`
      )
    }

    const checkoutPayment = payment
      ? { ...payment, cvv: payment.cvv || cvv || '' }
      : cvv
        ? { cvv }
        : null
    const paymentResult = await fillCheckoutPayment(context, checkoutPayment, onStep)
    if (!checkoutPayment && paymentResult.filled.length === 0) {
      onStep("Using payment already saved in the Sam's Club account")
    }

    const placeOrder = page.locator(PLACE_ORDER_SELECTOR).first()
    onStep('Waiting for Place order')
    await placeOrder.waitFor({ state: 'visible', timeout: 30000 })
    onMilestone('checkout_ready', "Sam's Club Place order control is visible")

    // The live Sam's review-order screen keeps Place order disabled until the
    // saved card's CVV is entered. Requiring an enabled button in test mode
    // proves the task is genuinely purchase-ready without submitting an order.
    await waitForEnabled(page, placeOrder, 15000)

    if (isTestMode) {
      onStep('Reached Place order; stopping safely in test mode')
      await trace.capture(page)
      await trace.stop()
      requiresManual = true
      return {
        success: true,
        testMode: true,
        requiresManualCheckout: true,
        tracePath: trace.tracePath,
        screenshotPath: trace.screenshotPath,
        message: "Sam's Club test reached Place order and stopped before purchase"
      }
    }

    onStep('Placing order')
    await placeOrder.click({ timeout: 10000 })
    await waitForOrderConfirmation(page)
    onMilestone('confirmed', "Sam's Club order confirmation detected")
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

async function ensureSamsSignedIn(
  page,
  account,
  notificationEngine,
  dropEvent,
  onStep,
  productUrl
) {
  const memberGate = page
    .locator(
      'button:visible:has-text("Sign In to See Price"), button:visible:has-text("Sign in to see price")'
    )
    .first()
  const addToCart = page
    .locator(
      'main button:visible:has-text("Add to Cart"), main button:visible:has-text("Add to cart")'
    )
    .first()
  const signedInAccount = page
    .locator('button[aria-label*="Account" i]:has-text("Hi,"), button:visible:has-text("Hi,")')
    .first()

  if (
    ((await memberGate.count()) === 0 && (await addToCart.count()) > 0) ||
    ((await signedInAccount.count()) > 0 && (await signedInAccount.isVisible().catch(() => false)))
  )
    return
  if (!account?.username || !account?.password) {
    throw new Error("Sam's Club requires a signed-in Plus account")
  }

  onStep("Signing into Sam's Club")
  const signIn =
    (await memberGate.count()) > 0
      ? memberGate
      : page.locator('button:visible:has-text("Sign In"), a:visible:has-text("Sign In")').first()
  if ((await signIn.count()) === 0) {
    throw new Error("Sam's Club sign-in control was not available")
  }
  await signIn.click({ timeout: 10000 })
  await page.waitForTimeout(500)
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  const email = page
    .locator('input[type="email"], input[name*="email" i], input[autocomplete="username"]')
    .first()
  await email.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  if ((await email.count()) > 0 && (await email.isVisible().catch(() => false))) {
    await email.fill(account.username)
    await page
      .locator('button:visible:has-text("Continue"), button[type="submit"]:visible')
      .first()
      .click({ timeout: 10000 })
  }

  const password = page.locator('input[type="password"], input[name*="password" i]').first()
  await password.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  if ((await password.count()) > 0 && (await password.isVisible().catch(() => false))) {
    await password.fill(account.password)
    await page
      .locator('button:visible:has-text("Sign In"), button[type="submit"]:visible')
      .first()
      .click({ timeout: 10000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  }

  if (!page.url().includes('/ip/')) {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForSamsTrafficGate(page, onStep)
  }
  await page
    .locator('button:visible:has-text("Add to Cart"), button:visible:has-text("Add to cart")')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
}

async function waitForCartAcknowledgement(page) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    // The observed live flow navigated to /pac immediately after a successful
    // add. That route is authoritative even before its text finishes rendering.
    if (isSamsCartAcknowledgementUrl(page.url())) return true
    const bodyText = await visibleBodyText(page)
    if (/added to (your )?cart/i.test(bodyText)) return true

    const cartLabel = await page
      .locator('button[aria-label*="Cart contains" i], [data-testid*="cart-count" i]')
      .first()
      .getAttribute('aria-label')
      .catch(() => '')
    if (cartCountFromText(cartLabel) > 0) return true
    await page.waitForTimeout(200)
  }
  return false
}

export function isSamsCartAcknowledgementUrl(url) {
  return /samsclub\.com\/pac(?:[/?#]|$)/i.test(String(url || ''))
}

async function waitForSamsAddToCart(page, addToCart, onStep = () => {}) {
  const deadline = Date.now() + SAMS_ADD_TO_CART_TIMEOUT_MS
  let unavailableReadings = 0
  let refreshes = 0
  while (Date.now() < deadline) {
    if ((await addToCart.count()) > 0 && (await addToCart.isVisible().catch(() => false))) return
    const state = classifySamsPageText(await visibleBodyText(page), page.url())
    if (state === 'unavailable') {
      unavailableReadings += 1
      // A launch can briefly render the previous unavailable state after the
      // lightweight monitor has seen the new product payload. Refresh only a
      // handful of times, preserving the same authenticated browser session.
      if (unavailableReadings >= 2 && refreshes < 6) {
        refreshes += 1
        onStep(`Waiting for Sam's Club Add to Cart to settle (${refreshes}/6)`)
        await page.waitForTimeout(750 + refreshes * 250)
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        await waitForSamsTrafficGate(page, onStep)
        continue
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error("Sam's Club Add to Cart did not appear")
}

async function waitForExactCartItem(page, itemId, onStep = () => {}) {
  const deadline = Date.now() + 15000
  let refreshed = false
  while (Date.now() < deadline) {
    const item = await findExactCartItem(page, itemId, 1000)
    if (item) return item
    if (!refreshed && Date.now() + 10000 > deadline) {
      refreshed = true
      onStep("Waiting for Sam's Club cart to finish syncing")
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
    await page.waitForTimeout(250)
  }
  return null
}

async function openSamsCheckout(page, itemId, onStep, onMilestone) {
  for (let attempt = 1; attempt <= SAMS_CHECKOUT_RETRIES; attempt += 1) {
    const cartItem = await findExactCartItem(page, itemId)
    if (!cartItem) {
      throw new Error(`Sam's Club cart was emptied before checkout for item ${itemId}`)
    }

    const checkout = page
      .locator(
        'button:visible:has-text("Check Out"), button:visible:has-text("Checkout"), button:visible:has-text("Begin checkout"), a:visible:has-text("Check Out"), a:visible:has-text("Checkout")'
      )
      .first()
    await checkout.waitFor({ state: 'visible', timeout: 15000 })
    if (await checkout.isDisabled().catch(() => false)) {
      throw new Error("Sam's Club Checkout button is disabled")
    }

    onStep(
      attempt === 1
        ? 'Starting checkout'
        : `Retrying Sam's Club checkout in the same session (${attempt}/${SAMS_CHECKOUT_RETRIES})`
    )
    await checkout.click({ timeout: 10000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
    await waitForSamsTrafficGate(page, onStep)

    const outcome = await waitForSamsCheckoutOutcome(page)
    if (outcome === 'ready') {
      onMilestone('checkout_opened', "Sam's Club checkout loaded")
      return
    }
    if (outcome !== 'temporary-error') {
      throw new Error("Sam's Club checkout did not reach order review")
    }

    onMilestone(
      'checkout_rejected',
      `Sam's Club returned a temporary checkout error on attempt ${attempt}`
    )
    onStep("Sam's Club checkout request was temporarily rejected; preserving the session")
    if (attempt === SAMS_CHECKOUT_RETRIES) {
      throw new Error(
        `Sam's Club checkout request failed temporarily after ${SAMS_CHECKOUT_RETRIES} attempts`
      )
    }

    const okay = page.getByRole('button', { name: /^Okay$/i }).first()
    if ((await okay.count()) > 0 && (await okay.isVisible().catch(() => false))) {
      await okay.click({ timeout: 5000 }).catch(() => {})
    }
    await page.waitForTimeout(samsCheckoutRetryDelay(attempt))
    await returnToSamsCart(page, onStep)
  }
}

async function returnToSamsCart(page, onStep) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (/\/cart(?:[/?#]|$)/i.test(page.url())) return
    await page.waitForTimeout(250)
  }
  onStep("Returning to Sam's Club cart without restarting the browser")
  await page.goto('https://www.samsclub.com/cart', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await waitForSamsTrafficGate(page, onStep)
}

async function waitForSamsCheckoutOutcome(page) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const state = classifySamsPageText(await visibleBodyText(page), page.url())
    if (state === 'checkout-error') return 'temporary-error'
    if (state === 'checkout') return 'ready'
    if (state === 'unavailable' || state === 'empty-cart') return state
    await page.waitForTimeout(250)
  }
  return 'unknown'
}

export async function waitForSamsTrafficGate(
  page,
  onStep = () => {},
  timeoutMs = SAMS_TRAFFIC_GATE_TIMEOUT_MS
) {
  const startedAt = Date.now()
  let announced = false
  while (Date.now() - startedAt < timeoutMs) {
    const state = classifySamsPageText(await visibleBodyText(page), page.url())
    if (state !== 'traffic-gate') return state
    if (!announced) {
      announced = true
      onStep("Sam's Club traffic gate detected; holding the warm session without refreshing")
    }
    await page.waitForTimeout(500)
  }
  throw new Error("Sam's Club traffic gate did not clear")
}

export function classifySamsPageText(text, url = '') {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (
    /hold tight for a moment|high traffic is slowing things down|experiencing high (?:traffic|demand)/.test(
      value
    )
  ) {
    return 'traffic-gate'
  }
  if (
    /\/checkout(?:\/|\?|$)/i.test(String(url || '')) &&
    /something went wrong|unable to process your request|try again later/.test(value)
  ) {
    return 'checkout-error'
  }
  if (
    /we['’]re having trouble with your request|we are having trouble with your request/.test(value)
  ) {
    return 'checkout-error'
  }
  if (/shipping not available/.test(value) && /shop similar/.test(value)) return 'unavailable'
  if (/cart\s*\(0 items?\)|cart contains 0 items/.test(value)) return 'empty-cart'
  if (/\/checkout(?:\/|\?|$)/i.test(String(url || '')) || /review order|place order/.test(value)) {
    return 'checkout'
  }
  return 'normal'
}

async function visibleBodyText(page) {
  return page
    .locator('body')
    .innerText({ timeout: 3000 })
    .catch(() => '')
}

function cartCountFromText(value) {
  return Number(String(value || '').match(/cart contains\s+(\d+)\s+items?/i)?.[1] || 0)
}

export async function findExactCartItem(page, itemId, timeout = 15000) {
  const link = page.locator(`a[href*="/${itemId}"]`).first()
  await link.waitFor({ state: 'attached', timeout }).catch(() => {})
  if ((await link.count()) === 0) return null

  const row = link.locator(
    'xpath=ancestor::*[self::article or self::li or contains(translate(@data-testid, "CARTITEM", "cartitem"), "cart-item") or contains(translate(@data-automation-id, "CARTITEM", "cartitem"), "cart-item")][1]'
  )
  return (await row.count()) > 0 ? row : link.locator('xpath=ancestor::div[1]')
}

export function samsCheckoutRetryDelay(attempt) {
  return Math.min(6000, 750 * 2 ** Math.max(0, Number(attempt) - 1))
}

export function samsSavedCardLast4(text) {
  return String(text || '').match(/ending in\s+(\d{4})/i)?.[1] || null
}

export async function setCartQuantity(page, cartItem, requested, onStep = () => {}) {
  const quantity = Math.max(1, Math.min(2, Number(requested) || 1))
  const select = cartItem
    .locator(
      'select[aria-label*="quantity" i], select[name*="quantity" i], select[data-testid*="quantity" i]'
    )
    .first()
  const input = cartItem
    .locator(
      'input[aria-label*="quantity" i], input[name*="quantity" i], input[data-testid*="quantity" i]'
    )
    .first()

  if ((await select.count()) > 0) {
    if (String(await select.inputValue().catch(() => '1')) !== String(quantity)) {
      onStep(`Setting quantity to ${quantity}`)
      await select.selectOption(String(quantity))
    }
    await waitForQuantity(select, quantity)
    return Number(await select.inputValue())
  }

  if ((await input.count()) > 0) {
    if (String(await input.inputValue().catch(() => '1')) !== String(quantity)) {
      onStep(`Setting quantity to ${quantity}`)
      await input.fill(String(quantity))
      await input.press('Enter')
    }
    await waitForQuantity(input, quantity)
    return Number(await input.inputValue())
  }

  const quantityButton = cartItem
    .locator('button[aria-label*="quantity" i], button:has-text("Qty")')
    .first()

  // Sam's current cart uses separate accessible decrement/increment buttons:
  // "Increase quantity …, Current Quantity 1". Handle those before the older
  // quantity-menu fallback so a request for two never clicks Decrease.
  const increase = cartItem.locator('button[aria-label^="Increase quantity" i]').first()
  const decrease = cartItem.locator('button[aria-label^="Decrease quantity" i]').first()
  if ((await increase.count()) > 0 || (await decrease.count()) > 0) {
    const control = (await increase.count()) > 0 ? increase : decrease
    let current = samsCurrentCartQuantity(await control.getAttribute('aria-label'))
    if (!current) current = 1
    while (current < quantity) {
      if ((await increase.count()) === 0) {
        throw new Error("Sam's Club cart quantity cannot be increased")
      }
      onStep(`Setting quantity to ${quantity}`)
      await increase.click()
      current += 1
      await page.waitForTimeout(250)
    }
    while (current > quantity) {
      if ((await decrease.count()) === 0) {
        throw new Error("Sam's Club cart quantity cannot be decreased")
      }
      onStep(`Setting quantity to ${quantity}`)
      await decrease.click()
      current -= 1
      await page.waitForTimeout(250)
    }
    return current
  }

  if ((await quantityButton.count()) > 0) {
    const current = quantityFromText(await quantityButton.innerText().catch(() => ''))
    if (current !== quantity) {
      onStep(`Setting quantity to ${quantity}`)
      await quantityButton.click()
      const option = page.getByRole('option', { name: new RegExp(`^${quantity}$`) }).first()
      const menuItem = page.getByRole('menuitem', { name: new RegExp(`^${quantity}$`) }).first()
      if ((await option.count()) > 0) await option.click()
      else if ((await menuItem.count()) > 0) await menuItem.click()
      else throw new Error(`Sam's Club quantity ${quantity} option was not available`)
    }
    return quantity
  }

  if (quantity === 1) return 1
  throw new Error("Sam's Club cart quantity could not be verified")
}

async function waitForQuantity(locator, expected) {
  const updated = await locator.evaluate(async (element, expectedValue) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (String(element.value) === expectedValue) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return String(element.value) === expectedValue
  }, String(expected))
  if (!updated) throw new Error(`Sam's Club cart quantity did not update to ${expected}`)
}

function quantityFromText(text) {
  return Number(String(text).match(/\d+/)?.[0] || 0)
}

export function samsCurrentCartQuantity(label) {
  return Number(String(label || '').match(/current quantity\s+(\d+)/i)?.[1] || 0)
}

async function advanceCheckout(page, onStep) {
  for (let step = 0; step < 5; step += 1) {
    const placeOrder = page.locator(PLACE_ORDER_SELECTOR)
    if ((await placeOrder.count()) > 0) return
    const next = page
      .locator(
        'button:visible:has-text("Continue"), button:visible:has-text("Save and continue"), button:visible:has-text("Review order"), button:visible:has-text("Continue to payment")'
      )
      .first()
    if ((await next.count()) === 0) return
    if (await next.isDisabled().catch(() => false)) return
    onStep('Advancing checkout')
    await next.click({ timeout: 10000 })
    await page.waitForTimeout(500)
  }
}

async function waitForEnabled(page, locator, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!(await locator.isDisabled().catch(() => true))) return
    await page.waitForTimeout(250)
  }
  throw new Error("Sam's Club Place order is disabled; verify shipping and payment")
}

async function waitForOrderConfirmation(page) {
  await Promise.race([
    page
      .locator('text=/thank you|order (confirmed|number)|we received your order/i')
      .first()
      .waitFor({ state: 'visible', timeout: 45000 }),
    page.waitForURL(/\/orders?\/|confirmation|thank-you/i, { timeout: 45000 })
  ])
}

function extractSamsItemId(productUrl) {
  try {
    const segments = new URL(productUrl).pathname.split('/').filter(Boolean)
    return segments.findLast((segment) => /^\d{6,}$/.test(segment)) || null
  } catch {
    return null
  }
}
