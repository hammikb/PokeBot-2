# Target High-Demand Browser Checkout Design

Date: 2026-08-10
Status: Approved design; awaiting written-spec review

## Objective

Increase Target checkout success during high-demand Pokémon card drops while reducing the time from the drop signal to a verified cart and checkout.

The production strategy is browser-only. It should approach Polar's Add to Cart timing without copying Polar's obfuscated implementation or weakening PokeBot's item, quantity, price, purchase-limit, challenge, or order-submission protections.

## Evidence and constraints

Local checkout telemetry from 2026-07-21 through 2026-08-07 contains 15 Target attempts: 11 failed and 4 required manual action. Ten attempts failed around cart acquisition. Five recent attempts ended because the requested item could not be confirmed in the cart. The latest two relevant diagnostics showed HTTP 429 responses from Target cart endpoints while the high-demand cart dialog was visible.

Persistent browser and page reuse is effective: warm attempts can acquire their existing browser context in under 100 ms. The largest avoidable delays came from falling back after a rate limit, restarting the complete flow, and repeating navigation or cart verification.

Static analysis of the local Polar extension found two Add to Cart layers. Its deterministic layer uses zero intentional pre-click delay, 100 ms polling, a 1.5-second outcome window, up to four additional no-response clicks, roughly 400 ms between recognized transient-error retries, up to 30 recognized-error retries, and at most two product-page reloads. Its separate AI layer caps Add to Cart clicks at three and waits longer for evidence. Polar also checks for success evidence before clicking again.

All current production Target checkout attempts are expected to occur during high-demand Pokémon drops. Therefore:

- Browser checkout is the only production cart-acquisition strategy.
- Target's internal web cart API is not probed during a drop.
- A future Target mobile/API strategy remains out of scope.
- Automated CAPTCHA solving, purchase-limit bypasses, and security-control bypasses are out of scope.
- Existing checkout safety and irreversible order-submission protections remain mandatory.

## Context7 findings

Current Playwright documentation supports three implementation decisions:

1. The network-response wait must be armed before the action that triggers the response.
2. Locator actions already wait for visibility, stability, event reception, and enabled state. Zero intentional delay does not disable those actionability checks.
3. Playwright request routing disables Chromium's HTTP cache. Target lite mode remains off by default unless a measured experiment demonstrates a net benefit.

## Chosen approach

Use classified Polar-like aggression.

PokeBot will match Polar's fast polling, immediate click, short outcome window, bounded fast retries, reload budget, and evidence guards. It will distinguish a captured HTTP 429 from a client-side transient modal:

- A recognized transient modal without a captured 429 receives a 400 ms retry delay.
- A captured 429 honors a valid `Retry-After` header; without one, it receives a 1.5-second retry delay.

This is substantially more aggressive than PokeBot's current 100-300 ms intentional click delay and 3-6 second 429 delay while remaining response-aware.

## Architecture

The Target flow will use a browser-only `TargetCartAttemptController` that owns one warm product page from availability detection through authoritative cart confirmation. It returns one `CartEvidence` result to the checkout flow.

The controller has these states:

- `product_warm`: the exact product page is open in the account's persistent checkout page.
- `availability_wait`: fulfillment controls are hydrating or availability is unresolved.
- `cart_click_ready`: one live, visible, enabled Add to Cart control is actionable.
- `preclick_guard`: success evidence, page identity, stock state, and button actionability are rechecked.
- `cart_response_wait`: the response listener is armed and the click is performed with no intentional delay.
- `outcome_classifying`: network and visible evidence are observed for 1.5 seconds.
- `transient_recovery`: a recognized recoverable modal is dismissed before a 400 ms retry.
- `rate_limited`: a captured 429 waits for `Retry-After` or 1.5 seconds.
- `cart_confirming`: probable success has frozen further clicks and exact cart evidence is being verified.
- `cart_ready`: authoritative cart evidence is available.
- `reloading_product`: the exact product page is being restored within the two-reload budget.
- `challenge`: a visible security challenge requires the existing manual workflow.
- `terminal_failure`: inventory is unavailable, the session is invalid, or a retry budget expired.

Only `cart_ready` may transition to checkout navigation.

## Timing and retry policy

The controller uses these fixed initial limits:

