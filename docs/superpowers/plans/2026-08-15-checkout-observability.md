# Checkout Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe structured Target cart and account-lease diagnostics to Electron's existing Checkout Analytics page.

**Architecture:** Extend local checkout event rows with sanitized `metadata_json`, project that metadata into renderer-ready cart and lease summaries, and add focused pure React components to the existing expanded-attempt view. Keep checkout behavior and remote Supabase telemetry unchanged, and treat missing metadata as the legacy-compatible empty state.

**Tech Stack:** Electron, JavaScript ES modules, React 19, Tailwind CSS, Vitest, local SQLite/JSON database abstraction.

## Global Constraints

- Electron application only; do not add Vercel dashboard work.
- Do not add or modify Supabase tables, uploads, or synchronization.
- Structured metadata remains local even when optional analytics sharing is enabled.
- Never store account names, email addresses, cookies, proxy addresses, payment data, product URLs, response bodies, or request secrets.
- Preserve existing checkout execution, retry limits, order submission, text timelines, traces, screenshots, and diagnostics.
- Preserve all unrelated changes already present in the dirty worktree.
- Every production behavior must be preceded by a focused failing test.

---

### Task 1: Local checkout event metadata storage and sanitization

**Files:**
- Create: `src/main/telemetry/CheckoutEventMetadata.js`
- Create: `tests/main/telemetry/CheckoutEventMetadata.test.js`
- Modify: `src/main/db/migrations.js`
- Modify: `src/main/db.js`
- Modify: `tests/main/db.jsondb.test.js`

**Interfaces:**
- Produces: `sanitizeCheckoutEventMetadata(input): Record<string, string | number | boolean>`
- Produces: `parseCheckoutEventMetadata(value): Record<string, string | number | boolean>`
- Produces: migration version 18, `add_checkout_event_metadata`
- Produces: nullable `checkout_attempt_events.metadata_json`

- [ ] **Step 1: Write failing sanitizer tests**

Add tests proving controlled values survive and sensitive/unknown/nested/out-of-range data is removed:

```js
expect(
  sanitizeCheckoutEventMetadata({
    eventType: 'cart_response',
    requestType: 'cart_mutation',
    responseKind: 'session_error',
    httpStatus: 401,
    attemptNumber: 2,
    retryAfterHonored: false,
    productUrl: 'https://www.target.com/private',
    cookies: 'secret',
    nested: { token: 'secret' },
    delayMs: -1
  })
).toEqual({
  eventType: 'cart_response',
  requestType: 'cart_mutation',
  responseKind: 'session_error',
  httpStatus: 401,
  attemptNumber: 2,
  retryAfterHonored: false
})
expect(parseCheckoutEventMetadata('{bad')).toEqual({})
```

- [ ] **Step 2: Run the sanitizer test and verify RED**

Run: `npx vitest run tests/main/telemetry/CheckoutEventMetadata.test.js`

Expected: FAIL because `CheckoutEventMetadata.js` does not exist.

- [ ] **Step 3: Implement the strict metadata boundary**

Create immutable allowlists for `eventType`, `requestType`, `responseKind`, `retryKind`, and `leaseState`. Accept only booleans and bounded integers for the remaining fields. Return a new flat object and cap `attemptNumber`/`retryNumber` at 10,000 and duration values at 86,400,000 ms.

```js
export function parseCheckoutEventMetadata(value) {
  if (!value) return {}
  try {
    return sanitizeCheckoutEventMetadata(typeof value === 'string' ? JSON.parse(value) : value)
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run the sanitizer test and verify GREEN**

Run: `npx vitest run tests/main/telemetry/CheckoutEventMetadata.test.js`

Expected: PASS.

- [ ] **Step 5: Write failing local database compatibility tests**

In `db.jsondb.test.js`, insert an event containing `metadata_json`, reopen the JSON database, and assert both the metadata row and a legacy row without metadata remain readable. In `db.test.js`, inspect `PRAGMA table_info(checkout_attempt_events)` and require `metadata_json` so the native SQLite migration path is covered when available.

```js
expect(reopened.prepare('SELECT * FROM checkout_attempt_events WHERE id = ?').get('new-event'))
  .toMatchObject({ id: 'new-event', metadata_json: '{"eventType":"cart_response"}' })
