# Target Polar-Like Cart Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Target's conservative browser Add to Cart loop with a response-aware, Polar-like controller that clicks immediately, polls at 100 ms, uses bounded fast retries, freezes on probable success, and returns authoritative cart evidence without duplicate confirmation.

**Architecture:** Add a pure orchestration module for retry budgets and state transitions, plus a Target page-signal adapter for Playwright locators, response classification, and visible evidence. Keep account/session, quantity selection, CAPTCHA handling, authoritative cart parsing, checkout safety, and order submission in the existing Target flow; `browserAddToCart` wires those dependencies into the controller and returns `CartEvidence` to `runTargetFlow`.

**Tech Stack:** Electron, JavaScript ES modules, Playwright Core 1.60, Vitest 4, existing `TargetPageCoordinator`, existing Target checkout safety and diagnostics.

## Global Constraints

- Production high-demand Target cart acquisition is browser-only; do not call Target's internal cart API from the new controller.
- Intentional Add to Cart pre-click delay is exactly 0 ms; Playwright actionability remains enabled.
- Critical button polling and reacquisition cadence is 100 ms.
- Outcome observation window is 1,500 ms.
- Allow at most four additional no-response clicks per loaded product document.
- Wait 400 ms after a recognized transient modal without a captured HTTP 429.
- Honor a valid `Retry-After` after HTTP 429; otherwise wait 1,500 ms.
- Allow at most 30 additional recoverable clicks, two product-page reloads, and 120 seconds per cart-acquisition run.
- A reload resets only the per-document no-response allowance; it never resets global retry, reload, or deadline budgets.
- Freeze clicking on probable success; checkout requires the exact requested TCIN and quantity in authoritative cart evidence.
- Preserve purchase limits, explicit out-of-stock handling, manual challenge handling, price/quantity safety checks, and ambiguous-submission protections.
- Do not copy Polar source, automate CAPTCHA solving, bypass retailer controls, log secrets, or include unrelated dirty-worktree changes in commits.
- Existing modifications in `src/main/automation/flows/target.js` and `tests/main/automation/flows/target-high-demand.test.js` are part of the working baseline. Review their diff before the first commit that includes either file.

---

## File Structure

- Create `src/main/automation/flows/target/TargetCartPolicy.js`: immutable timing policy, `Retry-After` parsing, retry/reload/deadline accounting, and typed budget errors.
- Create `src/main/automation/flows/target/TargetCartSignals.js`: Target-specific Add to Cart locator, probable-success detector, cart-response matcher/classifier, and response-before-click observation.
- Create `src/main/automation/flows/target/TargetCartAttemptController.js`: state-machine orchestration using injected page operations; no Target selectors or checkout navigation.
- Create `src/main/automation/flows/target/TargetCartEvidence.js`: normalize returned `CartEvidence` into the existing checkout-safety cart-state shape without re-reading the cart.
- Create `tests/main/automation/flows/target/TargetCartPolicy.test.js`: deterministic policy and budget tests.
- Create `tests/main/automation/flows/target/TargetCartSignals.test.js`: Playwright-facing response/evidence tests with mocked locators and responses.
- Create `tests/main/automation/flows/target/TargetCartAttemptController.test.js`: fake-clock state-machine tests for every retry and terminal path.
- Create `tests/main/automation/flows/target/TargetCartEvidence.test.js`: evidence-handoff tests proving the fallback parser is skipped when authoritative evidence exists.
- Modify `src/main/automation/flows/target.js`: wire the controller to the existing warm page, quantity selection, CAPTCHA handling, cart parser, checkout safety, and structured logger; reuse returned `CartEvidence`.
- Modify `tests/main/automation/flows/target-high-demand.test.js`: replace the 3-6 second expectation with integration assertions for 1.5-second 429 recovery, same-page reuse, 100 ms readiness, and evidence handoff.
- Modify `tests/main/automation/flows/submission-safety.test.js`: retain proof that aggressive cart acquisition cannot increase order-submission attempts.

---

### Task 1: Fixed Policy and Retry Budgets

**Files:**
- Create: `src/main/automation/flows/target/TargetCartPolicy.js`
- Create: `tests/main/automation/flows/target/TargetCartPolicy.test.js`

**Interfaces:**
- Consumes: millisecond timestamps and raw `Retry-After` header values.
- Produces: `TARGET_CART_STRATEGY`, `TARGET_CART_POLICY`, `TargetCartBudget`, `TargetCartBudgetError`, and `parseTargetRetryAfterMs(rawValue, nowMs)`.

- [ ] **Step 1: Write the failing policy tests**

