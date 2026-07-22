import { waitForCaptchaIfNeeded } from '../captcha.js'
import { startTrace } from '../TraceRecorder.js'
import { TargetApiClient } from '../api/targetApi.js'
import { startCheckoutDiagnostics } from '../CheckoutDiagnostics.js'
import { TargetPageCoordinator } from '../TargetPageCoordinator.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('TargetFlow')
const TARGET_CART_API_COOLDOWN_MS = 10 * 60 * 1000
let targetCartApiBlockedUntil = 0

const TARGET_LITE_BLOCKED_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.net',
  'pinterest.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com'
]

export async function runTargetFlow(
  context,
  {
    productUrl,
    cvv,
    cardNumber = null,
    cardLast4 = null,
    account,
    notificationEngine,
    dropEvent,
    mode,
    buyLimit = 1,
    useTargetCartApi = false,
    targetCheckoutLiteMode = false,
    onStep = () => {},
    onMilestone = () => {},
    browserPool = null, // [TARGET] Pass the BrowserPool instance
    accountId = null // [TARGET] Pass the account ID for Shape tracking
  }
) {
  const page = await context.newPage()
  const coordinator = await TargetPageCoordinator.attach(page)
  onStep('Target live page coordinator active')

  // [TARGET] Check Shape session health at start
  if (browserPool && accountId) {
    const hasShape = await browserPool.hasValidShapeSession(accountId)
    if (!hasShape) {
      log.warn('No Shape cookies found at start of Target flow', { accountId })
      onStep('⚠️ Shape session not initialized - waiting for cookies...')
      // Wait a moment for the refresh loop to establish cookies
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } else {
      log.info('Shape session verified at start', { accountId })
      onStep('✅ Shape session verified')
    }
  }

  if (targetCheckoutLiteMode) {
    await enableTargetCheckoutLiteMode(page)
    onStep('Target checkout lite mode enabled')
  }

  const trace = await startTrace(context, {
    retailer: 'target',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout'
  })
  const diagnostics = await startCheckoutDiagnostics(page, {
    retailer: 'target',
    accountName: account?.name,
    taskId: dropEvent?.productName || 'checkout',
    tracePath: trace.tracePath
  })
  const isTestMode = mode === 'test-checkout'
  let requiresManual = false
  let cartStrategyActual = 'not_reached'
  let cartFallbackReason = null
  let cartQuantityActual = null
  const withCartExecution = (result) => ({
    ...result,
    cartStrategyActual,
    cartFallbackReason,
    cartQuantityRequested: Math.max(1, Number(buyLimit) || 1),
    cartQuantityActual
  })

  try {
    // Extract TCIN from URL for API operations
    const tcin = TargetApiClient.extractTcin(productUrl)
    const useApi = tcin !== null && useTargetCartApi && !isTargetCartApiCoolingDown()

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
      onStep(
        tcin && !useTargetCartApi
          ? 'Target cart API is off - opening the product page directly'
          : tcin
            ? 'Target cart API is cooling down - opening the product page directly'
            : 'Opening Target product page'
      )
      if (tcin) {
        log.info('Using browser-first Target add to cart', {
          tcin,
          reason: useTargetCartApi ? 'api-cooldown' : 'api-disabled',
          blockedUntil: targetCartApiBlockedUntil
            ? new Date(targetCartApiBlockedUntil).toISOString()
            : null
        })
      } else {
        log.warn('Could not extract TCIN, falling back to browser automation')
      }
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }

    // [TARGET] Wait for Shape cookies after navigation
    if (browserPool && accountId) {
      await ensureShapeSession(page, browserPool, accountId, onStep)
    }

    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    onMilestone('product_opened', useApi ? 'Target cart origin loaded' : 'Target product loaded')

    // Check if signed in by looking for account indicator
    onStep('Checking Target sign-in status')

    const isSignedIn = await isTargetSignedIn(page)

    if (!isSignedIn) {
      onStep('Not signed in - please sign in manually or use auto-login first')
      requiresManual = true
      const diagnosticsPath = await diagnostics.capture(new Error('Target account is signed out'), {
        stage: 'sign-in-check'
      })
      await trace.capture(page)
      const traceResult = await trace.stop()
      return withCartExecution({
        success: false,
        requiresManualCheckout: true,
        screenshotPath: traceResult?.screenshotPath,
        tracePath: traceResult?.tracePath,
        diagnosticsPath,
        message: 'Not signed in - use Target auto-login feature first'
      })
    }

    onStep('Signed in to Target')
    onMilestone('session_checked', 'Target session verified')

    if (useApi) {
      cartStrategyActual = 'api_attempted'
    } else if (useTargetCartApi) {
      cartStrategyActual = 'browser_fallback'
      cartFallbackReason = tcin === null ? 'missing_product_id' : 'api_cooldown'
    } else {
      cartStrategyActual = 'browser'
    }

    // Add to cart via API (fast), then drive the browser UI for checkout.
    // The full-API checkout (set address/payment/place order) is intentionally not used:
    // Target's PUT /web_checkouts/v1/checkouts/* routes 401 for the in-page fetch (the
    // session lacks the required auth scope), so those steps always fell back to browser
    // anyway. A logged-in account already has its default address + payment applied at
    // checkout, so the browser UI just clicks through to the review page.
    if (useApi) {
      try {
        onStep(`Adding ${buyLimit} item(s) to cart via API...`)
        onMilestone('cart_attempted', `Target cart API requested quantity ${buyLimit}`)

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
          cartStrategyActual = 'api'
          onStep('✓ Added to cart via API (lightning fast!)')
          log.info('Browser-based API add to cart successful', {
            tcin,
            quantity: buyLimit,
            cartId: result.cartId
          })

          // Item is in the cart; the checkout navigation below drives the rest.
        } else if (isCartAlreadyAtPurchaseLimit(result.error)) {
          // A stale purchase-limit response is possible during a drop. Verify the
          // requested TCIN before treating it as a usable checkout state.
          onStep('Target reports the purchase limit - verifying the requested item')
          if (await targetCartContainsTcin(page, tcin)) {
            cartStrategyActual = 'existing_cart'
            cartFallbackReason = 'purchase_limit_cart_present'
            log.info('Target cart already contains the purchase-limit quantity', {
              tcin,
              quantity: buyLimit
            })
          } else {
            cartStrategyActual = 'browser_fallback'
            cartFallbackReason = 'purchase_limit_item_missing'
            onStep('Requested item is not in cart - trying the product page instead')
            await browserAddToCart(
              page,
              productUrl,
              buyLimit,
              onStep,
              notificationEngine,
              dropEvent,
              coordinator,
              onMilestone,
              browserPool,
              accountId // [TARGET] Pass accountId for Shape monitoring
            )
          }
        } else if (isTargetHighTrafficError(result.error)) {
          markTargetCartApiRateLimited()
          // A 429 does not prove this requested item was added. An older high-demand
          // item may still be in the cart, so verify the TCIN before opening checkout.
          onStep('Target is rate limiting cart requests - verifying the requested item')
          if (await targetCartContainsTcin(page, tcin)) {
            cartStrategyActual = 'existing_cart'
            cartFallbackReason = 'api_rate_limited_cart_present'
            log.warn('Target cart API rate limited; requested item is already in cart', {
              tcin,
              error: result.error
            })
          } else {
            cartStrategyActual = 'browser_fallback'
            cartFallbackReason = 'api_rate_limited'
            onStep('Requested item is not in cart - trying the product page instead')
            log.warn('Target cart API rate limited and requested item is absent', {
              tcin,
              error: result.error
            })
            await browserAddToCart(
              page,
              productUrl,
              buyLimit,
              onStep,
              notificationEngine,
              dropEvent,
              coordinator,
              onMilestone,
              browserPool,
              accountId
            )
          }
        } else {
          cartStrategyActual = 'browser_fallback'
          cartFallbackReason = 'api_error'
          onStep('API failed, using browser fallback')
          log.warn('Browser-based API failed, falling back to clicking', { error: result.error })
          await browserAddToCart(
            page,
            productUrl,
            buyLimit,
            onStep,
            notificationEngine,
            dropEvent,
            coordinator,
            onMilestone,
            browserPool,
            accountId
          )
        }
      } catch (err) {
        // Browser fallback errors also arrive here. Retrying the same fallback
        // wastes scarce inventory and can act on a stale duplicate button.
        log.error('Target add-to-cart attempt failed', { error: err.message })
        throw err
      }
    } else {
      // Fallback to browser automation
      await browserAddToCart(
        page,
        productUrl,
        buyLimit,
        onStep,
        notificationEngine,
        dropEvent,
        coordinator,
        onMilestone,
        browserPool,
        accountId
      )
    }

    // Treat the requested TCIN appearing in the cart as the commit point. A click,
    // toast or HTTP 2xx alone can be stale during a drop and must not start checkout.
    if (tcin) {
      onStep('Confirming the requested item is in the cart')
      const cartState = await confirmRequestedTargetCartItem(page, tcin, {
        notificationEngine,
        dropEvent,
        coordinator
      })
      if (!cartState?.present) {
        throw new Error('Target did not confirm the requested item in the cart')
      }
      if (!Number.isInteger(cartState.quantity) || cartState.quantity < 1) {
        throw new Error('Target cart quantity could not be verified for the requested item')
      }
      cartQuantityActual = cartState.quantity
      const requestedQuantity = Math.max(1, Number(buyLimit) || 1)
      if (cartQuantityActual > requestedQuantity) {
        throw new Error(
          `Target cart quantity ${cartQuantityActual} exceeds requested maximum ${requestedQuantity}`
        )
      }
      onStep(
        cartQuantityActual < requestedQuantity
          ? `Target limited the cart to ${cartQuantityActual}; continuing with the permitted quantity`
          : `Requested item confirmed in cart with quantity ${cartQuantityActual}`
      )
      onMilestone('cart_ready', `Requested TCIN verified at quantity ${cartQuantityActual}`)
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

    // [TARGET] Ensure Shape session is healthy before checkout
    if (browserPool && accountId) {
      await ensureShapeSession(page, browserPool, accountId, onStep)
    }

    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
    onMilestone('checkout_opened', 'Target checkout loaded')

    onStep('Waiting for order review page')
    const placeOrderBtn = await waitForTargetOrderReview(page, {
      cvv,
      cardNumber,
      cardLast4,
      onStep,
      notificationEngine,
      dropEvent,
      coordinator
    })
    if (!placeOrderBtn) {
      onStep('Order review page not reached - manual intervention required')
      requiresManual = true
      const diagnosticsPath = await diagnostics.capture(
        new Error('Target order review controls were not found'),
        { stage: 'order-review', failedSelector: PLACE_ORDER_SELECTOR }
      )
      await trace.capture(page)
      const traceResult = (await trace.stop()) || {}
      return withCartExecution({
        success: false,
        requiresManualCheckout: true,
        screenshotPath: traceResult?.screenshotPath,
        tracePath: traceResult?.tracePath,
        diagnosticsPath,
        message: 'Could not reach order review page - complete manually'
      })
    }
    onMilestone('checkout_ready', 'Target order review controls ready')

    if (isTestMode) {
      onStep('TEST MODE: on order review page - stopping before Place your order')
      requiresManual = true
      const traceResult = await trace.stop()
      return withCartExecution({
        success: true,
        testMode: true,
        requiresManualCheckout: true,
        screenshotPath: traceResult?.screenshotPath,
        tracePath: traceResult?.tracePath,
        message: 'Test checkout ready - review and place order manually'
      })
    }

    // Target can accept the click and then reject the checkout with a temporary
    // high-demand/busy modal. Keep the same cart and retry only after confirming
    // that no order confirmation was produced.
    const confirmed = await submitTargetOrder(page, placeOrderBtn, {
      cvv,
      cardNumber,
      cardLast4,
      onStep,
      notificationEngine,
      dropEvent,
      coordinator,
      onMilestone,
      browserPool, // [TARGET] Pass for Shape monitoring during retries
      accountId
    })

    const { screenshotPath, tracePath } = (await trace.stop()) || {}

    if (confirmed) {
      onStep('Order confirmed!')
      onMilestone('confirmed', 'Target order confirmation detected')
      return withCartExecution({
        success: true,
        testMode: false,
        requiresManualCheckout: false,
        screenshotPath,
        tracePath,
        message: 'Target order placed successfully'
      })
    } else {
      onStep('Order status unclear - check manually')
      requiresManual = true
      return withCartExecution({
        success: false,
        requiresManualCheckout: true,
        screenshotPath,
        tracePath,
        message: 'Order may have been placed - verify manually'
      })
    }
  } catch (err) {
    onStep(`Error: ${err.message}`)
    log.error('Target checkout flow failed', {
      error: err.message,
      url: page?.url?.() || null
    })
    const diagnosticsPath = await diagnostics.capture(err, { stage: 'checkout-flow' })
    await trace.capture(page)
    const { screenshotPath, tracePath } = (await trace.stop()) || {}

    return withCartExecution({
      success: false,
      requiresManualCheckout: requiresManual,
      screenshotPath,
      tracePath,
      diagnosticsPath,
      error: err.message,
      message: `Target checkout failed: ${err.message}`
    })
  } finally {
    diagnostics.dispose()
    if (!requiresManual) {
      await page.close().catch(() => {})
    }
  }
}