| Behavior | Limit |
| --- | ---: |
| Intentional delay before Add to Cart click | 0 ms |
| Button polling and reacquisition interval | 100 ms |
| Outcome observation window after a click | 1,500 ms |
| Additional no-response clicks per loaded product page | 4 |
| Recognized transient-error delay | 400 ms |
| Captured 429 delay without valid `Retry-After` | 1,500 ms |
| Shared recoverable-retry limit for one acquisition run | 30 |
| Product-page reload limit | 2 |
| Overall cart-acquisition deadline | 120 seconds |

The first click is not a retry. Every additional click increments the shared recoverable-retry counter, including no-response, transient-modal, and 429 recovery clicks. The no-response allowance resets after a successful product-page reload, but the shared 30-retry counter, two-reload counter, and 120-second deadline never reset.

A valid `Retry-After` delay is honored only within the remaining 120-second acquisition deadline. If the header would exceed the deadline, the attempt terminates instead of sleeping past it.

## Fast button acquisition

The controller polls the current page every 100 ms while availability is unresolved. It locates the exact Target Add to Cart or preorder control associated with the requested TCIN and supported fulfillment choice. It rejects Choose Options and explicitly disabled preorder or out-of-stock states.

The live locator is reacquired before every click. A pending click is cancelled if the button disappears, becomes disabled, is replaced, is obstructed by a known modal, or success evidence becomes visible. Playwright's normal locator actionability checks remain enabled.

The existing coordinator must not convert the 100 ms scan into an unconditional multi-second sleep. It may wake the loop earlier when relevant page signals change, but the controller retains a 100 ms maximum polling cadence during the critical Add to Cart window.

## Response-aware click and evidence

Before every click, the controller arms a Playwright response promise for the Target cart mutation endpoint. It then clicks immediately and observes network and visible page state together for 1.5 seconds.

Evidence is divided into two levels:

1. Probable success freezes further clicks. Sources include a successful cart-mutation response associated with the requested TCIN, Target's Added to Cart confirmation, a product cart prompt, or an exact requested-TCIN mini-cart state.
2. Authoritative success permits checkout. It requires the exact requested TCIN and requested quantity in Target's cart. A generic cart count, unrelated existing item, successful click action, or unverified 2xx response is insufficient.

The evidence detector runs before a click, during the outcome window, before a recovery click, and immediately after dismissing a modal. Once probable success is detected, only cart verification may run. If authoritative verification fails, the controller restores the exact product page within the reload budget and resumes only when no success evidence remains.

Authoritative confirmation produces:

```js
{
  tcin,
  quantity,
  unitPrice,
  source,
  mutationStatus,
  clickCount,
  retryCount,
  reloadCount,
  confirmedAt
}
```

The main Target flow reuses this `CartEvidence` rather than immediately performing a duplicate confirmation.

## Outcome classification and recovery

- `2xx` or visible probable-success evidence: freeze clicking and verify the exact cart.
- `409` or explicit purchase-limit response: verify whether the requested TCIN and quantity are already present; never bypass the limit.
- Captured `429`: dismiss any known dialog, honor valid `Retry-After` or wait 1.5 seconds, reacquire the button, and retry on the warm page.
- Recognized recoverable modal without captured `429`: dismiss it, wait 400 ms, recheck evidence, reacquire the button, and retry.
- No response and no modal after 1.5 seconds: recheck evidence and use one of the four additional no-response clicks.
- `401` or `403`: stop automatic clicking and classify the attempt as a session or security failure.
- Visible challenge: enter the existing manual challenge workflow. Do not automate challenge solving.
- Explicit out-of-stock or disabled-preorder state: terminate immediately as inventory unavailable.
- Missing, replaced, or broken product page: restore the exact product URL within the two-reload budget.
- Exhausted no-response allowance on a healthy page: reload within budget; otherwise terminate with the exhausted counter.
- Exhausted shared retry count, reload count, or deadline: terminate with a precise failure classification.

High-demand recovery never restarts the full checkout flow or creates a new browser context. Ordinary retries keep the existing page, cookies, authenticated session, React state, and browser fingerprint.

## Checkout and submission safeguards

After `CartEvidence` is returned, the flow navigates to checkout exactly once. A final independent item, quantity, and maximum-price validation remains immediately before order submission to protect against cart changes after acquisition.

Order submission keeps the existing irreversible-action protections:

- Claim the order-submission gate before clicking.
- Check for confirmation before any retry.
- Retry only after an explicit Target rejection or payment-verification request.
- Treat an ambiguous submission result as terminal and require manual order-status review.

Aggressive Add to Cart behavior does not increase the permitted order quantity or automatic submission count.

## Data flow

1. The monitor emits a drop event.
2. Task readiness selects a healthy prewarmed Target account and its existing product page.
3. The controller polls at 100 ms until the exact Add to Cart control is actionable.
4. The preclick guard checks evidence, product identity, stock state, and the live locator.
5. The controller arms the cart-response wait and clicks without intentional delay.
6. It classifies network and visible evidence for 1.5 seconds.
7. Recoverable outcomes follow their bounded retry path; probable success freezes clicking.
8. Exact cart verification creates `CartEvidence`.
9. The main flow reuses the evidence and navigates once to checkout.
10. Final cart safety validation and the submission gate protect the irreversible action.
11. Target confirmation completes the attempt; ambiguity stops automatic submission retries.

## Telemetry and success criteria

Structured telemetry records:

- state transitions and elapsed time;
- time from signal to actionable button, first click, probable evidence, authoritative cart, checkout, and confirmation;
- click, retry, transient-error, 429, and reload counts;
- selected delay and whether `Retry-After` was honored;
- cart mutation status class and evidence source;
- final outcome and exhausted budget, when applicable.

Telemetry must not contain account email, cookies, payment values, full URLs, or raw response bodies.

Initial acceptance criteria are:

- zero intentional Add to Cart pre-click delay;
- a measured 100 ms critical polling cadence;
- response wait armed before every click;
- no more than four additional no-response clicks per loaded page;
- 400 ms transient recovery and 1.5-second fallback 429 recovery within timing tolerance;
- no more than 30 shared recoverable retries and two product reloads;
- no click after probable success without a failed authoritative verification and bounded page restore;
- no API cart requests for production high-demand Target tasks;
- no full-flow restart after a recoverable cart error;
- no duplicate cart verification after `CartEvidence` is returned;
- all checkout and order-submission safety tests remain green;
- live test-mode runs reach order review without submitting an order.

Because the current telemetry contains no confirmed Target orders, the first controlled live rollout establishes the new success-rate baseline. Unit tests may establish correctness and timing behavior but cannot establish live checkout success.

## Testing

Deterministic tests will cover:

- zero intentional pre-click delay while retaining Playwright actionability;
- 100 ms polling and live locator reacquisition;
- response listener armed before every click;
- 2xx mutation followed by exact TCIN and quantity confirmation;
- success evidence appearing between retries and cancelling the pending click;
- first click plus four additional no-response clicks per loaded page;
- no-response allowance reset after reload without resetting global budgets;
- 400 ms recognized transient-modal recovery;
- 429 with `Retry-After` and 429 with the 1.5-second fallback;
- shared 30-retry exhaustion across mixed recovery types;
- two product-page reloads followed by terminal failure;
- `409`, purchase-limit, `401`, `403`, visible challenge, and explicit out-of-stock handling;
- page replacement and bounded restoration of the exact product URL;
- authoritative evidence required before checkout;
- reuse of `CartEvidence` without duplicate confirmation;
- final price, item, and quantity safety rejection;
- explicit rejection versus ambiguous order-submission outcome.

Tests use fake timers or injected timing primitives rather than real sleeps. Integration fixtures mock Target page state and network responses. Test mode exercises the flow through order review while proving that Place Your Order is never clicked.

## Rollout

1. Implement the controller and deterministic tests behind the existing Target browser-checkout path.
2. Run repeated test-mode checkouts on ordinary in-stock items to validate state transitions, evidence handling, retry bounds, and timing.
3. Enable the aggressive profile for one high-demand Target account and inspect sanitized telemetry after each attempt.
4. Compare verified-cart rate, signal-to-cart latency, 429 frequency, challenge frequency, and terminal classifications against the existing baseline.
5. Expand only after confirming correct evidence freezing, no duplicate cart actions, and no checkout safety regressions.

## Out of scope

- Target mobile API reverse engineering or integration;
- copying or distributing Polar's obfuscated source;
- automated CAPTCHA or security-challenge solving;
- bypassing Target purchase limits, order controls, or retailer security protections;
- changes to non-Target retailer checkout flows;
- unrelated renderer, database, or account-management refactoring.