```js
import { describe, expect, it } from 'vitest'
import {
  TARGET_CART_POLICY,
  TARGET_CART_STRATEGY,
  TargetCartBudget,
  TargetCartBudgetError,
  parseTargetRetryAfterMs
} from '../../../../../src/main/automation/flows/target/TargetCartPolicy.js'

describe('TargetCartPolicy', () => {
  it('uses the approved Polar-like limits', () => {
    expect(TARGET_CART_STRATEGY).toBe('browser')
    expect(TARGET_CART_POLICY).toEqual({
      pollMs: 100,
      outcomeMs: 1500,
      transientDelayMs: 400,
      rateLimitDelayMs: 1500,
      maxNoResponseRetriesPerDocument: 4,
      maxRecoverableRetries: 30,
      maxReloads: 2,
      deadlineMs: 120000
    })
  })

  it('parses delta-seconds and HTTP-date Retry-After values', () => {
    const now = Date.parse('2026-08-10T12:00:00.000Z')
    expect(parseTargetRetryAfterMs('2', now)).toBe(2000)
    expect(parseTargetRetryAfterMs('Mon, 10 Aug 2026 12:00:03 GMT', now)).toBe(3000)
    expect(parseTargetRetryAfterMs('invalid', now)).toBeNull()
  })

  it('counts only additional clicks as recoverable retries', () => {
    const budget = new TargetCartBudget({ startedAt: 1000 })
    budget.authorizeClick(null, 1000)
    budget.authorizeClick('no-response', 1100)
    expect(budget.snapshot()).toMatchObject({
      clickCount: 2,
      retryCount: 1,
      noResponseRetries: 1,
      reloadCount: 0
    })
  })

  it('resets only the per-document no-response count after reload', () => {
    const budget = new TargetCartBudget({ startedAt: 1000 })
    budget.authorizeClick(null, 1000)
    budget.authorizeClick('no-response', 1100)
    budget.recordReload(1200)
    expect(budget.snapshot()).toMatchObject({
      clickCount: 2,
      retryCount: 1,
      noResponseRetries: 0,
      reloadCount: 1
    })
  })

  it('throws precise codes for no-response, retry, reload, and deadline exhaustion', () => {
    const noResponse = new TargetCartBudget({
      startedAt: 0,
      policy: { ...TARGET_CART_POLICY, maxNoResponseRetriesPerDocument: 1 }
    })
    noResponse.authorizeClick(null, 0)
    noResponse.authorizeClick('no-response', 1)
    expect(() => noResponse.authorizeClick('no-response', 2)).toThrowError(
      expect.objectContaining({ code: 'no-response-limit' })
    )

    const retries = new TargetCartBudget({
      startedAt: 0,
      policy: { ...TARGET_CART_POLICY, maxRecoverableRetries: 1 }
    })
    retries.authorizeClick(null, 0)
    retries.authorizeClick('transient', 1)
    expect(() => retries.authorizeClick('rate-limit', 2)).toThrowError(
      expect.objectContaining({ code: 'retry-limit' })
    )

    const reloads = new TargetCartBudget({
      startedAt: 0,
      policy: { ...TARGET_CART_POLICY, maxReloads: 1 }
    })
    reloads.recordReload(1)
    expect(() => reloads.recordReload(2)).toThrowError(
      expect.objectContaining({ code: 'reload-limit' })
    )

    const deadline = new TargetCartBudget({ startedAt: 0 })
    expect(() => deadline.assertTimeRemaining(120000)).toThrowError(
      expect.objectContaining({ code: 'deadline' })
    )
    expect(TargetCartBudgetError.prototype).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartPolicy.test.js`

Expected: FAIL because `TargetCartPolicy.js` does not exist.

- [ ] **Step 3: Implement the fixed policy and mutable budget**

```js
export const TARGET_CART_STRATEGY = 'browser'

export const TARGET_CART_POLICY = Object.freeze({
  pollMs: 100,
  outcomeMs: 1500,
  transientDelayMs: 400,
  rateLimitDelayMs: 1500,
  maxNoResponseRetriesPerDocument: 4,
  maxRecoverableRetries: 30,
  maxReloads: 2,
  deadlineMs: 120000
})

export class TargetCartBudgetError extends Error {
  constructor(code, snapshot) {
    super(`Target cart acquisition exhausted ${code}`)
    this.name = 'TargetCartBudgetError'
    this.code = code
    this.snapshot = snapshot
  }
}

export function parseTargetRetryAfterMs(rawValue, nowMs = Date.now()) {
  const value = String(rawValue ?? '').trim()
  if (!value) return null
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000))
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null
}

export class TargetCartBudget {
  constructor({ startedAt, policy = TARGET_CART_POLICY }) {
    this.startedAt = startedAt
    this.policy = policy
    this.clickCount = 0
    this.retryCount = 0
    this.noResponseRetries = 0
    this.reloadCount = 0
  }

  snapshot(nowMs = this.startedAt) {
    return {
      clickCount: this.clickCount,
      retryCount: this.retryCount,
      noResponseRetries: this.noResponseRetries,
      reloadCount: this.reloadCount,
      elapsedMs: Math.max(0, nowMs - this.startedAt)
    }
  }

  assertTimeRemaining(nowMs) {
    if (nowMs - this.startedAt >= this.policy.deadlineMs) {
      throw new TargetCartBudgetError('deadline', this.snapshot(nowMs))
    }
  }

  authorizeClick(retryKind, nowMs) {
    this.assertTimeRemaining(nowMs)
    if (retryKind !== null) {
      if (this.retryCount >= this.policy.maxRecoverableRetries) {
        throw new TargetCartBudgetError('retry-limit', this.snapshot(nowMs))
      }
      if (
        retryKind === 'no-response' &&
        this.noResponseRetries >= this.policy.maxNoResponseRetriesPerDocument
      ) {
        throw new TargetCartBudgetError('no-response-limit', this.snapshot(nowMs))
      }
      this.retryCount += 1
      if (retryKind === 'no-response') this.noResponseRetries += 1
    }
    this.clickCount += 1
  }

  canRetryNoResponse() {
    return this.noResponseRetries < this.policy.maxNoResponseRetriesPerDocument
  }

  recordReload(nowMs) {
    this.assertTimeRemaining(nowMs)
    if (this.reloadCount >= this.policy.maxReloads) {
      throw new TargetCartBudgetError('reload-limit', this.snapshot(nowMs))
    }
    this.reloadCount += 1
    this.noResponseRetries = 0
  }
}
```

- [ ] **Step 4: Run the policy tests**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartPolicy.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the policy unit**

```powershell
git add -- src/main/automation/flows/target/TargetCartPolicy.js tests/main/automation/flows/target/TargetCartPolicy.test.js
git commit -m "feat: define Target cart retry budgets"
```

---

### Task 2: Target Page Signals and Response Classification

**Files:**
- Create: `src/main/automation/flows/target/TargetCartSignals.js`
- Create: `tests/main/automation/flows/target/TargetCartSignals.test.js`

**Interfaces:**
- Consumes: a Playwright `page`, live button locator, requested TCIN, 1,500 ms outcome window, and `now()` clock.
- Produces: `getVisibleTargetAddToCartButton(page, tcin)`, `getTargetProbableCartEvidence(page, tcin)`, `isTargetCartMutationResponse(response)`, and `clickAndObserveTargetCart({ page, button, tcin, outcomeMs, now })` returning `{ kind, status, retryAfterMs, evidence }`.

