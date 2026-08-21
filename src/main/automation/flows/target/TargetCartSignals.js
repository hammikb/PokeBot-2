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

// Target has shipped the product-page quantity control as a <select>, a numeric
// input, and a +/- stepper. Match all three: a single hardcoded selector silently
// no-opped through an entire drop season.
export const TARGET_QUANTITY_SELECT_SELECTOR = [
  'select[data-test="@web/QuantitySelector"]',
  'select[data-test*="uantity" i]',
  'select[aria-label*="quantity" i]',
  'select[name*="quantity" i]'
].join(', ')

export const TARGET_QUANTITY_INPUT_SELECTOR = [
  'input[data-test="qtyStepperInput"]',
  'input[data-test*="uantity" i]',
  'input[aria-label*="quantity" i]',
  'input[name*="quantity" i]'
].join(', ')

export const TARGET_QUANTITY_INCREMENT_SELECTOR = [
  'button[data-test="qtyStepperUp"]',
  'button[data-test*="ncrement" i]',
  'button[aria-label*="increase quantity" i]',
  'button[aria-label*="increment" i]'
].join(', ')

// Target's live PDP control is none of the above: a custom listbox trigger with no
// data-test and a React-generated id (`select-_r_g_`) that changes every render.
// Only the CSS-module class stems are stable enough to match on.
// :visible is load-bearing. Target keeps the sticky-bar copy of this control mounted
// with `visibility: hidden` until you scroll, and it still reports a 90x44 bounding box
// - so a rect-based check calls it visible while Playwright rightly refuses to click it.
// Without this filter each quantity change burned ~3.6s timing out on that element.
export const TARGET_QUANTITY_TRIGGER_SELECTOR = [
  'button[class*="selectCustomButton"]:visible',
  'button:has([class*="quantityValue"]):visible'
].join(', ')

export const TARGET_QUANTITY_VALUE_SELECTOR = '[class*="quantityValue"]:visible'

// Verified against a live PDP. The options are NOT role="option" - they are anchors
// whose only reliable hook is aria-label, and the digit sits in a nested <div> next to
// an <svg>, which is why :text-is() never matched:
//   <ul class="Options_styles_options__hQoz_">
//     <li><a href="#" aria-label="1" class="...optionItem..."><div>1</div></a></li>
//     <li><a href="#" aria-label="2 - selected" class="...selected..."><div>2</div><svg/></a></li>
//   </ul>
export const TARGET_QUANTITY_OPTION_SELECTOR = (wanted) =>
  [
    // Verified live: exactly one list is mounted at a time (React unmounts it on close)
    // and it is portaled to body, not nested in a fulfillment section. :visible is a
    // cheap guard against a stale list lingering mid-animation, not a disambiguator.
    `ul[class*="Options_styles_options"]:visible a[aria-label="${wanted}"]`,
    `ul[class*="Options_styles_options"]:visible a[aria-label="${wanted} - selected"]`,
    `[class*="optionItem"][aria-label="${wanted}"]:visible`,
    `[role="option"]:visible:text-is("${wanted}")`
  ].join(', ')

export const TARGET_QUANTITY_CONTROL_SELECTORS = [
  TARGET_QUANTITY_SELECT_SELECTOR,
  TARGET_QUANTITY_INPUT_SELECTOR,
  TARGET_QUANTITY_VALUE_SELECTOR,
  '[data-test="qtyStepperValue"]',
  '[role="spinbutton"][aria-valuenow]'
]

// Target's "item not added" side sheet is the retry signal it hands us in plain
// language: "Something went wrong and the item was not added to your cart. Please
// try again." It is not always a role="dialog", so match alerts and live regions too.
const TRANSIENT_CART_HOST_ROLES = ['[role="dialog"]', '[role="alert"]', '[aria-live]']

const TRANSIENT_CART_PHRASES = [
  'High-demand item',
  'popular item in your cart is causing a delay',
  'little busier than we expected',
  'temporary issue',
  'high demand',
  'could not add',
  'something went wrong',
  'item was not added',
  'Item not added to cart'
]

export const TRANSIENT_CART_DIALOG_SELECTOR = TRANSIENT_CART_HOST_ROLES.flatMap((host) =>
  TRANSIENT_CART_PHRASES.map((phrase) => `${host}:visible:has-text("${phrase}")`)
).join(', ')

// The X. Tried first and on its own: a selector union resolves in DOM order, and the
// close control is rendered last in Target's side sheet, so bundling it with the text
// buttons meant "Continue shopping" always won the race to .first().
const CLOSE_CONTROL_SELECTOR = [
  'button[aria-label*="close" i]',
  'button[data-test*="close" i]',
  'button:has-text("Close")'
].join(', ')

const PASSIVE_DISMISS_SELECTOR = [
  'button:has-text("Ok")',
  'button:has-text("Okay")',
  'button:has-text("Got it")',
  'button:has-text("Dismiss")',
  'button:has-text("Keep shopping")',
  // Target's "Item not added to cart" side sheet dismisses via "Continue shopping".
  // It renders over a page-dimming overlay, so leaving it open makes the next
  // Add to cart click land on the overlay instead of the button.
  'button:has-text("Continue shopping")',
  'button[aria-label="close" i]',
  'button[aria-label*="dismiss" i]',
  'button[data-test*="close" i]',
  'button:has-text("Close")'
].join(', ')