expect(reopened.prepare('SELECT * FROM checkout_attempt_events WHERE id = ?').get('legacy-event'))
  .not.toHaveProperty('metadata_json')
expect(
  getDb().prepare('PRAGMA table_info(checkout_attempt_events)').all().map((column) => column.name)
).toContain('metadata_json')
```

- [ ] **Step 6: Run the database test and verify RED**

Run: `npx vitest run tests/main/db.jsondb.test.js`

Expected: FAIL because `metadata_json` is not an accepted event-table column.

- [ ] **Step 7: Add the local schema changes**

Add `metadata_json` to `TABLE_COLUMNS.checkout_attempt_events` in `db.js`. Add migration 18:

```js
{
  version: 18,
  name: 'add_checkout_event_metadata',
  up: (db) => {
    db.exec('ALTER TABLE checkout_attempt_events ADD COLUMN metadata_json TEXT;')
  }
}
```

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run: `npx vitest run tests/main/telemetry/CheckoutEventMetadata.test.js tests/main/db.jsondb.test.js tests/main/db.test.js`

Expected: PASS.

- [ ] **Step 9: Commit Task 1 only**

```powershell
git add -- src/main/telemetry/CheckoutEventMetadata.js tests/main/telemetry/CheckoutEventMetadata.test.js src/main/db/migrations.js src/main/db.js tests/main/db.jsondb.test.js
git commit -m "feat: store sanitized checkout event metadata"
```

### Task 2: Telemetry recording and analytics projection

**Files:**
- Modify: `src/main/telemetry/CheckoutTelemetry.js`
- Modify: `tests/main/telemetry/CheckoutTelemetry.test.js`

**Interfaces:**
- Consumes: `sanitizeCheckoutEventMetadata(input)` and `parseCheckoutEventMetadata(value)` from Task 1
- Changes: `CheckoutTelemetry.record(attemptId, stageOrMessage, detail = null, metadata = {})`
- Produces: `CheckoutTelemetry.recordLease(attemptId, leaseState, { ownerId, heldMs = null })`
- Produces per attempt: `milestones`, `cartAttempts`, and `leaseSummary`

- [ ] **Step 1: Write failing event persistence and privacy tests**

Create a local `JsonDb`, begin an attempt, call `record` with allowed and forbidden metadata, complete the attempt, and assert the stored `metadata_json` contains only allowed fields. Also assert pending remote event payloads do not include `metadata_json`.

```js
telemetry.record(attemptId, 'cart_attempted', 'Target response', {
  eventType: 'cart_response',
  requestType: 'cart_mutation',
  responseKind: 'rate_limit',
  httpStatus: 429,
  productUrl: 'https://www.target.com/private'
})
expect(JSON.parse(event.metadata_json)).toEqual({
  eventType: 'cart_response',
  requestType: 'cart_mutation',
  responseKind: 'rate_limit',
  httpStatus: 429
})
```

- [ ] **Step 2: Run the focused telemetry test and verify RED**

Run: `npx vitest run tests/main/telemetry/CheckoutTelemetry.test.js`

Expected: FAIL because `record` does not persist event metadata.

- [ ] **Step 3: Persist sanitized local metadata without changing remote rows**

Add sanitized metadata to the in-memory event buffer and include `metadata_json` in the local insert statement. Keep the existing Supabase event mapping explicit and omit `metadata_json` from remote inserts.

- [ ] **Step 4: Run the focused telemetry test and verify GREEN**

Run: `npx vitest run tests/main/telemetry/CheckoutTelemetry.test.js`

Expected: PASS for event persistence and remote-exclusion assertions.

- [ ] **Step 5: Write failing lease and analytics-projection tests**

Test `recordLease` hashing and report output. Feed `buildCheckoutAnalyticsReport` one legacy event and structured cart/lease events, then assert:

```js
expect(report.attempts[0].cartAttempts).toEqual([
  expect.objectContaining({ responseKind: 'rate_limit', httpStatus: 429, retryNumber: 1 })
])
expect(report.attempts[0].leaseSummary).toMatchObject({ contended: true, state: 'busy' })
expect(report.attempts[0].milestones.find((item) => item.stage === 'cart_attempted'))
  .toMatchObject({ reached: true, reachedMs: 1200 })