- [ ] **Step 1: Write failing response and evidence tests**

```js
import { describe, expect, it, vi } from 'vitest'
import {
  clickAndObserveTargetCart,
  getTargetProbableCartEvidence,
  getVisibleTargetAddToCartButton
} from '../../../../../src/main/automation/flows/target/TargetCartSignals.js'

function response(status, retryAfter = null) {
  return {
    status: () => status,
    url: () => 'https://carts.target.com/web_checkouts/v1/cart_items',
    request: () => ({ method: () => 'POST' }),
    headers: () => (retryAfter === null ? {} : { 'retry-after': retryAfter })
  }
}

describe('TargetCartSignals', () => {
  it('includes exact-TCIN and visible fulfillment selectors', () => {
    const result = { first: vi.fn(() => ({ id: 'button' })) }
    const page = { locator: vi.fn(() => result) }
    expect(getVisibleTargetAddToCartButton(page, '123456')).toEqual({ id: 'button' })
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('123456'))
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining(':visible'))
  })

  it('arms the response wait before clicking and classifies 2xx as probable success', async () => {
    const order = []
    const page = {
      waitForResponse: vi.fn(() => {
        order.push('armed')
        return Promise.resolve(response(200))
      }),
      locator: vi.fn(() => ({ first: () => ({ isVisible: async () => false }) }))
    }
    const button = { click: vi.fn(async () => order.push('clicked')) }
    const result = await clickAndObserveTargetCart({ page, button, tcin: '123456' })
    expect(order).toEqual(['armed', 'clicked'])
    expect(result).toMatchObject({
      kind: 'success',
      status: 200,
      evidence: { source: 'mutation-2xx', mutationStatus: 200 }
    })
  })

  it('parses Retry-After and separates 429 from a transient modal', async () => {
    const page429 = {
      waitForResponse: vi.fn(async () => response(429, '2')),
      locator: vi.fn(() => ({ first: () => ({ isVisible: async () => false }) }))
    }
    const button = { click: vi.fn(async () => {}) }
    await expect(
      clickAndObserveTargetCart({ page: page429, button, tcin: '123456', now: () => 1000 })
    ).resolves.toMatchObject({ kind: 'rate-limit', status: 429, retryAfterMs: 2000 })

    const pageModal = {
      waitForResponse: vi.fn(async () => null),
      locator: vi.fn((selector) => ({
        first: () => ({ isVisible: async () => selector.includes('High-demand item') })
      }))
    }
    await expect(
      clickAndObserveTargetCart({ page: pageModal, button, tcin: '123456' })
    ).resolves.toMatchObject({ kind: 'transient', status: null })
  })

  it('finds visible Added to cart evidence before another click', async () => {
    const page = {
      locator: vi.fn(() => ({ first: () => ({ isVisible: async () => true }) }))
    }
    await expect(getTargetProbableCartEvidence(page, '123456')).resolves.toEqual({
      source: 'visible-added-to-cart',
      mutationStatus: null
    })
  })

  it.each([
    [401, 'session-error'],
    [403, 'session-error'],
    [409, 'success'],
    [503, 'transient']
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const page = {
      waitForResponse: vi.fn(async () => response(status)),
      locator: vi.fn(() => ({ first: () => ({ isVisible: async () => false }) }))
    }
    const button = { click: vi.fn(async () => {}) }
    await expect(clickAndObserveTargetCart({ page, button, tcin: '123456' })).resolves.toMatchObject({
      kind,
      status
    })
  })
})
```

- [ ] **Step 2: Run the tests and verify the signals module is missing**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartSignals.test.js`

Expected: FAIL because `TargetCartSignals.js` does not exist.

- [ ] **Step 3: Implement the selectors, evidence detector, and response-before-click operation**

Use these exported constants and classification rules:

```js
import { parseTargetRetryAfterMs } from './TargetCartPolicy.js'

export const TARGET_ADD_TO_CART_SELECTOR = [
  'button[data-test="@web/AddToCartButton"]:visible',
  'button[data-test="orderPickupButton"]:visible',
  'button[data-test="preorderButton"]:visible',
  'button:visible:has-text("Add to cart")'
].join(', ')

const PROBABLE_SUCCESS_SELECTOR = [
  '[role="dialog"]:has-text("Added to cart")',
  '[data-test*="addToCartModal" i]',
  '[data-test*="cartPrompt" i]:has-text("View cart")',
  'button:visible:has-text("In cart")'
].join(', ')