// [TARGET] New helper function to ensure Shape session is healthy
async function ensureShapeSession(page, browserPool, accountId, onStep) {
  const hasShape = await browserPool.hasValidShapeSession(accountId)
  if (!hasShape) {
    onStep('⚠️ Shape session missing - refreshing...')
    log.warn('Shape session missing, attempting refresh', { accountId })

    // Trigger a manual refresh by navigating to Target
    try {
      await page.goto('https://www.target.com', { waitUntil: 'networkidle', timeout: 15000 })
      // Wait a moment for cookies to be set
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Check again
      const hasShapeNow = await browserPool.hasValidShapeSession(accountId)
      if (hasShapeNow) {
        onStep('✅ Shape session restored')
        log.info('Shape session restored after manual refresh', { accountId })
      } else {
        onStep('⚠️ Shape session still missing - continuing with caution')
        log.warn('Shape session still missing after manual refresh', { accountId })
      }
    } catch (err) {
      log.warn('Failed to refresh Shape session manually', { accountId, error: err.message })
    }
  } else {
    onStep('✅ Shape session healthy')
  }
}

const PLACE_ORDER_SELECTOR =
  'button[data-test="placeOrderButton"], button:has-text("Place your order"), button:has-text("Place order")'

const HIGH_DEMAND_DIALOG_SELECTOR =
  '[role="dialog"]:has-text("High-demand item in your cart"), [role="dialog"]:has-text("popular item in your cart is causing a delay"), [role="dialog"]:has-text("little busier than we expected"), [role="dialog"]:has-text("temporary issue"), [role="dialog"]:has-text("high demand")'

