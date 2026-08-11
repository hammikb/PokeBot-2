# Target High-Demand Browser Checkout Design

Date: 2026-08-10
Status: Approved direction; awaiting written-spec review

## Objective

Increase Target checkout success rate during high-demand Pokémon card drops while reducing time from the drop signal to a verified cart and order-review page.

Checkout success is the primary objective. Raw speed is secondary: latency is acceptable only when it prevents a failed cart, a lost warm session, or an uncertain order submission.

## Evidence and constraints

Local checkout telemetry from 2026-07-21 through 2026-08-07 contains 15 Target attempts: 11 failed and 4 required manual action. Ten attempts failed around cart acquisition. Five recent attempts ended because the requested item could not be confirmed in the cart. The latest two relevant diagnostics showed HTTP 429 responses from Target cart endpoints while the high-demand cart dialog was visible.

The telemetry also shows that persistent browser and page reuse is effective: warm attempts can acquire their existing browser context in under 100 ms. The largest avoidable delays came from falling back after an API rate limit, re-running the complete checkout flow, and repeating cart navigation or verification.

All current production checkout attempts are expected to occur during high-demand Pokémon drops. Therefore:

- Browser checkout is the production cart-acquisition strategy.
- Target's internal web cart API is not probed during the drop.
- A future Target mobile/API strategy remains out of scope and must be introduced as a separate strategy after independent research and testing.
- Existing item, quantity, maximum-price, order-limit, and uncertain-submission protections remain mandatory.

## Context7 findings

The current Playwright documentation supports three decisions in this design:

1. A network-response wait must be armed before the action that triggers the response.
2. Locator actions already wait for actionability; fixed sleeps should not duplicate Playwright's visibility, stability, event-receiving, and enabled checks.
3. Playwright request routing disables Chromium's HTTP cache while interception is active. Target lite mode must remain off by default until a measured experiment shows a net benefit. Any future use must be narrowly scoped and removed after the critical load.

## Architecture

The Target flow will use a browser-only cart acquisition state machine. It owns the sequence from a prewarmed product page through authoritative cart confirmation and returns a single `CartEvidence` result to the checkout flow.

The state machine has these states:

- `product_warm`: the exact product page is open in the account's persistent checkout page.
- `availability_wait`: fulfillment controls are hydrating or the product is not yet available.
- `cart_click_ready`: one visible, enabled Add to Cart control is actionable.
- `cart_response_wait`: the cart mutation response listener is armed and the click is in progress.
- `high_demand_wait`: Target explicitly returned 429 or displayed its high-demand dialog.
- `cart_confirming`: Target accepted the mutation and the requested TCIN and quantity are being verified.
- `cart_ready`: authoritative cart evidence is available.
- `challenge`: a visible security challenge requires resolution.
- `terminal_failure`: inventory is explicitly unavailable, the session is invalid, or the retry deadline expired.

Only `cart_ready` may transition to checkout navigation.

## Components

### Browser checkout strategy

`browserAddToCart` becomes the sole production Target cart strategy. The existing `useTargetCartApi` setting may remain for future experimentation, but high-demand Pokémon tasks must not execute it. The UI and runtime configuration should make the active strategy unambiguous.

The strategy reuses the account's persistent checkout page. It does not create a new page or context between high-demand retries.

### Pre-drop readiness

Before a drop, the account's persistent page opens the exact product URL and preserves its authenticated session. Readiness checks validate:

- the page and context are still open;
- Target authentication cookies are present;
- the protected Target origin does not currently present a visible challenge;
- the exact product page remains available for a fast in-place readiness check.

Readiness failures mark the account unavailable before the drop when possible. Drop-time checkout must not navigate away merely to perform routine session maintenance.

### Response-aware Add to Cart

Before clicking, the strategy creates a Playwright `waitForResponse` promise for the exact Target cart mutation endpoint and HTTP method. It then clicks the live locator and awaits the response and visible high-demand state together.

Outcomes are classified as follows:

- 2xx: proceed to cart confirmation.
- 409 or an explicit purchase-limit response: verify the exact requested TCIN in the cart; proceed only when authoritative cart evidence is present.
- 429 or visible high-demand dialog: dismiss only the dialog, remain on the same product page, and enter `high_demand_wait`.
- 401 or 403: classify as session or security failure; do not repeatedly click.
- explicit sold-out state: terminate as inventory unavailable.
- no observed response: inspect the current page and lightweight cart evidence before deciding whether one guarded retry is safe. Never assume success from a click alone.

### High-demand retry policy