const TRANSIENT_CART_DIALOG_SELECTOR = [
  '[role="dialog"]:has-text("High-demand item")',
  '[role="dialog"]:has-text("popular item in your cart is causing a delay")',
  '[role="dialog"]:has-text("little busier than we expected")',
  '[role="dialog"]:has-text("temporary issue")',
  '[role="dialog"]:has-text("high demand")',
  '[role="dialog"]:has-text("could not add")'
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
    ? `[role="dialog"]:has(a[href*="${String(tcin)}"]):has-text("cart")`
    : null
  const selector = [exactPromptSelector, PROBABLE_SUCCESS_SELECTOR].filter(Boolean).join(', ')
  const visible = await page.locator(selector).first().isVisible().catch(() => false)
  return visible ? { source: 'visible-added-to-cart', mutationStatus: null } : null
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
  await button.click({ timeout: 5000 })
  const response = await responsePromise
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
```

Keep `waitForResponse` creation above `button.click`. Do not add `force: true`, mouse-coordinate clicking, request routing, or an artificial pre-click sleep.

- [ ] **Step 4: Run the signals tests**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartSignals.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the page-signal unit**

```powershell
git add -- src/main/automation/flows/target/TargetCartSignals.js tests/main/automation/flows/target/TargetCartSignals.test.js
git commit -m "feat: classify Target cart click outcomes"
```

---

### Task 3: Polar-Like Cart Attempt Controller

**Files:**
- Create: `src/main/automation/flows/target/TargetCartAttemptController.js`
- Create: `tests/main/automation/flows/target/TargetCartAttemptController.test.js`
- Modify: `src/main/automation/flows/target/TargetCartPolicy.js`
- Modify: `tests/main/automation/flows/target/TargetCartPolicy.test.js`

**Interfaces:**
- Consumes: `acquireButton`, `getProbableEvidence`, `clickAndObserve`, `verifyCart`, `dismissTransient`, `restoreProduct`, `isProductPageValid`, `sleep`, `now`, and `onEvent` callbacks.
- Produces: `runTargetCartAttempt(options): Promise<CartEvidence>`, where `CartEvidence` is `{ tcin, quantity, unitPrice, source, mutationStatus, clickCount, retryCount, reloadCount, confirmedAt }`.

- [ ] **Step 1: Add failing controller tests with a fake clock**

Create a fixture that advances time only when the controller calls `sleep`:

```js
function harness(outcomes, { verification = { present: true, quantity: 1, unitPrice: 19.99 } } = {}) {
  let nowMs = 1000
  let productValid = true
  const sleeps = []
  const buttons = []
  const events = []
  const acquireButton = vi.fn(async () => {
    const button = { click: vi.fn(async () => {}) }
    buttons.push(button)
    return button
  })
  return {
    options: {
      tcin: '123456',
      requestedQuantity: 1,
      productUrl: 'https://www.target.com/p/example/-/A-123456',
      now: () => nowMs,
      sleep: vi.fn(async (ms) => {
        sleeps.push(ms)
        nowMs += ms
      }),
      acquireButton,
      getProbableEvidence: vi.fn(async () => null),
      clickAndObserve: vi.fn(async () => outcomes.shift()),
      verifyCart: vi.fn(async () => verification),
      dismissTransient: vi.fn(async () => {}),
      restoreProduct: vi.fn(async () => {
        productValid = true
      }),
      isProductPageValid: vi.fn(async () => productValid),
      onEvent: vi.fn((event) => events.push(event))
    },
    sleeps,
    buttons,
    events,
    setProductValid(value) {
      productValid = value
    }
  }
}
```

Add these exact behaviors:

```js
it('returns authoritative evidence after one immediate successful click', async () => {
  const h = harness([{ kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }])
  await expect(runTargetCartAttempt(h.options)).resolves.toMatchObject({
    tcin: '123456',
    quantity: 1,
    unitPrice: 19.99,
    source: 'mutation-2xx',
    mutationStatus: 200,
    clickCount: 1,
    retryCount: 0,
    reloadCount: 0
  })
  expect(h.sleeps).toEqual([])
})

it('uses four additional no-response clicks then reloads the product once', async () => {
  const noResponse = { kind: 'no-response', status: null, evidence: null }
  const success = { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
  const h = harness([noResponse, noResponse, noResponse, noResponse, noResponse, success])
  const result = await runTargetCartAttempt(h.options)
  expect(h.options.clickAndObserve).toHaveBeenCalledTimes(6)
  expect(h.options.restoreProduct).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ clickCount: 6, retryCount: 5, reloadCount: 1 })
})

it('waits 400 ms for a transient modal and 1500 ms for 429 without Retry-After', async () => {
  const h = harness([
    { kind: 'transient', status: null, evidence: null },
    { kind: 'rate-limit', status: 429, retryAfterMs: null, evidence: null },
    { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
  ])
  await runTargetCartAttempt(h.options)
  expect(h.sleeps).toEqual([400, 1500])
  expect(h.options.dismissTransient).toHaveBeenCalledTimes(2)
})

it('honors Retry-After only when it fits the remaining deadline', async () => {
  const h = harness([
    { kind: 'rate-limit', status: 429, retryAfterMs: 2000, evidence: null },
    { kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }
  ])
  await runTargetCartAttempt(h.options)
  expect(h.sleeps).toEqual([2000])

  const tooLong = harness([{ kind: 'rate-limit', status: 429, retryAfterMs: 120000, evidence: null }])
  await expect(runTargetCartAttempt(tooLong.options)).rejects.toMatchObject({ code: 'deadline' })
})

it('checks probable evidence before acquiring another button', async () => {
  const h = harness([{ kind: 'no-response', status: null, evidence: null }])
  h.options.getProbableEvidence
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ source: 'visible-added-to-cart', mutationStatus: null })
  const result = await runTargetCartAttempt(h.options)
  expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
  expect(result.source).toBe('visible-added-to-cart')
})