// Target renders a running cart total in the global header on every page, so the
// cart contents can be observed without navigating to /co-cart at all.
export const TARGET_CART_LINK_QUANTITY_SELECTOR = '[data-test="@web/CartLinkQuantity"]'

// Present on every page whether or not the cart has anything in it, so it tells an
// empty cart apart from a header that simply has not hydrated yet.
// Verified live: the header cart link is present on every page and carries an exact
// count in its aria-label ("cart 0 items"), including when the cart is empty - the
// badge span is absent at zero. The href is /cart?prehydrateClick=true, so an exact
// href match never fires; keep it as a prefix.
const TARGET_CART_LINK_SELECTOR = [
  '[data-test="@web/CartLink"]',
  'a[href^="/cart"]',
  'a[href*="/co-cart"]'
].join(', ')

export async function readTargetHeaderCartQuantity(page) {
  const cartLink = page.locator(TARGET_CART_LINK_SELECTOR).first()
  if (await cartLink.count().catch(() => 0)) {
    const label = await cartLink.getAttribute('aria-label').catch(() => null)
    const labelled = String(label ?? '').match(/cart\s+(\d+)\s+item/i)
    if (labelled) return Number(labelled[1])
  }

  const badge = page.locator(TARGET_CART_LINK_QUANTITY_SELECTOR).first()
  if (await badge.count().catch(() => 0)) {
    const raw = await badge.textContent().catch(() => null)
    const parsed = Number(String(raw ?? '').replace(/[^\d]/g, ''))
    if (Number.isInteger(parsed)) return parsed
  }

  return (await cartLink.count().catch(() => 0)) ? 0 : null
}

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

export async function dismissVisibleTargetCartTransient(
  page,
  { timeoutMs = 250, onDiagnostic = () => {}, now = () => Date.now() } = {}
) {
  const startedAt = now()
  const dialog = page.locator(TRANSIENT_CART_DIALOG_SELECTOR).first()
  if (!(await dialog.isVisible().catch(() => false))) {
    // Not "nothing to do" - it may mean the panel is on screen but our selector does
    // not match it, in which case nothing will ever close it. Say which.
    onDiagnostic({ outcome: 'no-match', elapsedMs: now() - startedAt })
    return false
  }

  // `force` skips Playwright's actionability wait. The side sheet slides in, so the
  // stability check would otherwise sit out the whole animation before clicking - the
  // single biggest source of delay in getting this panel off the screen.
  for (const selector of [CLOSE_CONTROL_SELECTOR, PASSIVE_DISMISS_SELECTOR]) {
    const clicked = await dialog
      .locator(selector)
      .first()
      .click({ timeout: timeoutMs, force: true })
      .then(() => true)
      .catch(() => false)
    // `force` skips the check that the click was actually received, so a click the
    // overlay swallowed still resolves. Trust the panel being gone, not the click.
    if (clicked && !(await dialog.isVisible().catch(() => false))) {
      onDiagnostic({ outcome: 'closed', selector, elapsedMs: now() - startedAt })
      return true
    }
  }

  if (await dialog.isVisible().catch(() => false)) {
    await dialog.press?.('Escape').catch?.(() => {})
  }
  onDiagnostic({
    outcome: 'stuck',
    elapsedMs: now() - startedAt,
    stillVisible: await dialog.isVisible().catch(() => false)
  })
  return false
}

export function isTargetCartMutationResponse(response) {
  try {
    const targetUrl = new URL(response.url())
    return (
      targetUrl.protocol === 'https:' &&
      targetUrl.host === 'carts.target.com' &&
      targetUrl.pathname === '/web_checkouts/v1/cart_items' &&
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
  if (status >= 400 && status < 500) {
    return { kind: 'transient', status, retryAfterMs: null, evidence: null }
  }
  if (status >= 500) return { kind: 'transient', status, retryAfterMs: null, evidence: null }
  if (evidence) return { kind: 'success', status, retryAfterMs: null, evidence }
  return { kind: 'no-response', status, retryAfterMs: null, evidence: null }
}

// Once the "item not added" sheet is up, Target has already answered visually. Wait
// only this much longer for the HTTP response so a real 429 still classifies as a rate
// limit, instead of sitting out the whole outcome window with the panel on screen.
const TRANSIENT_RESPONSE_GRACE_MS = 400

export async function clickAndObserveTargetCart({
  page,
  button,
  tcin,
  outcomeMs = 1500,
  transientGraceMs = TRANSIENT_RESPONSE_GRACE_MS,
  now = () => Date.now()
}) {
  const responsePromise = page
    .waitForResponse(isTargetCartMutationResponse, { timeout: outcomeMs })
    .catch(() => null)
  const transientSettled = (
    page
      .locator(TRANSIENT_CART_DIALOG_SELECTOR)
      .first()
      .waitFor?.({ state: 'visible', timeout: outcomeMs })
      ?.then(
        () => true,
        () => false
      ) ?? Promise.resolve(false)
  ).then(async (seen) => {
    if (seen) await page.waitForTimeout?.(transientGraceMs)
    return null
  })
  const clickPromise = Promise.resolve()
    .then(() => button.click({ timeout: outcomeMs }))
    .then(
      () => ({ type: 'click-complete' }),
      (error) => ({ type: 'click-error', error })
    )
  const responseOutcome = responsePromise.then((response) => ({ type: 'response', response }))

  const first = await Promise.race([responseOutcome, clickPromise])
  const response =
    first.type === 'response'
      ? first.response
      : await Promise.race([responsePromise, transientSettled])
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