expect(report.attempts[1]).toMatchObject({ cartAttempts: [], leaseSummary: null })
```

Assert `ownerRef` is a short hash and differs from the supplied `ownerId`.

- [ ] **Step 6: Run the focused telemetry test and verify RED**

Run: `npx vitest run tests/main/telemetry/CheckoutTelemetry.test.js`

Expected: FAIL because lease recording and structured projections do not exist.

- [ ] **Step 7: Add lease recording and report projections**

Implement `recordLease` so raw owner IDs are hashed inside `CheckoutTelemetry` before they reach the sanitizer. In `buildAnalyticsAttempt`, parse each event's metadata and expose it on the safe event object. Derive:

- `milestones`: ordered major checkout stages with `reached`, `reachedMs`, and `durationMs`
- `cartAttempts`: cart-related structured events with elapsed time and safe metadata fields
- `leaseSummary`: latest lease state, whether contention occurred, owner reference, and hold duration

- [ ] **Step 8: Run Task 2 tests and verify GREEN**

Run: `npx vitest run tests/main/telemetry/CheckoutTelemetry.test.js tests/main/telemetry/CheckoutEventMetadata.test.js`

Expected: PASS.

- [ ] **Step 9: Commit Task 2 only**

```powershell
git add -- src/main/telemetry/CheckoutTelemetry.js tests/main/telemetry/CheckoutTelemetry.test.js
git commit -m "feat: project structured checkout analytics"
```

### Task 3: Target cart events and precise failure categories

**Files:**
- Modify: `src/main/automation/flows/target.js`
- Modify: `src/main/tasks/TaskManager.js`
- Modify: `src/main/telemetry/CheckoutTelemetry.js`
- Modify: `tests/main/automation/flows/target/TargetCartAttemptController.test.js`
- Modify: `tests/main/automation/flows/target-high-demand.test.js`
- Modify: `tests/main/telemetry/CheckoutTelemetry.test.js`

**Interfaces:**
- Consumes: `onMilestone(stage, detail, metadata = {})`
- Consumes: structured `TargetCartAttemptController.onEvent(event)` snapshots
- Produces: Target metadata events using the Task 1 allowlisted fields
- Produces failure codes: `cart_rate_limited`, `cart_session_rejected`, `cart_no_response`

- [ ] **Step 1: Write failing Target event tests**

Extend controller/flow tests to assert these sanitized event shapes are passed through milestones:

```js
expect(onMilestone).toHaveBeenCalledWith(
  'cart_attempted',
  expect.any(String),
  expect.objectContaining({
    eventType: 'cart_response',
    requestType: 'cart_mutation',
    responseKind: 'rate_limit',
    httpStatus: 429,
    attemptNumber: 1
  })
)
expect(onMilestone).toHaveBeenCalledWith(
  'cart_attempted',
  expect.any(String),
  expect.objectContaining({
    eventType: 'cart_retry',
    retryKind: 'rate_limit',
    retryNumber: 1,
    delayMs: 2000,
    retryAfterHonored: true
  })
)
```

- [ ] **Step 2: Run Target tests and verify RED**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target-high-demand.test.js`

Expected: FAIL because Target milestones do not include structured metadata.

- [ ] **Step 3: Map controller events into checkout milestones**

Extend both TaskManager `onMilestone` callbacks to forward a fourth `record` argument. In Target's browser cart `onEvent`, map:

- `cart_response_wait` to `cart_click`
- `outcome_classified` to `cart_response`
- `rate_limited`/`transient_recovery` to `cart_retry`
- `reloading_product` to `cart_reload`

Use the controller snapshot's `clickCount`, `retryCount`, status, delay, and retry-after flag. Do not include the product URL, TCIN, evidence response body, or account data.

- [ ] **Step 4: Run Target tests and verify GREEN**

Run the same two focused Target test files.

Expected: PASS.

- [ ] **Step 5: Write failing failure-classification tests**

Add exact assertions:

```js
expect(classifyCheckoutFailure('Target cart session rejected with HTTP 401', 'cart_attempted'))
  .toEqual({ code: 'cart_session_rejected', stage: 'cart_attempted' })
expect(classifyCheckoutFailure('Target cart session rejected with HTTP 403', 'cart_attempted'))
  .toEqual({ code: 'cart_session_rejected', stage: 'cart_attempted' })
expect(classifyCheckoutFailure('Target rate limited Add to cart; HTTP 429', 'cart_attempted'))
  .toEqual({ code: 'cart_rate_limited', stage: 'cart_attempted' })
expect(classifyCheckoutFailure('Target cart acquisition exhausted no-response-limit', 'cart_attempted'))
  .toEqual({ code: 'cart_no_response', stage: 'cart_attempted' })
expect(classifyCheckoutFailure('Requested item is out of stock', 'availability_ready'))
  .toEqual({ code: 'inventory', stage: 'availability_ready' })
expect(classifyCheckoutFailure('Target captcha challenge detected', 'session_checked'))
  .toEqual({ code: 'challenge', stage: 'session_checked' })
expect(classifyCheckoutFailure('Browser context closed', 'checkout_opened'))
  .toEqual({ code: 'browser_closed', stage: 'checkout_opened' })
```

- [ ] **Step 6: Run failure-classification tests and verify RED**

Run: `npx vitest run tests/main/telemetry/CheckoutTelemetry.test.js`

Expected: FAIL with current `unknown`/generic classifications.

- [ ] **Step 7: Add explicit cart failure precedence**

Place exact Target cart checks before generic challenge/session/inventory/high-demand checks in `classifyCheckoutFailure`. Preserve all existing codes for non-cart messages.

- [ ] **Step 8: Run Task 3 tests and verify GREEN**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/telemetry/CheckoutTelemetry.test.js`

Expected: PASS.

- [ ] **Step 9: Commit Task 3 only**

```powershell
git add -- src/main/automation/flows/target.js src/main/tasks/TaskManager.js src/main/telemetry/CheckoutTelemetry.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/telemetry/CheckoutTelemetry.test.js
git commit -m "feat: classify Target cart retries and failures"
```

### Task 4: Account checkout lease observability

**Files:**
- Modify: `src/main/tasks/TaskManager.js`
- Modify: `src/main/telemetry/CheckoutTelemetry.js`
- Modify: `tests/main/tasks/AccountCheckoutLease.test.js`
- Modify: `tests/main/telemetry/CheckoutTelemetry.test.js`

**Interfaces:**
- Consumes: `CheckoutTelemetry.recordLease(attemptId, leaseState, { ownerId, heldMs })`
- Produces: terminal `account_busy` attempts for immediate lease contention
- Preserves: the existing no-wait account lease policy and manual/test browser ownership

- [ ] **Step 1: Write failing busy-attempt test**

Arrange an existing lease, invoke `_runFlowForAccount`, and assert telemetry begins before lease acquisition, records a busy lease event, and completes the attempt:

```js
expect(telemetry.recordLease).toHaveBeenCalledWith(
  'attempt-2',
  'busy',
  expect.objectContaining({ ownerId: existingOwnerId })
)
expect(telemetry.completeAttempt).toHaveBeenCalledWith(
  'attempt-2',
  expect.objectContaining({ error: expect.stringContaining('Account is busy') })
)
```

The resulting classification assertion must be `account_busy` and no account name or ID may appear in metadata.

- [ ] **Step 2: Run the lease test and verify RED**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js`