const RETRYABLE_ORDER_ERROR_SELECTOR =
  '[role="dialog"]:has-text("could not complete your order"), [role="dialog"]:has-text("couldn\'t complete your order"), [role="dialog"]:has-text("unable to place your order"), [role="dialog"]:has-text("problem placing your order"), [role="dialog"]:has-text("something went wrong"), [role="alert"]:has-text("could not complete your order")'

const SAVE_AND_CONTINUE_SELECTOR =
  'button:visible:has-text("Save and continue"), button:visible:has-text("Save & continue"), button:visible:has-text("Continue to review"), button:visible:has-text("Review order"), button[data-test*="save"]:visible:has-text("Continue")'

const CVV_SELECTOR =
  'input#enter-cvv:visible, input[id*="cvv" i]:visible, input[name*="cvv" i]:visible, input[name*="cvc" i]:visible, input[autocomplete="cc-csc"]:visible, input[placeholder*="CVV" i]:visible, input[placeholder*="security code" i]:visible, input[aria-label*="security code" i]:visible'

const CARD_VERIFICATION_SELECTOR =
  'input#credit-card-number-input:visible, input[autocomplete="cc-number"]:visible, input[name*="cardNumber" i]:visible, input[id*="card-number" i]:visible, input[aria-label*="card number" i]:visible'

const TERMS_CHECKBOX_SELECTOR =
  'input[type="checkbox"][name*="terms"]:visible, input[type="checkbox"][id*="terms"]:visible, input[type="checkbox"][data-test*="terms"]:visible'

const CHECKOUT_DIALOG_SELECTOR = `${HIGH_DEMAND_DIALOG_SELECTOR}, ${RETRYABLE_ORDER_ERROR_SELECTOR}`