it('stops on session errors and emits sanitized counter-only events', async () => {
  const h = harness([{ kind: 'session-error', status: 403, evidence: null }])
  await expect(runTargetCartAttempt(h.options)).rejects.toThrow('Target cart session rejected with HTTP 403')
  expect(h.events.every((event) => !('url' in event) && !('email' in event))).toBe(true)
})
```

Add this terminal pass-through test; retry, reload, and deadline exhaustion receive their full matrix in Task 6:

```js
it.each([
  ['Item is out of stock (Target availability settled)'],
  ['Target security challenge did not clear before fulfillment timeout']
])('passes through terminal readiness error: %s', async (message) => {
  const h = harness([])
  h.options.acquireButton.mockRejectedValueOnce(new Error(message))
  await expect(runTargetCartAttempt(h.options)).rejects.toThrow(message)
  expect(h.options.clickAndObserve).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the controller tests and verify the module is missing**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartAttemptController.test.js`

Expected: FAIL because `TargetCartAttemptController.js` does not exist.

- [ ] **Step 3: Add a public deadline guard to the budget**

Add this method to `TargetCartBudget` and test it with a delay that ends exactly at the deadline:

```js
assertDelayFits(delayMs, nowMs) {
  this.assertTimeRemaining(nowMs)
  if (nowMs + Math.max(0, delayMs) - this.startedAt >= this.policy.deadlineMs) {
    throw new TargetCartBudgetError('deadline', this.snapshot(nowMs))
  }
}
```

- [ ] **Step 4: Implement the controller with injected operations**

Use this control structure. Keep all Target selectors and navigation outside this file.

```js
import {
  TARGET_CART_POLICY,
  TargetCartBudget,
  TargetCartBudgetError
} from './TargetCartPolicy.js'

export async function runTargetCartAttempt({
  tcin,
  requestedQuantity,
  productUrl,
  policy = TARGET_CART_POLICY,
  now = () => Date.now(),
  sleep,
  acquireButton,
  getProbableEvidence,
  clickAndObserve,
  verifyCart,
  dismissTransient,
  restoreProduct,
  isProductPageValid,
  onEvent = () => {}
}) {
  const budget = new TargetCartBudget({ startedAt: now(), policy })
  let pendingRetryKind = null

  const emit = (state, fields = {}) =>
    onEvent({ state, ...budget.snapshot(now()), ...fields })

  const reloadProduct = async (reason) => {
    budget.recordReload(now())
    emit('reloading_product', { reason })
    await restoreProduct()
    pendingRetryKind = 'reload'
  }

  const confirm = async (candidate) => {
    emit('cart_confirming', {
      evidenceSource: candidate.source,
      mutationStatus: candidate.mutationStatus
    })
    const cartState = await verifyCart(candidate)
    if (!cartState?.present || !Number.isInteger(cartState.quantity) || cartState.quantity < 1) {
      await reloadProduct('authoritative-verification-failed')
      return null
    }
    const snapshot = budget.snapshot(now())
    emit('cart_ready', { evidenceSource: candidate.source })
    return {
      tcin,
      quantity: cartState.quantity,
      unitPrice: cartState.unitPrice ?? null,
      source: candidate.source,
      mutationStatus: candidate.mutationStatus ?? null,
      clickCount: snapshot.clickCount,
      retryCount: snapshot.retryCount,
      reloadCount: snapshot.reloadCount,
      confirmedAt: new Date(now()).toISOString()
    }
  }

  while (true) {
    budget.assertTimeRemaining(now())

    if (!(await isProductPageValid())) {
      await reloadProduct('product-page-replaced')
      continue
    }

    const evidenceBeforeAcquire = await getProbableEvidence()
    if (evidenceBeforeAcquire) {
      const confirmed = await confirm(evidenceBeforeAcquire)
      if (confirmed) return confirmed
      continue
    }

    if (pendingRetryKind === 'no-response' && !budget.canRetryNoResponse()) {
      await reloadProduct('no-response-limit')
      continue
    }

    emit('availability_wait')
    const button = await acquireButton({ pollMs: policy.pollMs })

    const evidenceBeforeClick = await getProbableEvidence()
    if (evidenceBeforeClick) {
      const confirmed = await confirm(evidenceBeforeClick)
      if (confirmed) return confirmed
      continue
    }

    budget.authorizeClick(pendingRetryKind, now())
    pendingRetryKind = null
    emit('cart_response_wait')
    const outcome = await clickAndObserve(button, { outcomeMs: policy.outcomeMs })
    emit('outcome_classified', { kind: outcome.kind, status: outcome.status })

    if (outcome.kind === 'success') {
      const confirmed = await confirm(outcome.evidence)
      if (confirmed) return confirmed
      continue
    }

    if (outcome.kind === 'session-error') {
      throw new Error(`Target cart session rejected with HTTP ${outcome.status}`)
    }

    if (outcome.kind === 'no-response') {
      pendingRetryKind = 'no-response'
      continue
    }

    if (outcome.kind === 'transient' || outcome.kind === 'rate-limit') {
      await dismissTransient()
      const delayMs =
        outcome.kind === 'rate-limit'
          ? (outcome.retryAfterMs ?? policy.rateLimitDelayMs)
          : policy.transientDelayMs
      budget.assertDelayFits(delayMs, now())
      emit(outcome.kind === 'rate-limit' ? 'rate_limited' : 'transient_recovery', {
        delayMs,
        retryAfterHonored: outcome.kind === 'rate-limit' && outcome.retryAfterMs !== null
      })
      await sleep(delayMs)
      pendingRetryKind = outcome.kind
      continue
    }

    throw new Error(`Unsupported Target cart outcome: ${outcome.kind}`)
  }
}

export { TargetCartBudgetError }
```

When `verifyCart` fails, `restoreProduct` must return to the PDP and `isProductPageValid` must be true before another click. Do not catch terminal out-of-stock, challenge, or session errors inside the controller.

- [ ] **Step 5: Run policy and controller tests**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js`

Expected: PASS with fake-clock execution and no real 400/1,500 ms sleeps.

- [ ] **Step 6: Commit the controller unit**

```powershell
git add -- src/main/automation/flows/target/TargetCartPolicy.js src/main/automation/flows/target/TargetCartAttemptController.js tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js
git commit -m "feat: orchestrate aggressive Target cart retries"
```

---

### Task 4: Wire the Controller into the Warm Target Product Page

**Files:**
- Modify: `src/main/automation/flows/target.js:1-18`
- Modify: `src/main/automation/flows/target.js:1282-1716`
- Modify: `tests/main/automation/flows/target-high-demand.test.js:7-182`

**Interfaces:**
- Consumes: `runTargetCartAttempt`, Target signal helpers, existing `readTargetCartItemState`, `waitForCaptchaIfNeeded`, `dismissTargetCheckoutDialog`, `TargetPageCoordinator`, and quantity selection.
- Produces: `browserAddToCart(page, productUrl, buyLimit, onStep, notificationEngine, dropEvent, coordinator, onMilestone, navigationWaitUntil): Promise<CartEvidence>` while retaining the existing positional function signature for callers.

- [ ] **Step 1: Replace the existing 3-6 second integration assertion with failing Polar-like assertions**

Update the first high-demand test so the mocked 200 response is followed by exact cart evidence and assert:

```js
expect(click).toHaveBeenCalledTimes(2)
expect(page.goto).not.toHaveBeenCalledWith(
  'https://www.target.com/p/test-product/-/A-123456',
  expect.anything()
)
expect(page.waitForTimeout).toHaveBeenCalledWith(1500)
expect(
  page.waitForTimeout.mock.calls.some(([delay]) => delay >= 3000 && delay <= 6000)
).toBe(false)
expect(result).toMatchObject({
  tcin: '123456',
  quantity: 1,
  mutationStatus: 200,
  clickCount: 2,
  retryCount: 1,
  reloadCount: 0
})
```

Change the fixture URL and product argument to `https://www.target.com/p/test-product/-/A-123456`. Use a response mock with `headers: () => ({})`, add `page.waitForResponse` that is armed before each `click`, and make cart verification return `{ present: true, quantity: 1, unitPrice: 19.99, source: 'item-control' }`. Assert the listener is armed before the button click using `expect(callOrder.slice(0, 2)).toEqual(['armed', 'clicked'])`.

Implement that authoritative state through the existing page APIs:

```js
page.evaluate = vi.fn(async () => ({
  present: true,
  quantity: 1,
  unitPrice: 19.99,
  source: 'item-control'
}))
page.content = vi.fn(async () => '')
page.context = vi.fn(() => ({
  cookies: vi.fn(async () => [{ name: 'accessToken', value: 'x'.repeat(32) }])
}))
```

The fixture's `goto` may record `/co-cart` for authoritative verification, but it must not record a product-page navigation during the 429 retry.

Add a readiness test with a coordinator spy:

```js
expect(coordinator.waitForNextScan).toHaveBeenCalledWith(expect.anything(), 100)
```

- [ ] **Step 2: Run the high-demand tests and verify the old flow fails the new timing**

Run: `npx vitest run tests/main/automation/flows/target-high-demand.test.js`

Expected: FAIL because the current flow waits 3-6 seconds, uses a 150 ms default poll with a 3,000 ms coordinator wait, and does not return complete `CartEvidence`.

- [ ] **Step 3: Import the new modules and remove obsolete random retry constants**

At the top of `target.js`, add:

```js
import { runTargetCartAttempt } from './target/TargetCartAttemptController.js'
import { TARGET_CART_STRATEGY } from './target/TargetCartPolicy.js'
import {
  clickAndObserveTargetCart,
  getTargetProbableCartEvidence,
  getVisibleTargetAddToCartButton
} from './target/TargetCartSignals.js'
```

Remove `TARGET_BROWSER_CART_RETRY_MIN_DELAY_MS`, `TARGET_BROWSER_CART_RETRY_MAX_DELAY_MS`, `randomTargetCartRetryDelay`, and the old `clickAndCaptureTargetCartResponse`. Retain the 120-second behavior through `TARGET_CART_POLICY`, not a second local deadline.

Replace the API selection expression with the browser-only production strategy:

```js
const useApi =
  TARGET_CART_STRATEGY === 'api' &&
  tcin !== null &&
  useTargetCartApi &&
  !isTargetCartApiCoolingDown(accountId)
```

Because `TARGET_CART_STRATEGY` is fixed to `browser`, the existing API implementation remains unreachable for future research and no production high-demand attempt executes its cart request. When `useTargetCartApi` is still enabled in saved settings, log one sanitized informational message that the setting is ignored by browser-only Target checkout.

- [ ] **Step 4: Make readiness honor the 100 ms critical cadence**

In the existing function signature, replace `pollMs = 150` with `pollMs = 100` and add `tcin = null`. In the existing loop, make these two exact replacements:

```js
const addToCartBtn = getVisibleTargetAddToCartButton(page, tcin)

const snapshot = await coordinator?.signalState()
await waitForTargetSignal(page, coordinator, snapshot, pollMs)
```

Do not call `Math.max(pollMs, 3000)` in this critical loop. Keep the checkout-page coordinator waits unchanged.

- [ ] **Step 5: Replace `browserAddToCart`'s manual loop with controller wiring**

Keep initial product navigation, CAPTCHA handling, fulfillment readiness, and quantity selection. After extracting the TCIN, return:

```js
return runTargetCartAttempt({
  tcin,
  requestedQuantity: buyLimit,
  productUrl,
  sleep: (ms) => page.waitForTimeout(ms),
  acquireButton: ({ pollMs }) =>
    waitForTargetAddToCartReady(page, {
      onStep,
      notificationEngine,
      dropEvent,
      coordinator,
      timeoutMs: 5000,
      pollMs,
      tcin
    }),
  getProbableEvidence: () => getTargetProbableCartEvidence(page, tcin),
  clickAndObserve: (button, { outcomeMs }) =>
    clickAndObserveTargetCart({ page, button, tcin, outcomeMs }),
  verifyCart: async () => {
    onStep('Verifying the requested item in the Target cart')
    const cartState = await confirmRequestedTargetCartItem(page, tcin, {
      notificationEngine,
      dropEvent,
      coordinator
    })
    if (!(await isTargetSignedIn(page))) {
      throw new Error('Target session was lost after adding the item to cart')
    }
    return cartState
  },
  dismissTransient: () => dismissTargetCheckoutDialog(page),
  restoreProduct: async () => {
    await page.goto(productUrl, { waitUntil: navigationWaitUntil, timeout: 30000 })
    if (navigationWaitUntil === 'commit') {
      await page.locator('body').waitFor({ state: 'attached', timeout: 5000 })
    }
    await waitForCaptchaIfNeeded(page, notificationEngine, dropEvent)
  },
  isProductPageValid: async () => /target\.com\/p\//i.test(page.url?.() || ''),
  onEvent: (event) => {
    log.info('Target cart attempt event', event)
    if (event.state === 'cart_response_wait') {
      onMilestone('cart_attempted', `Target browser cart requested quantity ${buyLimit}`)
    }
  }
})
```

Ensure the controller's first click has no `humanDelay` and no 1,500 ms `claimTargetAction` gate. The controller owns the page and its evidence checks provide duplicate-click protection.

- [ ] **Step 6: Preserve public helper imports**

Re-export the moved button helper from `target.js` so existing tests and any internal consumers remain valid:

```js
export { getVisibleTargetAddToCartButton } from './target/TargetCartSignals.js'
```

- [ ] **Step 7: Run focused integration tests**

Run: `npx vitest run tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartSignals.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js`

Expected: PASS.

- [ ] **Step 8: Review and commit the Target integration diff**

Run: `git diff -- src/main/automation/flows/target.js tests/main/automation/flows/target-high-demand.test.js`

Confirm that the pre-existing Target high-demand edits are consistent with the approved spec. Then commit only the Target flow and its focused integration test:

```powershell
git add -- src/main/automation/flows/target.js tests/main/automation/flows/target-high-demand.test.js
git commit -m "feat: use Polar-like Target cart controller"
```

---

### Task 5: Reuse `CartEvidence` and Remove Duplicate Confirmation

**Files:**
- Create: `src/main/automation/flows/target/TargetCartEvidence.js`
- Create: `tests/main/automation/flows/target/TargetCartEvidence.test.js`
- Modify: `src/main/automation/flows/target.js:180-390`
- Modify: `tests/main/automation/flows/target-high-demand.test.js`
- Test: `tests/main/automation/CheckoutSafety.test.js`

**Interfaces:**
- Consumes: `CartEvidence` returned by `browserAddToCart`, an async `confirmCart` fallback, and existing `validateTargetCartForCheckout`.
- Produces: `resolveTargetCartState({ cartEvidence, confirmCart }): Promise<CartState>`, one safety-validation input, and exactly one checkout navigation after browser cart acquisition.

- [ ] **Step 1: Add failing evidence-handoff unit tests**

```js
import { describe, expect, it, vi } from 'vitest'
import { resolveTargetCartState } from '../../../../../src/main/automation/flows/target/TargetCartEvidence.js'

describe('resolveTargetCartState', () => {
  it('converts authoritative CartEvidence without invoking the fallback parser', async () => {
    const confirmCart = vi.fn(async () => ({ present: false }))
    const cartState = await resolveTargetCartState({
      cartEvidence: {
        tcin: '123456',
        quantity: 1,
        unitPrice: 19.99,
        source: 'mutation-2xx',
        mutationStatus: 200,
        clickCount: 2,
        retryCount: 1,
        reloadCount: 0,
        confirmedAt: '2026-08-10T12:00:00.000Z'
      },
      confirmCart
    })
    expect(cartState).toEqual({
      present: true,
      quantity: 1,
      unitPrice: 19.99,
      source: 'mutation-2xx'
    })
    expect(confirmCart).not.toHaveBeenCalled()
  })

  it('uses the authoritative parser when browser evidence is absent', async () => {
    const expected = { present: true, quantity: 1, unitPrice: 19.99, source: 'item-control' }
    const confirmCart = vi.fn(async () => expected)
    await expect(resolveTargetCartState({ cartEvidence: null, confirmCart })).resolves.toBe(expected)
    expect(confirmCart).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the unit test and verify the helper is missing**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartEvidence.test.js`

Expected: FAIL because `TargetCartEvidence.js` does not exist.

- [ ] **Step 3: Implement the evidence resolver**

```js
export async function resolveTargetCartState({ cartEvidence, confirmCart }) {
  if (!cartEvidence) return confirmCart()
  return {
    present: true,
    quantity: cartEvidence.quantity,
    unitPrice: cartEvidence.unitPrice,
    source: cartEvidence.source
  }
}
```

- [ ] **Step 4: Capture evidence from every browser path**

Declare `let cartEvidence = null` alongside `cartStrategyActual`. Change every browser call in the API-fallback and browser-only branches from:

```js
await browserAddToCart(page, productUrl, buyLimit, onStep, notificationEngine, dropEvent, coordinator, onMilestone, navigationWaitUntil)
```

to:

```js
cartEvidence = await browserAddToCart(
  page,
  productUrl,
  buyLimit,
  onStep,
  notificationEngine,
  dropEvent,
  coordinator,
  onMilestone,
  navigationWaitUntil
)
```

Do not fabricate `CartEvidence` for API or pre-existing-cart branches; those paths continue through the existing authoritative parser.

- [ ] **Step 5: Resolve returned evidence once for checkout safety**

Import `resolveTargetCartState` and replace unconditional confirmation with:

```js
const cartState = await resolveTargetCartState({
  cartEvidence,
  confirmCart: () =>
    confirmRequestedTargetCartItem(page, tcin, {
      notificationEngine,
      dropEvent,
      coordinator
    })
})

const safety = validateTargetCartForCheckout({
  tcin,
  cartState,
  buyLimit,
  maxPrice
})
```

Keep the existing `cart_ready` milestone, quantity-limited message, final pre-submit safety validation, and one navigation to Target checkout.

- [ ] **Step 6: Run evidence-handoff, cart safety, and submission safety tests**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartEvidence.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/CheckoutSafety.test.js tests/main/automation/flows/submission-safety.test.js`

Expected: PASS. The submission tests must retain their existing click-count assertions.

- [ ] **Step 7: Commit the evidence handoff**

```powershell
git add -- src/main/automation/flows/target/TargetCartEvidence.js tests/main/automation/flows/target/TargetCartEvidence.test.js src/main/automation/flows/target.js tests/main/automation/flows/target-high-demand.test.js
git commit -m "perf: reuse verified Target cart evidence"
```

---

### Task 6: Complete Failure Matrix and Sanitized Telemetry Coverage

**Files:**
- Modify: `tests/main/automation/flows/target/TargetCartAttemptController.test.js`
- Modify: `tests/main/automation/flows/target/TargetCartSignals.test.js`
- Modify: `tests/main/automation/flows/target-high-demand.test.js`

**Interfaces:**
- Consumes: the completed controller and page-signal interfaces.
- Produces: deterministic proof for all approved terminal and recovery paths, including sanitized event payloads.

- [ ] **Step 1: Add the remaining failure-matrix tests**

Add table-driven tests with exact expected outcomes:

```js
it.each([
  [{ kind: 'session-error', status: 401, evidence: null }, /HTTP 401/],
  [{ kind: 'session-error', status: 403, evidence: null }, /HTTP 403/]
])('terminates session failures without another click', async (outcome, message) => {
  const h = harness([outcome])
  await expect(runTargetCartAttempt(h.options)).rejects.toThrow(message)
  expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
})

it('terminates after 30 additional recoverable clicks', async () => {
  const h = harness(Array.from({ length: 40 }, () => ({
    kind: 'transient',
    status: 503,
    evidence: null
  })))
  await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'retry-limit' })
  expect(h.options.clickAndObserve).toHaveBeenCalledTimes(31)
})

