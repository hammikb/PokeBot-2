# Target Recoverable Page Reuse Design

## Goal

Reuse an account's existing Target checkout page after a recoverable pre-submission failure so the next attempt retains the warm page, cookies, React state, and any uncertain cart mutation. Continue discarding pages that are terminal, unsafe, or unusable.

## Scope

This change affects only Target checkout page cleanup. It does not change inventory gating, retry counts or delays, account checkout leases, order-submission safeguards, cart validation, price limits, or monitoring.

## Design

`runTargetFlow` obtains its page through `BrowserPool.getCheckoutPage` when a pool and account ID are available. The flow will track one cleanup decision for that page:

- Preserve the page after a recognized recoverable failure that occurs before order submission.
- Preserve the page for existing manual-review and uncertain-submission outcomes.
- Close the page after success, settled out-of-stock state, account/session rejection, security challenge, invalid product state, or any unclassified failure.
- A page that is already closed cannot be reused; `BrowserPool.getCheckoutPage` will remove that stale reference and create a replacement on the next attempt.

The recoverable classification will use an explicit allowlist rather than treating every retryable TaskManager error as safe to reuse. Initial allowlisted cases are:

- Target browser add-to-cart was not confirmed.
- Target did not confirm the requested item in the cart.
- Target high-demand add-to-cart retry window expired.
- Target fulfillment is still loading.
- Target availability did not settle.
- A Target navigation was interrupted or aborted before submission while the page remains open on a Target-owned origin.

Explicitly unsafe conditions—including HTTP 401/403, sign-out, CAPTCHA/security challenge, a non-Target origin, closed browser/page/context, wrong product, settled out-of-stock, and any failure after an order-submission attempt—will not reuse the page.

## Lifecycle and Ownership

The browser context remains owned by `BrowserPool`, and `TaskManager` retains its existing per-account checkout lease. Preserving a page does not release the account for concurrent work. The next retry asks the pool for the same reserved checkout page; no page object is passed through task results or stored in TaskManager.

Terminal success closes the page so a later requested order begins from a clean page while retaining the persistent account context. Manual-review and uncertain-order behavior remains unchanged and keeps both the page and account hold available to the user.

## Observability

The flow will log whether cleanup preserved or discarded the page and the reason. No URL query strings, cart contents, payment data, or account identifiers will be added to telemetry.

## Testing

Tests will prove that:

1. A recognized recoverable pre-submission failure leaves the pooled page open.
2. A session rejection, security challenge, settled out-of-stock result, and unclassified error close the page.
3. Success closes the page.
4. Manual-review and uncertain-submission outcomes continue preserving the page.
5. The next pooled attempt receives the preserved page, while a closed page is replaced.

The focused Target flow and BrowserPool tests will run first, followed by the complete test suite and production build.

## Non-goals

- Checking the cart before every attempt.
- Persisting cart evidence between attempts.
- Changing retry delays or retry budgets.
- Reusing a page after an authentication, challenge, or submission-safety failure.
- Changing non-Target retailer behavior.
