import { parseTargetRetryAfterMs } from './TargetCartPolicy.js'

export const TARGET_ADD_TO_CART_SELECTOR = [
  'button[data-test="@web/AddToCartButton"]:visible',
  'button[data-test="orderPickupButton"]:visible',
  'button[data-test="preorderButton"]:visible',
  'button:visible:has-text("Add to cart")'
].join(', ')

const PROBABLE_SUCCESS_SELECTOR = [
  '[role="dialog"]:visible:has-text("Added to cart")',
  '[data-test*="addToCartModal" i]:visible',
  '[data-test*="cartPrompt" i]:visible:has-text("View cart")',
  'button:visible:has-text("In cart")'
].join(', ')

export const TRANSIENT_CART_DIALOG_SELECTOR = [
  '[role="dialog"]:visible:has-text("High-demand item")',
  '[role="dialog"]:visible:has-text("popular item in your cart is causing a delay")',
  '[role="dialog"]:visible:has-text("little busier than we expected")',
  '[role="dialog"]:visible:has-text("temporary issue")',
  '[role="dialog"]:visible:has-text("high demand")',
  '[role="dialog"]:visible:has-text("could not add")',
  '[role="dialog"]:visible:has-text("something went wrong")'
].join(', ')

const PASSIVE_DISMISS_SELECTOR = [
  'button:has-text("Ok")',
  'button:has-text("Okay")',
  'button:has-text("Got it")',
  'button:has-text("Dismiss")',
  'button:has-text("Keep shopping")',
  'button[aria-label="close" i]',
  'button[aria-label*="dismiss" i]',
  'button[data-test*="close" i]',
  'button:has-text("Close")'
].join(', ')

export function getVisibleTargetAddToCartButton(page, tcin) {
  const exactTcinSelector = tcin
    ? `button[id*="addToCartButtonOrTextIdFor${String(tcin)}"]:visible`
    : null
  return page
    .locator([exactTcinSelector, TARGET_ADD_TO_CART_SELECTOR].filter(Boolean).join(', '))
    .first()
}

export async function getTargetProbableCartEvidence(page, tcin) {
  const exactPromptSelector = tcin
    ? `[role="dialog"]:visible:has(a[href*="${String(tcin)}"]):has-text("cart")`
    : null
  const selector = [exactPromptSelector, PROBABLE_SUCCESS_SELECTOR].filter(Boolean).join(', ')
  const visible = await page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false)
  return visible ? { source: 'visible-added-to-cart', mutationStatus: null } : null
}

export async function dismissVisibleTargetCartTransient(page) {
  const dialog = page.locator(TRANSIENT_CART_DIALOG_SELECTOR).first()
  if (!(await dialog.isVisible().catch(() => false))) return false
  const closeButton = dialog.locator(PASSIVE_DISMISS_SELECTOR).first()
  const clicked = await closeButton
    .click({ timeout: 750 })
    .then(() => true)
    .catch(() => false)

  if (!clicked && (await dialog.isVisible().catch(() => false))) {
    await dialog.press?.('Escape').catch?.(() => {})
  }
  return clicked
}

export function isTargetCartMutationResponse(response) {
  try {
    return (
      /carts\.target\.com\/web_checkouts\/v1\/cart_items/i.test(response.url()) &&
      response.request().method() === 'POST'
    )
  } catch {
    return false
  }
}

function classifyResponse(response, evidence, nowMs) {
  const status = response?.status?.() ?? null
  if (status >= 200 && status < 300) {
    return {
      kind: 'success',
      status,
      retryAfterMs: null,
      evidence: { source: 'mutation-2xx', mutationStatus: status }
    }
  }
  if (status === 409) {
    return {
      kind: 'success',
      status,
      retryAfterMs: null,
      evidence: { source: 'mutation-409', mutationStatus: status }
    }
  }
  if (status === 429) {
    const headers = response.headers?.() || {}
    return {
      kind: 'rate-limit',
      status,
      retryAfterMs: parseTargetRetryAfterMs(headers['retry-after'], nowMs),
      evidence: null
    }
  }
  if (status === 401 || status === 403) {
    return { kind: 'session-error', status, retryAfterMs: null, evidence: null }
  }
  if (status >= 500) return { kind: 'transient', status, retryAfterMs: null, evidence: null }
  if (evidence) return { kind: 'success', status, retryAfterMs: null, evidence }
  return { kind: 'no-response', status, retryAfterMs: null, evidence: null }
}

export async function clickAndObserveTargetCart({
  page,
  button,
  tcin,
  outcomeMs = 1500,
  now = () => Date.now()
}) {
  const responsePromise = page
    .waitForResponse(isTargetCartMutationResponse, { timeout: outcomeMs })
    .catch(() => null)
  const clickPromise = Promise.resolve()
    .then(() => button.click({ timeout: outcomeMs }))
    .then(
      () => ({ type: 'click-complete' }),
      (error) => ({ type: 'click-error', error })
    )
  const responseOutcome = responsePromise.then((response) => ({ type: 'response', response }))

  const first = await Promise.race([responseOutcome, clickPromise])
  const response = first.type === 'response' ? first.response : await responsePromise
  if (!response && first.type === 'click-error') throw first.error

  const evidence = await getTargetProbableCartEvidence(page, tcin)
  const transientVisible = await page
    .locator(TRANSIENT_CART_DIALOG_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false)
  const classified = classifyResponse(response, evidence, now())
  if (classified.kind === 'no-response' && transientVisible) {
    return { kind: 'transient', status: null, retryAfterMs: null, evidence: null }
  }
  return classified
}
