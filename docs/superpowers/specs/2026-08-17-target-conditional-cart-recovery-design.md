# Target Conditional Cart Recovery Design

## Goal

Avoid issuing a duplicate Target Add to Cart click when the previous click produced no response but may have succeeded.

## Approved Behavior

- Run recovery only after an ambiguous `no-response` cart mutation outcome.
- Do not add a cart lookup to ordinary first attempts, explicit failures, or successful mutations.
- Give the recovery probe a strict 2,000 ms budget.
- Read the real cart for the exact requested TCIN; probable UI evidence alone is not authoritative.
- If the item is present, reuse the normal cart safety path to validate quantity and unit price before checkout.
- If the item is absent or the bounded probe cannot verify it, restore the warm product page and continue the existing retry loop.
- Never treat a timed-out or failed recovery probe as proof that the item is in the cart.
- Preserve the existing inventory, retry, reload, authentication, challenge, and order-submission safeguards.

## Architecture

`TargetCartAttemptController` owns the decision to invoke recovery because it already classifies the preceding outcome. It receives a `recoverAmbiguousCart` callback from the browser flow. The callback performs Target-specific navigation and cart reading, while the controller remains independent from Playwright details.

The callback returns authoritative cart state only when the requested TCIN is verified. The controller converts that state into its existing evidence result and returns it through the same downstream quantity and price validation path used by normal cart confirmation.

## Observability

Emit sanitized `ambiguous_cart_recovery` events with outcomes `present`, `absent`, or `timeout`. Do not include URLs, cookies, account details, or cart contents.

## Tests

- A no-response outcome invokes recovery before a second click and returns immediately when the item is present.
- An absent or timed-out recovery resumes normal retry behavior.
- Success, transient, rate-limit, and first-attempt paths do not invoke recovery.
- Events remain counter-only and sanitized.

