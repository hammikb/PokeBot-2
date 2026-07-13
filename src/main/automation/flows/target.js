import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'
import { TargetApiClient } from '../api/targetApi.js'

import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('TargetFlow')

export async function runTargetFlow(
  context,
  { productUrl, cvv, account, notificationEngine, dropEvent, mode, buyLimit = 1, onStep = () => {} }
) {
  const page = await context.newPage()
  const trace = await startTrace(context, {
    retailer: 'target',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout'
  })
  const isTestMode = mode === 'test-checkout'
  let requiresManual = false

  try {
    // Extract TCIN from URL for API operations
    const tcin = TargetApiClient.extractTcin(productUrl)
    const useApi = tcin !== null

    // In API mode we don't need the product page at all — the cart API only needs a
    // `*.target.com` origin (for cookies + CORS) plus the tcin. Navigating straight to the
    // cart page satisfies the origin requirement AND means the item we add via API shows up
    // on the very page we'll check out from (after a reload), saving a full product-page load.
    if (useApi) {
      onStep('Using API-based cart (10x faster!)')
      log.info('Using API for cart operations', { tcin, buyLimit })
      await page.goto('https://www.target.com/co-cart', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } else {
      onStep('Opening Target product page')
      log.warn('Could not extract TCIN, falling back to browser automation')
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    // Check if signed in by looking for account indicator
    onStep('Checking Target sign-in status')

    // Wait a moment for page to load
    await page.waitForTimeout(1000)

    const isSignedIn = await isTargetSignedIn(page)

    if (!isSignedIn) {
      onStep('Not signed in - please sign in manually or use auto-login first')
      requiresManual = true
      await trace.capture(page)
      const traceResult = await trace.stop()
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath: traceResult?.screenshotPath,
        tracePath: traceResult?.tracePath,
        message: 'Not signed in - use Target auto-login feature first'
      }
    }

    onStep('Signed in to Target')

    // Add to cart via API (fast), then drive the browser UI for checkout.
    // The full-API checkout (set address/payment/place order) is intentionally not used:
    // Target's PUT /web_checkouts/v1/checkouts/* routes 401 for the in-page fetch (the
    // session lacks the required auth scope), so those steps always fell back to browser
    // anyway. A logged-in account already has its default address + payment applied at
    // checkout, so the browser UI just clicks through to the review page.
    if (useApi) {
      try {
        onStep(`Adding ${buyLimit} item(s) to cart via API...`)

        // Execute fetch API inside the browser context (has all cookies/auth)
        const result = await page.evaluate(
          async ({ tcin, quantity }) => {
            try {
              const response = await fetch('https://carts.target.com/web_checkouts/v1/cart_items', {
                method: 'POST',
                credentials: 'include', // Include cookies
                headers: {
                  'Content-Type': 'application/json',
                  'x-application-name': 'web'
                },
                body: JSON.stringify({
                  cart_type: 'REGULAR',
                  channel_id: '10',
                  shopping_context: 'DIGITAL',
                  cart_item: {
                    tcin: tcin,
                    quantity: quantity,
                    item_channel_id: '10'
                  }
                })
              })

              if (!response.ok) {
                const text = await response.text()
                return {
                  success: false,
                  error: `HTTP ${response.status}: ${text.substring(0, 100)}`
                }
              }

              const data = await response.json()
              return { success: true, cartId: data.cart_id, cartItem: data.cart_item }
            } catch (err) {
              return { success: false, error: err.message }
            }
          },
          { tcin, quantity: buyLimit }
        )

        if (result.success) {
          onStep('✓ Added to cart via API (lightning fast!)')
          log.info('Browser-based API add to cart successful', {
            tcin,
            quantity: buyLimit,
            cartId: result.cartId
          })

          // Item is in the cart; the checkout navigation below drives the rest.
        } else {
          onStep('API failed, using browser fallback')
          log.warn('Browser-based API failed, falling back to clicking', { error: result.error })
          await browserAddToCart(page, productUrl, buyLimit, onStep, notificationEngine, dropEvent)
        }
      } catch (err) {
        onStep('API error, using browser fallback')
        log.error('Browser-based API error', { error: err.message })
        await browserAddToCart(page, productUrl, buyLimit, onStep, notificationEngine, dropEvent)
      }
    } else {
      // Fallback to browser automation
      await browserAddToCart(page, productUrl, buyLimit, onStep, notificationEngine, dropEvent)
    }

    // Go straight to the checkout review page by URL instead of clicking the cart's
    // "Check out" button — the button click raced the React render and sometimes hit the
    // Apple Pay button by accident. Modern Target checkout is a single-page order review
    // (saved address + payment already shown), so we just wait for "Place your order".
    onStep('Opening Target checkout')
    await page.goto('https://www.target.com/checkout', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

    onStep('Waiting for order review page')
    const placeOrderBtn = page.locator(
      'button[data-test="placeOrderButton"], button:has-text("Place your order"), button:has-text("Place order")'
    )
    try {
      await placeOrderBtn.first().waitFor({ state: 'visible', timeout: 15000 })
    } catch {
      onStep('Order review page not reached - manual intervention required')
      requiresManual = true
      const traceResult = (await trace.stop()) || {}
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath: traceResult?.screenshotPath,
        tracePath: traceResult?.tracePath,
        message: 'Could not reach order review page - complete manually'
      }
    }

    // Enter CVV if the review page asks for it.
    const cvvInput = page.locator('input[id*="cvv"], input[name*="cvv"], input[placeholder*="CVV"]')
    if ((await cvvInput.count()) > 0 && cvv) {
      onStep('Entering CVV')
      await cvvInput.first().fill(cvv)
      await page.waitForTimeout(500)
    }

    if (isTestMode) {
      onStep('TEST MODE: on order review page - stopping before Place your order')
      requiresManual = true
      const traceResult = await trace.stop()
      return {
        success: true,
        testMode: true,
        requiresManualCheckout: true,
        screenshotPath: traceResult?.screenshotPath,
        tracePath: traceResult?.tracePath,
        message: 'Test checkout ready - review and place order manually'
      }
    }

    // Place order
    onStep('Placing order')
    await placeOrderBtn.first().click({ timeout: 10000 })
    await page.waitForLoadState('domcontentloaded')

    // Wait for confirmation
    onStep('Waiting for order confirmation')
    await page.waitForTimeout(5000)

    // Check for confirmation
    const confirmationIndicators = [
      'text="Order confirmed"',
      'text="Thank you"',
      'text="Order placed"',
      '[data-test="order-confirmation"]',
      'text="Your order is confirmed"'
    ]

    let confirmed = false
    for (const indicator of confirmationIndicators) {
      if ((await page.locator(indicator).count()) > 0) {
        confirmed = true
        break
      }
    }

    const { screenshotPath, tracePath } = (await trace.stop()) || {}

    if (confirmed) {
      onStep('Order confirmed!')
      return {
        success: true,
        testMode: false,
        requiresManualCheckout: false,
        screenshotPath,
        tracePath,
        message: 'Target order placed successfully'
      }
    } else {
      onStep('Order status unclear - check manually')
      return {
        success: false,
        requiresManualCheckout: true,
        screenshotPath,
        tracePath,
        message: 'Order may have been placed - verify manually'
      }
    }
  } catch (err) {
    onStep(`Error: ${err.message}`)
    const { screenshotPath, tracePath } = (await trace.stop()) || {}

    return {
      success: false,
      requiresManualCheckout: requiresManual,
      screenshotPath,
      tracePath,
      error: err.message,
      message: `Target checkout failed: ${err.message}`
    }
  }
}

/**
 * Determine whether the current Target session is signed in.
 *
 * DOM scraping alone is unreliable: header markup changes across Target's A/B variants,
 * the account link renders late, and `a[href*="/account"]` is present even when signed out.
 * The authoritative signal is Target's login cookies (`accessToken` / `idToken`), which are
 * set on `.target.com` only for an authenticated guest. We check the robust DOM indicators
 * first (fast path) and fall back to the auth cookies.
 */
async function isTargetSignedIn(page) {
  // Fast path: a clearly-signed-in header element.
  try {
    const signedInIndicators = page.locator(
      '[data-test="accountNav-signedIn"], [data-test="@web/AccountLink"][aria-label*="Hi,"], button:has-text("Hi,"), span:has-text("Hi,")'
    )
    if ((await signedInIndicators.count()) > 0) return true
  } catch {
    // Ignore and fall through to the cookie check.
  }

  // Authoritative fallback: Target's auth cookies are present only when logged in.
  try {
    const context = page.context?.()
    if (context && typeof context.cookies === 'function') {
      const cookies = await context.cookies('https://www.target.com')
      // accessToken / idToken are set on .target.com only for an authenticated guest.
      const hasLoginToken = cookies.some(
        (c) =>
          (c.name === 'accessToken' || c.name === 'idToken') &&
          typeof c.value === 'string' &&
          c.value.length > 20
      )
      if (hasLoginToken) return true
    }
  } catch {
    // Ignore — fall through to the explicit signed-out check.
  }

  // Last resort: if a "Sign in" affordance is visible, treat as signed out; otherwise
  // assume the cookie check above is correct.
  try {
    const signInButton = page.locator(
      '[data-test="@web/AccountLink"]:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Sign in")'
    )
    if ((await signInButton.count()) > 0) return false
  } catch {
    // Ignore.
  }

  return false
}

/**
 * Browser-based add to cart (fallback method)
 */
async function browserAddToCart(page, productUrl, buyLimit, onStep, notificationEngine, dropEvent) {
  // The fast path may have navigated us to the cart page (which has no Add to cart button),
  // and the API may have failed, so always ensure we're on the product page before clicking.
  if (productUrl && !page.url().includes('/p/')) {
    onStep('Opening Target product page (browser fallback)')
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  }

  // Handle quantity if buyLimit > 1

  if (buyLimit > 1) {
    onStep(`Setting quantity to ${buyLimit}`)
    const quantitySelect = page.locator('select[data-test="@web/QuantitySelector"]')
    if ((await quantitySelect.count()) > 0) {
      await quantitySelect.selectOption({ value: String(buyLimit) })
      await page.waitForTimeout(500)
    }
  }

  // Add to cart — check for disabled (OOS) button before attempting click
  onStep('Adding to cart (browser method)')
  const addToCartBtn = page.locator(
    'button[data-test="@web/AddToCartButton"], button[data-test="orderPickupButton"], button:has-text("Add to cart")'
  )

  // Wait briefly for the button to appear
  try {
    await addToCartBtn.first().waitFor({ state: 'attached', timeout: 10000 })
  } catch {
    throw new Error('Add to cart button not found on product page')
  }

  // If the button is disabled the item is out of stock — bail out cleanly
  const isDisabled = await addToCartBtn.first().isDisabled().catch(() => true)
  if (isDisabled) {
    throw new Error('Item is out of stock (Add to cart button is disabled)')
  }

  await addToCartBtn.first().click({ timeout: 15000 })
  await page.waitForTimeout(2000)
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  // Handle "View cart & check out" modal if it appears
  const viewCartBtn = page.locator('a[href="/cart"]:has-text("View cart")')
  if ((await viewCartBtn.count()) > 0) {
    onStep('Navigating to cart')
    await viewCartBtn.first().click()
    await page.waitForLoadState('domcontentloaded')
  }

  // Go to checkout
  onStep('Opening Target checkout')
  await page.goto('https://www.target.com/co-cart', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
}