Expected: FAIL because busy returns before telemetry begins.

- [ ] **Step 3: Begin telemetry before lease acquisition and complete busy attempts**

Move `beginAttempt` ahead of `acquireAccountCheckout`. On contention, call `recordLease(..., 'busy', ...)`, complete the attempt with the existing sanitized busy error, and return the existing `{ accountBusy: true }` result. Add `account_busy` classification ahead of generic matching.

- [ ] **Step 4: Run the busy lease test and verify GREEN**

Run the same focused lease test.

Expected: PASS.

- [ ] **Step 5: Write failing acquisition/release lifecycle test**

Use a deterministic clock or the lease's stored `acquiredAt`. Assert acquisition is recorded after a successful lease and normal release is recorded before telemetry completion with bounded `heldMs`. Also assert preserved test/manual sessions do not falsely record release.

- [ ] **Step 6: Run the lease lifecycle test and verify RED**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js`

Expected: FAIL because acquisition/release telemetry is absent.

- [ ] **Step 7: Record lease lifecycle without changing ownership behavior**

Record `acquired` immediately after successful acquisition. Before normal release, record `released` with `Date.now() - acquiredAt`. Keep leases preserved for `testMode` and `requiresManualCheckout` exactly as they are now; their eventual context-close cleanup must not write into an already completed attempt.

- [ ] **Step 8: Run Task 4 tests and verify GREEN**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js tests/main/tasks/TaskManager.test.js`

Expected: PASS.

- [ ] **Step 9: Commit Task 4 only**

```powershell
git add -- src/main/tasks/TaskManager.js tests/main/tasks/AccountCheckoutLease.test.js src/main/telemetry/CheckoutTelemetry.js tests/main/telemetry/CheckoutTelemetry.test.js
git commit -m "feat: record checkout account contention"
```

### Task 5: Checkout Analytics observability components

**Files:**
- Create: `src/renderer/src/components/CheckoutAttemptObservability.jsx`
- Create: `tests/renderer/CheckoutAttemptObservability.test.js`
- Modify: `src/renderer/src/pages/CheckoutAnalytics.jsx`

**Interfaces:**
- Consumes: `attempt.milestones`, `attempt.cartAttempts`, and `attempt.leaseSummary` from Task 2
- Produces: `CheckoutAttemptObservability({ attempt })`
- Preserves: the existing event timeline, failure panel, experiment badges, and artifacts

- [ ] **Step 1: Write failing pure renderer tests**

Use `renderToStaticMarkup` to assert the component renders structured data:

```jsx
const html = renderToStaticMarkup(
  <CheckoutAttemptObservability
    attempt={{
      milestones: [
        { stage: 'drop_detected', reached: true, reachedMs: 0 },
        { stage: 'cart_ready', reached: false, reachedMs: null }
      ],
      cartAttempts: [
        {
          elapsedMs: 1200,
          attemptNumber: 1,
          responseKind: 'rate_limit',
          httpStatus: 429,
          delayMs: 2000
        }
      ],
      leaseSummary: { contended: true, state: 'busy', heldMs: null }
    }}
  />
)
expect(html).toContain('429')
expect(html).toContain('Rate limit')
expect(html).toContain('Account busy')
```

Add a legacy test asserting empty arrays/null render no cart table or account summary and do not throw.

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `npx vitest run tests/renderer/CheckoutAttemptObservability.test.js`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused observability component**

Build three internal sections:

- `MilestoneStrip`: ordered compact stage pills with elapsed times and muted unreached stages
- `CartAttemptTable`: elapsed time, attempt/retry number, normalized result, HTTP status, and retry delay
- `LeaseSummary`: immediate account-busy rejection or normal lease-hold duration

Use existing dark theme colors and plain text labels. Omit the cart and lease sections when their data is absent.