it('terminates after two product reloads', async () => {
  const noResponse = { kind: 'no-response', status: null, evidence: null }
  const h = harness(Array.from({ length: 20 }, () => noResponse))
  await expect(runTargetCartAttempt(h.options)).rejects.toMatchObject({ code: 'reload-limit' })
  expect(h.options.restoreProduct).toHaveBeenCalledTimes(2)
})
```

Retain the transient-modal adapter test from Task 2 and the explicit out-of-stock/challenge readiness tests from Task 4. Add these controller assertions:

```js
it('restores a replaced product page before acquiring a button', async () => {
  const h = harness([{ kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }])
  h.setProductValid(false)
  const result = await runTargetCartAttempt(h.options)
  expect(h.options.restoreProduct).toHaveBeenCalledTimes(1)
  expect(result.reloadCount).toBe(1)
})

it('freezes clicking when evidence appears after transient-modal dismissal', async () => {
  const h = harness([{ kind: 'transient', status: null, evidence: null }])
  h.options.getProbableEvidence
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ source: 'visible-added-to-cart', mutationStatus: null })
  const result = await runTargetCartAttempt(h.options)
  expect(h.options.clickAndObserve).toHaveBeenCalledTimes(1)
  expect(h.options.dismissTransient).toHaveBeenCalledTimes(1)
  expect(result.source).toBe('visible-added-to-cart')
})