const EMPTY_CART_SELECTOR = 'text="Your cart is empty", [data-test="empty-cart"]'

const CONFIRMATION_SELECTORS = [
  'text="Order confirmed"',
  'text="Thank you"',
  'text="Order placed"',
  '[data-test="order-confirmation"]',
  'text="Your order is confirmed"'
]

export async function submitTargetOrder(
  page,
  initialPlaceOrderBtn,
  {
    cvv,
    cardNumber = null,
    cardLast4 = null,
    onStep,
    notificationEngine,
    dropEvent,
    coordinator = null,
    onMilestone = () => {},
    maxSubmitRetries = 30,
    browserPool = null, // [TARGET] Added for Shape monitoring
    accountId = null
  }
) {
  let placeOrderBtn = initialPlaceOrderBtn
  let reloadFallbacks = 0

  for (let attempt = 0; attempt <= maxSubmitRetries; attempt += 1) {
    // [TARGET] Check Shape session health before each retry
    if (browserPool && accountId && attempt > 0 && attempt % 3 === 0) {
      const hasShape = await browserPool.hasValidShapeSession(accountId)
      if (!hasShape) {
        onStep('⚠️ Shape session degraded - refreshing before retry')
        log.warn('Shape session degraded during submit retries', { accountId, attempt })
        // Try to refresh the session
        await page
          .goto('https://www.target.com', { waitUntil: 'networkidle', timeout: 10000 })
          .catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    const reviewState = await prepareTargetOrderReview(page, {
      cvv,
      cardNumber,
      cardLast4,
      onStep
    })
    if (reviewState === 'manual-verification') {
      onStep('Target requires full card verification - assign a payment method to this account')
      return false
    }
    placeOrderBtn = page.locator(PLACE_ORDER_SELECTOR).first()
    const placeOrderReady =
      (await placeOrderBtn.isVisible().catch(() => false)) &&
      !(await placeOrderBtn.isDisabled().catch(() => true))
    if (!placeOrderReady) {
      onStep('Place your order is not ready - preserving checkout for manual review')
      return false
    }
    onStep(
      attempt === 0 ? 'Placing order' : `Retrying Place your order (${attempt}/${maxSubmitRetries})`
    )
    log.info('Submitting Target order', { attempt: attempt + 1, maxAttempts: maxSubmitRetries + 1 })
    if (!(await claimTargetAction(coordinator, `place-order:${attempt}`, 1500))) {
      await coordinator.waitForChange(0, 250)
      continue
    }
    onMilestone(
      'order_submitted',
      attempt === 0 ? 'Target Place your order clicked' : `Target order retry ${attempt} clicked`
    )
    await placeOrderBtn.first().click({ timeout: 10000 })

    onStep('Waiting for order confirmation')
    const outcome = await waitForTargetSubmitOutcome(page, 10000, { cardNumber, coordinator })
    if (outcome === 'confirmed') return true
    if (outcome === 'manual-verification') {
      onStep('Target requires full card verification - manual action needed')
      return false
    }
    if (outcome === 'verification') {
      onStep('Target requested payment verification after submit')
      await prepareTargetOrderReview(page, { cvv, cardNumber, cardLast4, onStep })
    } else if (outcome !== 'retryable-error') {
      return false
    }

    log.warn('Target rejected Place your order with a retryable checkout response', {
      attempt: attempt + 1,
      maxRetries: maxSubmitRetries,
      outcome
    })
    if (outcome === 'retryable-error') {
      onStep(
        `Target rejected checkout - clearing the message (retry ${attempt + 1}/${maxSubmitRetries})`
      )
      await dismissTargetCheckoutDialog(page)
    }

    // Never submit again after an ambiguous response. Retry only when Target has
    // explicitly rejected the order or has requested payment verification.
    if (await isTargetOrderConfirmed(page)) return true
    if (attempt === maxSubmitRetries) break

    const delayMs = Math.min(1500 + attempt * 750, 6000)
    onStep(`Waiting ${Math.round(delayMs / 1000)}s before retrying Place your order`)
    await page.waitForTimeout(delayMs)

    // Prefer the extension-style in-place recovery path. Reloading checkout on every
    // rejection throws away useful React state and is slower during scarce inventory.
    placeOrderBtn = await recoverTargetFinalSubmitInPlace(page, {
      cvv,
      cardNumber,
      cardLast4,
      onStep,
      coordinator
    })
    if (await isTargetOrderConfirmed(page)) return true
    if (!placeOrderBtn && reloadFallbacks < 2) {
      reloadFallbacks += 1
      onStep(`Checkout controls are still stalled - reloading (${reloadFallbacks}/2)`)
      await retryTargetCheckoutNavigation(page)
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      placeOrderBtn = await waitForTargetOrderReview(page, {
        cvv,
        cardNumber,
        cardLast4,
        onStep,
        notificationEngine,
        dropEvent,
        coordinator,
        maxHighDemandRetries: 3
      })
    }
    if (!placeOrderBtn) return false
  }

  return false
}

async function waitForTargetSubmitOutcome(
  page,
  timeoutMs,
  { cardNumber = null, coordinator = null } = {}
) {
  const deadline = Date.now() + timeoutMs
  const retryableDialog = page.locator(CHECKOUT_DIALOG_SELECTOR).first()

  while (Date.now() < deadline) {
    if (await isTargetOrderConfirmed(page)) return 'confirmed'
    if (await retryableDialog.isVisible().catch(() => false)) return 'retryable-error'
    if (await isTargetCardVerificationVisible(page)) {
      return cardNumber ? 'verification' : 'manual-verification'
    }
    if (await isTargetPaymentVerificationVisible(page)) return 'verification'
    const snapshot = await coordinator?.signalState()
    await waitForTargetSignal(page, coordinator, snapshot, 250)
  }

  return (await isTargetOrderConfirmed(page)) ? 'confirmed' : 'timeout'
}

async function isTargetOrderConfirmed(page) {
  if (/order-confirmation|order-details/i.test(page.url?.() || '')) return true
  for (const selector of CONFIRMATION_SELECTORS) {
    if (
      (await page
        .locator(selector)
        .count()
        .catch(() => 0)) > 0
    )
      return true
  }
  return false
}

async function findVisibleTargetField(page, selector) {
  const roots = typeof page.frames === 'function' ? page.frames() : [page]
  for (const root of roots) {
    const input = root.locator(selector).first()
    if (await input.isVisible().catch(() => false)) return input
  }
  return null
}

async function fillTargetCvv(page, cvv, onStep) {
  if (!cvv) return
  const input = await findVisibleTargetField(page, CVV_SELECTOR)
  if (!input) return
  onStep('Entering CVV')
  await fillTargetPaymentField(input, String(cvv).replace(/\D/g, ''))
  await page.waitForTimeout(150)
}

async function fillTargetPaymentField(input, value) {
  await input.fill(value)
  if (typeof input.inputValue !== 'function') return

  const current = await input.inputValue().catch(() => '')
  if (String(current).replace(/\D/g, '') === value) return

  // Some secure payment inputs ignore a synthetic fill but accept normal key
  // events. Use this only as a fallback and verify the final value again.
  await input.click().catch(() => {})
  await input.press('Control+A').catch(() => {})
  if (typeof input.pressSequentially === 'function') {
    await input.pressSequentially(value, { delay: 15 })
  } else {
    await input.fill(value)
  }
  const retried = await input.inputValue().catch(() => '')
  if (String(retried).replace(/\D/g, '') !== value) {
    throw new Error('Target payment verification field did not retain its value')
  }
}

export async function fillTargetCardVerification(page, cardNumber, onStep = () => {}) {
  const normalizedCardNumber = String(cardNumber || '').replace(/\D/g, '')
  if (!normalizedCardNumber) return false

  const input = await findVisibleTargetField(page, CARD_VERIFICATION_SELECTOR)
  if (!input) return false

  onStep('Entering full card number for Target verification')
  await fillTargetPaymentField(input, normalizedCardNumber)
  await page.waitForTimeout(150)
  return true
}

async function dismissTargetCheckoutDialog(page) {
  const dialog = page.locator(CHECKOUT_DIALOG_SELECTOR).first()
  const closeButton = dialog
    .locator(
      'button:has-text("Ok"), button:has-text("Try again"), button:has-text("Continue"), button[aria-label="close" i], button:has-text("Close")'
    )
    .first()
  await closeButton.click({ timeout: 5000 }).catch(() => {})
}

async function isTargetPaymentVerificationVisible(page) {
  return Boolean(await findVisibleTargetField(page, CVV_SELECTOR))
}

async function isTargetCardVerificationVisible(page) {
  return Boolean(await findVisibleTargetField(page, CARD_VERIFICATION_SELECTOR))
}

async function selectTargetSavedCard(page, cardLast4, onStep) {
  const last4 = String(cardLast4 || '')
    .replace(/\D/g, '')
    .slice(-4)
  if (last4.length !== 4) return false

  const selector = [
    `[data-test*="payment" i]:has-text("${last4}")`,
    `[data-test*="card" i]:has-text("${last4}")`,
    `[role="radio"]:has-text("${last4}")`,
    `label:has-text("${last4}")`
  ].join(', ')
  const roots = typeof page.frames === 'function' ? page.frames() : [page]
  for (const root of roots) {
    const option = root.locator(selector).first()
    if (!(await option.isVisible().catch(() => false))) continue

    const radio = option.locator('input[type="radio"]').first()
    const radioVisible = await radio.isVisible().catch(() => false)
    const checked = radioVisible
      ? await radio.isChecked().catch(() => false)
      : (await option.getAttribute('aria-checked').catch(() => null)) === 'true'
    if (!checked) {
      onStep(`Selecting saved Target card ending in ${last4}`)
      if (radioVisible) await radio.check({ force: true }).catch(() => option.click())
      else await option.click().catch(() => {})
      await page.waitForTimeout(200)
    }
    return true
  }
  return false
}

export async function prepareTargetOrderReview(
  page,
  { cvv, cardNumber = null, cardLast4 = null, onStep }
) {
  await selectTargetSavedCard(page, cardLast4, onStep)
  if (await isTargetCardVerificationVisible(page)) {
    if (!cardNumber) return 'manual-verification'
    await fillTargetCardVerification(page, cardNumber, onStep)
  }
  await fillTargetCvv(page, cvv, onStep)

  const terms = page.locator(TERMS_CHECKBOX_SELECTOR).first()
  if (await terms.isVisible().catch(() => false)) {
    const checked = await terms.isChecked().catch(() => false)
    if (!checked) {
      onStep('Accepting Target checkout terms')
      await terms.check({ force: true }).catch(async () => terms.click({ force: true }))
    }
  }

  const continueButton = page.locator(SAVE_AND_CONTINUE_SELECTOR).first()
  if (await continueButton.isVisible().catch(() => false)) {
    const disabled = await continueButton.isDisabled().catch(() => false)
    if (!disabled) {
      onStep('Saving payment verification and continuing')
      await continueButton.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(250)
    }
  }

  return 'ready'
}

async function recoverTargetFinalSubmitInPlace(
  page,
  { cvv, cardNumber = null, cardLast4 = null, onStep, coordinator = null }
) {
  await prepareTargetOrderReview(page, { cvv, cardNumber, cardLast4, onStep })
  const placeOrderBtn = page.locator(PLACE_ORDER_SELECTOR).first()
  const deadline = Date.now() + 5000

  while (Date.now() < deadline) {
    if (await isTargetOrderConfirmed(page)) return null
    const visible = await placeOrderBtn.isVisible().catch(() => false)
    const disabled = visible && (await placeOrderBtn.isDisabled().catch(() => false))
    if (visible && !disabled) return placeOrderBtn
    const snapshot = await coordinator?.signalState()
    await waitForTargetSignal(page, coordinator, snapshot, 500)
  }

  return null
}

function isCartAlreadyAtPurchaseLimit(error) {
  return /MAX_PURCHASE_LIMIT|max purchase limit exceeded/i.test(String(error || ''))
}

function isTargetHighTrafficError(error) {
  return /HTTP 429|DCO_RATE_LIMITED|rate limited|request throttled/i.test(String(error || ''))
}

export function markTargetCartApiRateLimited(now = Date.now()) {
  targetCartApiBlockedUntil = Math.max(
    targetCartApiBlockedUntil,
    Number(now) + TARGET_CART_API_COOLDOWN_MS
  )
}

export function isTargetCartApiCoolingDown(now = Date.now()) {
  return Number(now) < targetCartApiBlockedUntil
}

export async function enableTargetCheckoutLiteMode(page) {
  if (typeof page?.route !== 'function') return

  await page.route('**/*', async (route) => {
    const request = route.request()
    const resourceType = request.resourceType()

    if (resourceType === 'media' || resourceType === 'font') {
      await route.abort().catch(() => {})
      return
    }

    let hostname = ''
    try {
      hostname = new URL(request.url()).hostname.toLowerCase()
    } catch {
      // A malformed/non-network URL should continue normally.
    }

    if (
      TARGET_LITE_BLOCKED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    ) {
      await route.abort().catch(() => {})
      return
    }

    await route.continue().catch(() => {})
  })

  log.info('Target checkout lite mode enabled', {
    blocks: ['media', 'font', 'known-third-party-ads']
  })
}

/**
 * Wait for Target's checkout review page while actively handling the high-demand gate.
 * Target renders the gate as a modal with an "Ok" button and leaves the checkout page
 * inert behind it. Keep the existing page, cart, and traffic-gate session alive while
 * waiting; reloading here can put the browser straight back into the same gate.
 */
export async function waitForTargetOrderReview(
  page,
  {
    cvv = null,
    cardNumber = null,
    cardLast4 = null,
    onStep,
    notificationEngine,
    dropEvent,
    coordinator = null,
    maxHighDemandRetries = 30
  }
) {
  const placeOrderBtn = page.locator(PLACE_ORDER_SELECTOR).first()

  for (let attempt = 0; attempt <= maxHighDemandRetries; attempt += 1) {
    const reviewState = await prepareTargetOrderReview(page, {
      cvv,
      cardNumber,
      cardLast4,
      onStep
    })
    if (reviewState === 'manual-verification') return null
    const state = await waitForCheckoutState(page, placeOrderBtn, 15000, coordinator)
    if (state === 'review') return placeOrderBtn
    if (state === 'empty') {
      onStep('Requested item is no longer in the cart')
      log.warn('Target checkout cart became empty before order review')
      return null
    }
    if (state !== 'high-demand') return null

    onStep(
      `Target high-demand delay detected - holding checkout in place (${attempt + 1}/${maxHighDemandRetries})`
    )
    log.warn('Target high-demand checkout dialog detected', {
      attempt: attempt + 1,
      maxRetries: maxHighDemandRetries
    })

    // Dismiss only the modal. Do not reload or navigate: Target's gate is tied
    // to this warm page/session and repeated navigation can restart its delay.
    await dismissTargetCheckoutDialog(page)

    if (attempt === maxHighDemandRetries) break

    const delayMs = Math.min(3000 + attempt * 2000, 15000)
    onStep(`Waiting ${Math.round(delayMs / 1000)}s on the current Target checkout page`)
    await page.waitForTimeout(delayMs)
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  }

  return null
}

async function retryTargetCheckoutNavigation(page) {
  try {
    // We are already on /checkout here. Reloading avoids starting a second route
    // transition while Target's checkout app is navigating after the dialog closes.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch (err) {
    // Target commonly aborts our reload because its own SPA navigation wins the race.
    // The page remains usable, so this is not a checkout failure.
    if (!/ERR_ABORTED/i.test(String(err?.message || ''))) throw err
    log.info('Target checkout reload was superseded by Target navigation; continuing')
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
  }
}

async function waitForCheckoutState(page, placeOrderBtn, timeoutMs, coordinator = null) {
  const deadline = Date.now() + timeoutMs
  const highDemandDialog = page.locator(CHECKOUT_DIALOG_SELECTOR).first()
  const emptyCart = page.locator(EMPTY_CART_SELECTOR).first()

  while (Date.now() < deadline) {
    if (await placeOrderBtn.isVisible().catch(() => false)) {
      const disabled = await placeOrderBtn.isDisabled().catch(() => true)
      if (!disabled) return 'review'
    }
    if (await highDemandDialog.isVisible().catch(() => false)) return 'high-demand'
    if (await emptyCart.isVisible().catch(() => false)) return 'empty'
    const snapshot = await coordinator?.signalState()
    await waitForTargetSignal(page, coordinator, snapshot, 3000)
  }

  return 'timeout'
}

async function targetCartContainsTcin(page, tcin) {
  return (await readTargetCartItemState(page, tcin)).present
}

/**
 * Read quantity from the cart row that contains the requested TCIN. A global cart
 * badge is deliberately ignored because another item can make that badge non-zero.
 */
export async function readTargetCartItemState(page, tcin) {
  const tcinText = String(tcin || '').trim()
  if (!tcinText) return { present: false, quantity: null, source: 'missing-tcin' }

  const domState = await page
    .evaluate((requestedTcin) => {
      const parseQuantity = (value) => {
        const text = String(value ?? '').trim()
        if (!text) return null
        const exact = text.match(/^\s*(\d{1,2})\s*$/)
        const labeled = text.match(
          /(?:qty|quantity)\s*[:-]?\s*(\d{1,2})\b|\b(\d{1,2})\s+(?:item(?:s)?\s+)?in\s+(?:your\s+)?cart\b/i
        )
        const quantity = Number(exact?.[1] || labeled?.[1] || labeled?.[2])
        return Number.isInteger(quantity) && quantity > 0 ? quantity : null
      }
      const visible = (element) => {
        if (!(element instanceof Element)) return false
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        )
      }
      const matches = [
        ...document.querySelectorAll(
          `a[href*="${CSS.escape(requestedTcin)}"], [data-tcin="${CSS.escape(requestedTcin)}"]`
        )
      ]
      const productElement = matches.find(visible) || matches[0]
      if (!productElement) return { present: false, quantity: null, source: 'dom' }

      const rowSelectors = [
        '[data-test*="cartItem"]',
        '[data-test*="cart-item"]',
        '[data-test*="CartItem"]',
        'article',
        'li'
      ]
      const row = productElement.closest(rowSelectors.join(',')) || productElement.parentElement
      if (!row) return { present: true, quantity: null, source: 'product-link' }

      const controls = row.querySelectorAll(
        'select[data-test*="Quantity"], select[aria-label*="quantity" i], input[aria-label*="quantity" i], input[name*="quantity" i], [role="combobox"][aria-label*="quantity" i], button[aria-label*="quantity" i]'
      )
      for (const control of controls) {
        const raw =
          control.value ||
          control.getAttribute('aria-valuenow') ||
          control.getAttribute('data-value') ||
          control.getAttribute('aria-label') ||
          control.textContent
        const quantity = parseQuantity(raw)
        if (quantity !== null) return { present: true, quantity, source: 'item-control' }
      }

      const quantity = parseQuantity(row.innerText || row.textContent || '')
      return {
        present: true,
        quantity,
        source: quantity === null ? 'product-row' : 'item-row-text'
      }
    }, tcinText)
    .catch(() => null)

  if (domState?.present) return domState

  // Target occasionally hydrates the cart from serialized state before rendering
  // a row. Only accept a quantity when it appears close to the requested TCIN.
  const html = await page.content().catch(() => '')
  const index = html.indexOf(tcinText)
  if (index < 0) return { present: false, quantity: null, source: 'none' }
  const nearby = html.slice(Math.max(0, index - 1200), index + tcinText.length + 1200)
  const serializedMatch = nearby.match(
    /["'](?:quantity|item_quantity|cart_quantity)["']\s*:\s*["']?(\d{1,2})/i
  )
  return {
    present: true,
    quantity: serializedMatch ? Number(serializedMatch[1]) : null,
    source: serializedMatch ? 'serialized-item-state' : 'serialized-tcin'
  }
}

export function parseTargetCartQuantity(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const exact = text.match(/^\s*(\d{1,2})\s*$/)
  const labeled = text.match(
    /(?:qty|quantity)\s*[:-]?\s*(\d{1,2})\b|\b(\d{1,2})\s+(?:item(?:s)?\s+)?in\s+(?:your\s+)?cart\b/i
  )
  const quantity = Number(exact?.[1] || labeled?.[1] || labeled?.[2])
  return Number.isInteger(quantity) && quantity > 0 ? quantity : null
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
async function browserAddToCart(
  page,
  productUrl,
  buyLimit,
  onStep,
  notificationEngine,
  dropEvent,
  coordinator = null,
  onMilestone = () => {},
  browserPool = null, // [TARGET] Added
  accountId = null // [TARGET] Added
) {
  void browserPool
  void accountId

  // The fast path may have navigated us to the cart page (which has no Add to cart button),
  // and the API may have failed, so always ensure we're on the product page before clicking.
  if (productUrl && !page.url().includes('/p/')) {
    onStep('Opening Target product page (browser fallback)')
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  }

  // Handle quantity if buyLimit > 1

  onStep('Waiting for Target fulfillment to finish loading')
  let addToCartBtn = await waitForTargetAddToCartReady(page, {
    onStep,
    notificationEngine,
    dropEvent,
    coordinator
  })
  onMilestone('availability_ready', 'Target fulfillment and Add to cart controls ready')

  // Target often renders quantity only after fulfillment settles. Selecting it
  // before hydration silently did nothing during live drops.
  if (buyLimit > 1) {
    onStep(`Setting quantity to ${buyLimit}`)
    const quantitySelect = page.locator('select[data-test="@web/QuantitySelector"]')
    if ((await quantitySelect.count()) > 0) {
      await quantitySelect.selectOption({ value: String(buyLimit) })
      await page.waitForTimeout(250)
      addToCartBtn = await waitForTargetAddToCartReady(page, {
        onStep,
        notificationEngine,
        dropEvent,
        coordinator,
        timeoutMs: 3000
      })
    }
  }

  onStep('Adding to cart (browser method)')
  onMilestone('cart_attempted', `Target browser cart requested quantity ${buyLimit}`)

  if (!(await claimTargetAction(coordinator, 'add-to-cart', 1500))) {
    throw new Error('Target Add to cart action is already in progress')
  }
  await addToCartBtn.click({ timeout: 5000 })
  await page.waitForTimeout(100)
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  // Handle "View cart & check out" modal if it appears
  const viewCartBtn = page.locator('a[href="/cart"]:has-text("View cart")')
  if ((await viewCartBtn.count()) > 0) {
    onStep('Navigating to cart')
    await viewCartBtn.first().click()
    await page.waitForLoadState('domcontentloaded')
  }

  // Go to checkout
  onStep('Opening Target cart')
  await page.goto('https://www.target.com/co-cart', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)

  const tcin = TargetApiClient.extractTcin(productUrl)
  if (tcin && !(await waitForTargetCartTcin(page, tcin, 5000, coordinator))) {
    throw new Error('Add to cart click did not put the requested item in the cart')
  }
}

export function getVisibleTargetAddToCartButton(page) {
  return page
    .locator(
      'button[data-test="@web/AddToCartButton"]:visible, button[data-test="orderPickupButton"]:visible, button:visible:has-text("Add to cart")'
    )
    .first()
}

export async function waitForTargetAddToCartReady(
  page,
  {
    onStep = () => {},
    notificationEngine = null,
    dropEvent = {},
    coordinator = null,
    timeoutMs = 45000,
    pollMs = 150
  } = {}
) {
  const deadline = Date.now() + timeoutMs
  let challengeReported = false
  let sawLoading = false

  while (Date.now() < deadline) {
    if (await hasTargetChallengeFrame(page)) {
      if (!challengeReported) {
        challengeReported = true
        onStep('Target security challenge detected - waiting for manual completion')
      }
      await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
      await page.waitForTimeout(pollMs)
      continue
    }

    const addToCartBtn = getVisibleTargetAddToCartButton(page)
    const visible = await addToCartBtn.isVisible().catch(() => false)
    if (visible && !(await addToCartBtn.isDisabled().catch(() => true))) return addToCartBtn

    const loading = await isTargetFulfillmentLoading(page)
    sawLoading ||= loading
    if (!loading && (await hasExplicitTargetOutOfStockState(page))) {
      throw new Error('Item is out of stock (Target availability settled)')
    }

    const snapshot = await coordinator?.signalState()
    await waitForTargetSignal(page, coordinator, snapshot, Math.max(pollMs, 3000))
  }

  if (challengeReported) {
    throw new Error('Target security challenge did not clear before fulfillment timeout')
  }
  if (sawLoading) {
    throw new Error('Target fulfillment is still loading; retrying the product page')
  }
  throw new Error('Target availability did not settle; retrying the product page')
}

async function hasTargetChallengeFrame(page) {
  try {
    if (
      (page.frames?.() || []).some((frame) =>
        /(?:captcha|challenge|recaptcha|hcaptcha)/i.test(String(frame.url?.() || ''))
      )
    ) {
      return true
    }
  } catch {
    // Fall through to the iframe locator.
  }

  const frame = page
    .locator('iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[src*="recaptcha" i]')
    .first()
  return (await frame.count().catch(() => 0)) > 0
}

async function isTargetFulfillmentLoading(page) {
  const loading = page
    .locator(
      '[data-test^="fulfillment-cell"][aria-label*="loading" i], [data-test*="fulfillment"][aria-label*="loading" i], [role="dialog"]:has-text("Still loading")'
    )
    .first()
  return (await loading.count().catch(() => 0)) > 0
}

async function hasExplicitTargetOutOfStockState(page) {
  const outOfStock = page
    .locator(
      'button:visible:has-text("Out of stock"), button:visible:has-text("Sold out"), [data-test*="outOfStock" i]:visible, [data-test*="soldOut" i]:visible'
    )
    .first()
  return (await outOfStock.count().catch(() => 0)) > 0
}

async function waitForTargetCartState(page, tcin, timeoutMs, coordinator = null) {
  const deadline = Date.now() + timeoutMs
  let lastState = { present: false, quantity: null, source: 'none' }
  while (Date.now() < deadline) {
    lastState = await readTargetCartItemState(page, tcin)
    if (lastState.present && Number.isInteger(lastState.quantity) && lastState.quantity > 0) {
      return lastState
    }
    const snapshot = await coordinator?.signalState()
    await waitForTargetSignal(page, coordinator, snapshot, 1000)
  }
  return lastState
}

async function waitForTargetCartTcin(page, tcin, timeoutMs, coordinator = null) {
  const state = await waitForTargetCartState(page, tcin, timeoutMs, coordinator)
  return state.present
}

async function confirmRequestedTargetCartItem(
  page,
  tcin,
  { notificationEngine, dropEvent, coordinator = null }
) {
  const initialState = await waitForTargetCartState(page, tcin, 2500, coordinator)
  if (initialState.present && Number.isInteger(initialState.quantity)) return initialState

  const url = page.url?.() || ''
  if (!/target\.com\/(co-cart|cart)/i.test(url)) {
    await page.goto('https://www.target.com/co-cart', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      if (!/ERR_ABORTED/i.test(String(err?.message || ''))) throw err
    })
  }

  await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  return waitForTargetCartState(page, tcin, 5000, coordinator)
}

async function waitForTargetSignal(page, coordinator, snapshot, timeoutMs) {
  if (coordinator) {
    await coordinator.waitForNextScan(snapshot, timeoutMs)
    return
  }
  await page.waitForTimeout(Math.min(timeoutMs, 250))
}

async function claimTargetAction(coordinator, action, cooldownMs) {
  return coordinator ? coordinator.claimAction(action, cooldownMs) : true
}
