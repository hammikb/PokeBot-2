# Checkout Observability Design

Date: 2026-08-15
Status: Approved design
Scope: Electron application only

## Goal

Make Target checkout failures and retries understandable from Electron's existing Checkout Analytics page without requiring raw log inspection. Preserve the current checkout behavior while adding local, structured, privacy-safe telemetry.

## Non-goals

- Do not change Target polling, cart retry limits, checkout behavior, or order submission behavior.
- Do not add Vercel dashboard features.
- Do not add or modify Supabase tables, uploads, or synchronization.
- Do not store account names, email addresses, cookies, proxy addresses, payment data, product URLs, response bodies, or other request secrets.
- Do not remove the existing text event timeline, traces, screenshots, or diagnostics.

## Architecture

The existing checkout telemetry pipeline remains the owner of checkout analytics. Target cart-attempt events and account-lease events gain an optional structured metadata object. `CheckoutTelemetry` sanitizes that object with a strict allowlist before writing it to the local checkout event row as JSON.

The analytics report parses the stored metadata and exposes a safe normalized object to the renderer. The existing Checkout Analytics page uses that object to build a compact milestone strip, a Target cart-attempt table, and account-contention details. Older attempts without metadata continue to render using their existing event timeline.

## Local data model

Add a nullable `metadata_json` column to `checkout_attempt_events` through the next local database migration. Add the same field to the JSON database table-column definition.

`metadata_json` may contain only these normalized fields:

- `eventType`: controlled identifier such as `cart_response` or `account_lease`
- `requestType`: controlled identifier such as `cart_mutation`
- `responseKind`: `success`, `rate_limit`, `session_error`, `transient`, or `no_response`
- `httpStatus`: integer from 100 through 599
- `retryKind`: controlled identifier such as `rate_limit`, `transient`, or `no_response`
- `attemptNumber`: positive bounded integer
- `retryNumber`: non-negative bounded integer
- `delayMs`: non-negative bounded integer
- `retryAfterHonored`: boolean
- `leaseState`: `acquired`, `busy`, or `released`
- `ownerRef`: short one-way hash, never a task ID, account ID, name, or email
- `heldMs`: non-negative bounded integer describing how long the successful owner held the lease

Unknown keys, nested objects, arrays, strings outside the controlled values, and values outside their numeric bounds are discarded. Invalid JSON and metadata from older rows normalize to an empty object.

This metadata remains local even when optional sanitized checkout analytics sharing is enabled. The remote telemetry payload continues to use its current schema and excludes local event metadata.

## Target cart event flow

`TargetCartAttemptController` already emits internal events for response classification and retry behavior. The Target flow will translate those events into checkout milestones with structured metadata while retaining the human-readable `onStep` messages.

Record the following:

- Each Add to cart click with its attempt number.
- Each classified cart mutation response with `responseKind` and `httpStatus` when present.
- Each scheduled retry with retry kind, retry number, delay, and whether Target's `Retry-After` value was honored.
- Product-page reloads caused by retry policy as retry events, without recording the product URL.

The response classifier remains restricted to `POST https://carts.target.com/web_checkouts/v1/cart_items`. Target telemetry requests and unrelated page requests cannot become cart response events.

## Failure classification

Use specific analytics failure codes:

- `cart_rate_limited` for Target cart HTTP 429 or an exhausted cart rate-limit path
- `cart_session_rejected` for Target cart HTTP 401 or 403
- `cart_no_response` when the cart mutation is not observed and its retry budget is exhausted
- `account_busy` when another local checkout owns the selected account
- `inventory` when the requested product is confirmed unavailable or out of stock
- `challenge` for captcha or anti-bot challenge states
- `browser_closed` for closed, destroyed, or detached browser lifecycle failures
- Existing `availability`, `payment`, `timeout`, `network`, and `unknown` codes remain available

Classification order must keep explicit cart failures ahead of generic `session`, `network`, and `timeout` matching. Historical rows are not rewritten; their displayed classification remains what was saved at completion.

## Account checkout lease events

The account checkout lease remains a runtime coordination mechanism in `TaskManager`. The local telemetry attempt begins before lease acquisition so both successful acquisition and an immediate busy rejection can be recorded.

- On acquisition, record `leaseState: acquired` with an anonymous owner reference.
- On contention, record `leaseState: busy` and the current anonymous owner reference, then complete the attempt with `account_busy` as its failure code.
- On normal release, record `leaseState: released` and the total lease hold duration.

No account name or stable account identifier is exposed to the analytics report. Owner references are useful only for correlating events inside local diagnostics.

The current execution path rejects a busy account immediately; this design does not add a checkout queue or change that behavior. The UI describes the event as an immediate contention rejection rather than implying that the task waited.

## Checkout Analytics UI

The expanded attempt view gains three progressively detailed sections:

1. A compact milestone strip showing the first occurrence and elapsed time of major stages: stock detected, browser ready, session verified, availability ready, cart attempted, cart ready, checkout opened, checkout ready, order submitted, and terminal outcome. Unreached stages remain muted.
2. A cart-attempt table for structured Target events. Columns show elapsed time, attempt, result, HTTP status, and retry delay. The table is omitted for attempts without cart metadata.
3. An account coordination summary when lease contention occurred, followed by the existing complete event timeline and local artifacts.

The page must remain readable for non-Target retailers and historical Target attempts. Empty structured sections are omitted rather than showing errors or placeholder tables.

## Compatibility and failure handling

- SQLite receives a forward-only additive migration for the nullable metadata column.
- The JSON database accepts the new field without rewriting existing rows.
- Telemetry storage errors remain non-fatal and must never interrupt checkout.
- Metadata serialization errors fall back to an empty metadata object while preserving the text event.
- Analytics report generation treats malformed or absent metadata as empty.
- The renderer treats missing metadata collections as empty arrays.

## Testing

Follow test-driven development for each behavior:

- Migration test proves existing checkout events remain readable and new metadata persists.
- Telemetry tests prove allowlisted values survive and sensitive, unknown, nested, or out-of-range values are discarded.
- Failure-classification tests cover Target cart 401, 403, 429, no-response exhaustion, inventory, challenge, and browser-closed errors.
- Target cart controller/flow tests prove cart response and retry metadata is emitted with correct counters and delays.
- TaskManager lease tests prove busy rejection, acquisition, and release events are recorded without account identity leakage.
- Analytics-report tests prove normalized cart attempts, milestone data, and lease summaries are produced while legacy attempts remain valid.
- Renderer tests prove structured sections render when available and remain absent for legacy/non-Target attempts.
- Run the focused suites first, then the full test suite, lint/type checks if configured, and the Electron production build.

## Success criteria

- A failed Target checkout can be diagnosed from Checkout Analytics as rate-limited, session-rejected, no-response, account-busy, inventory, challenge, or browser lifecycle failure.
- The user can see the sequence and timing of every Target cart attempt and retry without opening raw logs.
- Account contention is visible without exposing account identity.
- Existing checkout history and non-Target analytics continue to work.
- Checkout execution behavior is unchanged.
- No new checkout metadata is sent to Supabase or Vercel.
