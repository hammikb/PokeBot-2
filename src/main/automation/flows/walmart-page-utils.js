/**
 * Shared Walmart page selectors and utilities.
 * Centralizes selector strings so a single Walmart markup change
 * doesn't require updating every flow file.
 */

// ── Add-to-cart ──────────────────────────────────────────────
export const ATC_SELECTOR = [
  'button[data-automation-id="atc"]',
  'button:has-text("Add to cart")',
  'button:has-text("Add to Cart")',
  'button[aria-label*="Add to cart" i]',
  'button[aria-label*="Add to Cart" i]',
  '[data-testid="add-to-cart-button"]',
  'button.ws-normal:has-text("Add")'
].join(', ')

// ── Cart confirmation signals ──────────────────────────────
export const CART_CONFIRMATION_SELECTOR = [
  '[data-automation-id="cart-item-count"]:visible',
  '[aria-label*="cart" i]:visible:has-text("1")',
  '[role="alert"]:visible:has-text("Added to cart")',
  'button:visible:has-text("View cart")',
  'button:visible:has-text("View Cart")'
].join(', ')

// ── Queue / waitlist ────────────────────────────────────────
export const QUEUE_JOIN_SELECTOR = [
  'button:has-text("Join Waitlist")',
  'button:has-text("Get In Line")',
  'button:has-text("Join queue")',
  'button:has-text("Join Queue")'
].join(', ')

/** Selector used to wait until the queue passes. */
export const ATC_AFTER_QUEUE_SELECTOR =
  '[class*="add-to-cart"]:not([disabled]), button[data-automation-id="atc"]:not([disabled])'

// ── CVV field ───────────────────────────────────────────────
export const CVV_SELECTOR = [
  'input[name="cvv"]',
  'input[placeholder*="CVV"]',
  'input[aria-label*="CVV"]',
  'input[aria-label*="cvv"]',
  'input[autocomplete="cc-csc"]'
].join(', ')

// ── Place order ─────────────────────────────────────────────
export const PLACE_ORDER_SELECTOR = [
  'button:has-text("Place order")',
  'button:has-text("Place Order")',
  'button[data-automation-id="place-order"]'
].join(', ')

// ── Checkout ready signal ───────────────────────────────────
export const CHECKOUT_READY_SELECTOR = [
  'input[name="cvv"]:visible',
  'input[autocomplete="cc-csc"]:visible',
  'button[data-automation-id="place-order"]:visible',
  'button:visible:has-text("Place order")'
].join(', ')

// ── Sign-in detection ──────────────────────────────────────
export const SIGN_IN_LINK_SELECTOR = [
  'a:has-text("Sign in")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  '[data-automation-id="sign-in"]'
].join(', ')

// ── Username / password fields ─────────────────────────────
export const USERNAME_SELECTOR = [
  'input[name="email"]',
  'input[type="email"]',
  'input[autocomplete*="username"]',
  'input[id*="email"]'
].join(', ')

export const PASSWORD_SELECTOR = 'input[name="password"], input[type="password"]'
export const CONTINUE_BTN_SELECTOR = 'button:has-text("Continue"), button[type="submit"]'
export const SIGN_IN_BTN_SELECTOR = [
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button[type="submit"]'
].join(', ')

// ── Order confirmation ─────────────────────────────────────
export const ORDER_CONFIRMATION_SELECTOR = [
  '[class*="order-confirmation"]',
  '[class*="thank-you"]',
  '[class*="orderConfirmation"]'
].join(', ')

export const ORDER_NUMBER_SELECTOR = '[class*="order-number"], [class*="orderNumber"]'