- [ ] **Step 4: Run the renderer test and verify GREEN**

Run: `npx vitest run tests/renderer/CheckoutAttemptObservability.test.js`

Expected: PASS.

- [ ] **Step 5: Write failing integration assertion for the expanded attempt view**

Export `AttemptDetails` from `CheckoutAnalytics.jsx` for testing or render it through a small pure wrapper. Assert `CheckoutAttemptObservability` output appears before `Event timeline` and that the existing artifacts and text events remain present.

- [ ] **Step 6: Run the renderer tests and verify RED**

Run: `npx vitest run tests/renderer/CheckoutAttemptObservability.test.js`

Expected: FAIL because the expanded view does not mount the new component.

- [ ] **Step 7: Integrate with Checkout Analytics**

Import and render `<CheckoutAttemptObservability attempt={attempt} />` at the start of the expanded details area. Do not change filters, loading behavior, artifact paths, or the existing full event timeline.

- [ ] **Step 8: Run Task 5 tests and verify GREEN**

Run: `npx vitest run tests/renderer/CheckoutAttemptObservability.test.js tests/renderer/MonitorBuilder.test.js tests/renderer/time.test.js`

Expected: PASS.

- [ ] **Step 9: Commit Task 5 only**

```powershell
git add -- src/renderer/src/components/CheckoutAttemptObservability.jsx tests/renderer/CheckoutAttemptObservability.test.js src/renderer/src/pages/CheckoutAnalytics.jsx
git commit -m "feat: show checkout attempt diagnostics"
```

### Task 6: End-to-end verification and compatibility audit

**Files:**
- Modify only if verification exposes an in-scope defect in files listed above.

**Interfaces:**
- Consumes: all Task 1-5 interfaces
- Produces: verified Electron build with local-only structured analytics

- [ ] **Step 1: Run all focused observability suites**

Run:

```powershell
npx vitest run tests/main/telemetry/CheckoutEventMetadata.test.js tests/main/telemetry/CheckoutTelemetry.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/tasks/AccountCheckoutLease.test.js tests/renderer/CheckoutAttemptObservability.test.js
```

Expected: PASS with no warnings caused by the new work.

- [ ] **Step 2: Run database and TaskManager regression suites**

Run:

```powershell
npx vitest run tests/main/db.jsondb.test.js tests/main/db.test.js tests/main/tasks/TaskManager.test.js
```

Expected: PASS.

- [ ] **Step 3: Run the complete automated test suite**

Run: `npm test`

Expected: all test files and tests PASS.

- [ ] **Step 4: Run lint without altering unrelated files**

Run: `npm run lint -- --no-cache`

Expected: exit 0. If pre-existing unrelated failures exist, record them separately and run ESLint directly on changed source/test files.

- [ ] **Step 5: Build and verify Electron preload**

Run: `npm run test:electron`

Expected: Electron production build succeeds and preload verification passes.

- [ ] **Step 6: Audit local-only boundaries**

Run:

```powershell
rg -n "metadata_json|ownerRef|cartAttempts|leaseSummary" src/main src/renderer
rg -n "metadata_json" supabase
```

Expected: the first command finds the local database/telemetry/renderer implementation; the second finds no new Supabase schema or upload usage.

- [ ] **Step 7: Review the final diff for unrelated edits and sensitive data**

Run:

```powershell
git diff --check
git status --short
git diff -- src/main/telemetry src/main/automation/flows/target.js src/main/tasks/TaskManager.js src/main/db.js src/main/db/migrations.js src/renderer/src/pages/CheckoutAnalytics.jsx src/renderer/src/components/CheckoutAttemptObservability.jsx tests
```

Expected: no whitespace errors, no secrets/URLs/account identities added to analytics metadata, and unrelated dirty-worktree changes remain untouched.

- [ ] **Step 8: Commit any verification-only correction**

If verification required an in-scope correction, stage only the corrected files and commit with `fix: complete checkout observability verification`. If no correction was required, do not create an empty commit.