it('emits only sanitized state and counter fields', async () => {
  const h = harness([{ kind: 'success', status: 200, evidence: { source: 'mutation-2xx', mutationStatus: 200 } }])
  await runTargetCartAttempt(h.options)
  const allowed = new Set([
    'state',
    'clickCount',
    'retryCount',
    'noResponseRetries',
    'reloadCount',
    'elapsedMs',
    'kind',
    'status',
    'delayMs',
    'retryAfterHonored',
    'evidenceSource',
    'mutationStatus',
    'reason'
  ])
  for (const event of h.events) {
    expect(Object.keys(event).every((key) => allowed.has(key))).toBe(true)
  }
})
```

- [ ] **Step 2: Run the full Target failure matrix**

Run: `npx vitest run tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target/TargetCartSignals.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/submission-safety.test.js`

Expected: PASS. No event may include account names, email addresses, full URLs, response bodies, cookies, payment fields, or arbitrary modal text.

- [ ] **Step 3: Commit the completed failure coverage**

```powershell
git add -- tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target/TargetCartSignals.test.js tests/main/automation/flows/target-high-demand.test.js
git commit -m "test: cover Target aggressive cart recovery"
```

---

### Task 7: Final Target and Repository Verification

**Files:**
- Verify: `src/main/automation/flows/target.js`
- Verify: `src/main/automation/flows/target/*.js`
- Verify: `tests/main/automation/flows/target*.test.js`
- Verify: `tests/main/automation/flows/target/*.test.js`
- Verify: `tests/main/automation/CheckoutSafety.test.js`
- Verify: `tests/main/automation/flows/submission-safety.test.js`

**Interfaces:**
- Consumes: all completed implementation tasks.
- Produces: lint-clean, test-clean, buildable Target checkout changes with no accidental order submission.

- [ ] **Step 1: Run formatting only on changed Target files**

```powershell
npx prettier --write src/main/automation/flows/target.js src/main/automation/flows/target/TargetCartPolicy.js src/main/automation/flows/target/TargetCartSignals.js src/main/automation/flows/target/TargetCartAttemptController.js src/main/automation/flows/target/TargetCartEvidence.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartSignals.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target/TargetCartEvidence.test.js
```

- [ ] **Step 2: Run focused lint**

Run: `npx eslint src/main/automation/flows/target.js src/main/automation/flows/target/*.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/target/*.test.js`

Expected: exit code 0.

- [ ] **Step 3: Run the complete Target and safety test set**

Run: `npx vitest run tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartSignals.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target/TargetCartEvidence.test.js tests/main/automation/CheckoutSafety.test.js tests/main/automation/flows/submission-safety.test.js tests/main/automation/TargetPageCoordinator.test.js`

Expected: all tests pass, including proof that test mode and ambiguous submission paths do not click Place Your Order again.

- [ ] **Step 4: Run the full unit suite and production build**

Run: `npm test`

Expected: exit code 0.

Run: `npm run build`

Expected: Electron Vite build completes successfully.

- [ ] **Step 5: Inspect scope and secret safety**

```powershell
git diff --check
git status --short
git diff --stat
rg -n "cookie|accessToken|idToken|cardNumber|cvv|email|responseBody" src/main/automation/flows/target/TargetCart*.js
```

Expected: no whitespace errors; only intended Target files are part of these commits; signal/controller modules do not log or emit sensitive values. Existing unrelated dirty files remain untouched.

- [ ] **Step 6: Commit formatting or verification-only corrections if present**

```powershell
git add -- src/main/automation/flows/target.js src/main/automation/flows/target/TargetCartPolicy.js src/main/automation/flows/target/TargetCartSignals.js src/main/automation/flows/target/TargetCartAttemptController.js src/main/automation/flows/target/TargetCartEvidence.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartSignals.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target/TargetCartEvidence.test.js
git diff --cached --stat
```

If `git diff --cached --stat` lists formatting or verification corrections, run:

```powershell
git commit -m "chore: finalize Target cart retry verification"
```

If it is empty, skip this commit because the preceding task commits already contain the verified result.

Do not commit unrelated modifications from `package.json`, database, IPC, renderer, task manager, browser pool, `Polar Extension`, or `deploy` unless a separately approved task explicitly brings them into scope.