High-demand retries preserve the current page, cookies, React state, and browser fingerprint. They never restart the entire Target flow.

The delay uses Target's `Retry-After` response header when valid. Otherwise it uses bounded jittered backoff, beginning near the existing 3–6 second range and increasing to a 15-second ceiling. The retry window is bounded and configurable, with 120 seconds as the initial default.

After the delay, the strategy dismisses any remaining dialog, reacquires the current visible Add to Cart locator, and retries only if the product page is still valid. It navigates back to the exact product URL only when Target has replaced the product page.

### Authoritative cart handoff

Cart confirmation produces:

```js
{
  tcin,
  quantity,
  unitPrice,
  source,
  mutationStatus,
  confirmedAt
}
```

`browserAddToCart` returns this evidence to `runTargetFlow`. The caller reuses it instead of immediately navigating or parsing the same cart a second time. This removes the redundant verification path that added seconds and could fail after an earlier successful confirmation.

The flow then performs exactly one checkout navigation. A final independent item, quantity, and maximum-price validation remains immediately before order submission because it protects against cart changes after acquisition.

### Checkout and submission recovery

High-demand handling on the checkout page remains in place and favors in-page recovery. Reload is a bounded last resort when checkout controls are genuinely stalled.

Order submission keeps the existing irreversible-action protections:

- the order-submission gate is claimed before clicking;
- confirmation is checked before any retry;
- a retry occurs only after an explicit Target rejection or payment-verification request;
- an ambiguous response is terminal and requires manual order-status review.

## Data flow

1. The monitor emits a drop event.
2. Task readiness selects a healthy, prewarmed Target account and existing product page.
3. The browser cart state machine waits for an actionable Add to Cart locator.
4. It arms the cart-response wait, clicks, and classifies the result.
5. A 429 stays on the warm page and follows bounded backoff; a 2xx proceeds to exact cart verification.
6. Verified `CartEvidence` is passed to the main Target flow.
7. The flow navigates once to checkout and reaches order review.
8. The final cart safety validation runs.
9. The submission gate permits at most the configured number of orders.
10. Target confirmation completes the attempt; ambiguity stops automatic retries.

## Telemetry and success criteria

Target telemetry will record structured, sanitized fields for:

- cart state transitions and elapsed time;
- cart mutation status class;
- retry count and selected backoff;
- whether `Retry-After` was honored;
- cart evidence source;
- time from drop to actionable button, verified cart, checkout ready, submission, and confirmation;
- high-demand, challenge, session, inventory, parser, and uncertain-submission failure classes.

No account email, cookies, payment values, full URLs, or raw response bodies are recorded.

Initial acceptance criteria are:

- no API cart requests for production high-demand Target tasks;
- no full-flow restart after a recoverable 429;
- no duplicate cart verification immediately after `CartEvidence` is returned;
- no duplicate or uncertain automatic order resubmission;
- all existing checkout safety tests remain green;
- deterministic tests cover every state transition;
- live test-mode runs reach order review without submitting an order;
- measured drop-to-cart and drop-to-checkout timings improve without reducing the verified-cart rate.

Because the current sample contains no confirmed Target orders, the first live rollout establishes the baseline. Success-rate claims require new observed attempts rather than inference from unit tests.

## Testing

Unit and fixture tests will cover:

- response listener armed before click;
- 2xx mutation followed by exact TCIN and quantity confirmation;
- 429 with `Retry-After` followed by success on the same page;
- repeated 429 until the retry deadline;
- high-demand modal without a captured response;
- 401/403 session or challenge termination;
- explicit out-of-stock termination;
- page replacement and bounded return to the exact product URL;
- reuse of returned cart evidence without duplicate confirmation;
- final price and quantity safety rejection;
- explicit rejection versus ambiguous order-submission outcome.

Integration tests will use Target fixtures and mocked network responses. Test mode will verify the complete flow through order review while proving that Place Your Order is never clicked.

## Rollout

1. Land the state machine, telemetry, and deterministic tests behind a Target browser-checkout feature flag.
2. Run repeated test-mode checkouts on ordinary in-stock items to validate state transitions and timing.
3. Enable browser-only mode for one high-demand Target account and inspect sanitized telemetry after each attempt.
4. Expand to additional accounts only after the flow shows correct same-page 429 recovery and no safety regressions.
5. Remove the old high-demand API-first path after the browser-only rollout is stable.

## Out of scope

- Target mobile API reverse engineering or integration;
- automated CAPTCHA solving;
- changes to non-Target retailer checkout flows;
- bypassing Target purchase limits or order controls;
- unrelated renderer or database refactoring.
