# Target Recoverable Page Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an account's pooled Target checkout page after explicitly recognized recoverable pre-submission failures while closing unsafe, terminal, and unclassified pages.

**Architecture:** Add a small pure Target page-reuse policy module that classifies a failure from its message, submission boundary, page state, and current origin. `runTargetFlow` consults that policy only in its failure path and retains its existing default-close behavior. `BrowserPool.getCheckoutPage` remains the sole owner and source of reusable pages.

**Tech Stack:** Electron main process, JavaScript ES modules, Playwright-compatible page objects, Vitest.

## Global Constraints

- Do not change inventory gating, retry counts, retry delays, account checkout leases, order-submission safeguards, cart validation, price limits, or monitoring.
- Preserve only allowlisted recoverable failures before order submission and only on an open `target.com` page.
- Never reuse pages after HTTP 401/403, sign-out, security challenge, non-Target origin, closed page/context, wrong-product state, settled out-of-stock, or an order-submission attempt.
- Keep existing manual-review and uncertain-submission page behavior unchanged.
- Do not change non-Target retailer behavior.
- Stage and commit only this plan's hunks because the worktree contains unrelated user changes.

---

### Task 1: Define and test the page-reuse policy

**Files:**
- Create: `src/main/automation/flows/target/TargetPageReusePolicy.js`
- Create: `tests/main/automation/flows/target/TargetPageReusePolicy.test.js`

**Interfaces:**
- Consumes: `{ error, page, orderSubmissionAttempted }` from the Target flow failure boundary.
- Produces: `classifyTargetPageReuse({ error, page, orderSubmissionAttempted }): { preserve: boolean, reason: string }`.

- [ ] **Step 1: Write the failing policy tests**

```js
import { describe, expect, it } from 'vitest'
import { classifyTargetPageReuse } from '../../../../../src/main/automation/flows/target/TargetPageReusePolicy.js'

const page = ({ url = 'https://www.target.com/p/example/-/A-123', closed = false } = {}) => ({
  url: () => url,
  isClosed: () => closed
})

describe('TargetPageReusePolicy', () => {
  it.each([
    'Target browser add-to-cart was not confirmed',
    'Target did not confirm the requested item in the cart',
    'Target high-demand add-to-cart retry window expired',
    'Target fulfillment is still loading',
    'Target availability did not settle',
    'page.goto: net::ERR_ABORTED at https://www.target.com/checkout'
  ])('preserves an open Target page for recoverable failure: %s', (error) => {
    expect(classifyTargetPageReuse({ error, page: page(), orderSubmissionAttempted: false }))
      .toMatchObject({ preserve: true })
  })

  it.each([
    'Target cart session rejected with HTTP 401',
    'HTTP 403',
    'Target security challenge did not clear',
    'Item is out of stock (Target availability settled)',
    'Unexpected Target failure'
  ])('discards an unsafe or unclassified failure: %s', (error) => {
    expect(classifyTargetPageReuse({ error, page: page(), orderSubmissionAttempted: false }))
      .toMatchObject({ preserve: false })
  })

  it('discards after submission, on a closed page, or outside Target', () => {
    const error = 'Target did not confirm the requested item in the cart'
    expect(classifyTargetPageReuse({ error, page: page(), orderSubmissionAttempted: true }).preserve).toBe(false)
    expect(classifyTargetPageReuse({ error, page: page({ closed: true }), orderSubmissionAttempted: false }).preserve).toBe(false)
    expect(classifyTargetPageReuse({ error, page: page({ url: 'https://example.com/' }), orderSubmissionAttempted: false }).preserve).toBe(false)
  })
})
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `npm test -- tests/main/automation/flows/target/TargetPageReusePolicy.test.js`

Expected: FAIL because `TargetPageReusePolicy.js` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

```js
const RECOVERABLE = [
  /target browser add-to-cart was not confirmed/i,
  /target did not confirm the requested item in the cart/i,
  /target high-demand add-to-cart retry window expired/i,
  /target fulfillment is still loading/i,
  /target availability did not settle/i,
  /net::err_aborted/i
]

const UNSAFE = [
  /http 401|http 403/i,
  /signed? out|not signed in/i,
  /security challenge|captcha/i,
  /wrong product|unexpected product/i,
  /out of stock|sold out|no longer available/i,
  /page, context or browser has been closed/i
]

export function classifyTargetPageReuse({ error, page, orderSubmissionAttempted = false }) {
  if (orderSubmissionAttempted) return { preserve: false, reason: 'submission-attempted' }
  if (!page || page.isClosed?.()) return { preserve: false, reason: 'page-closed' }

  let hostname = ''
  try {
    hostname = new URL(page.url?.() || '').hostname.toLowerCase()
  } catch {
    return { preserve: false, reason: 'invalid-origin' }
  }
  if (hostname !== 'target.com' && !hostname.endsWith('.target.com')) {
    return { preserve: false, reason: 'non-target-origin' }
  }

  const message = String(error?.message || error || '')
  if (UNSAFE.some((pattern) => pattern.test(message))) {
    return { preserve: false, reason: 'unsafe-failure' }
  }
  if (RECOVERABLE.some((pattern) => pattern.test(message))) {
    return { preserve: true, reason: 'recoverable-pre-submission-failure' }
  }
  return { preserve: false, reason: 'unclassified-failure' }
}
```

- [ ] **Step 4: Run the policy test and verify GREEN**

Run: `npm test -- tests/main/automation/flows/target/TargetPageReusePolicy.test.js`

Expected: all policy tests PASS.

- [ ] **Step 5: Commit the isolated policy**

```powershell
git add src/main/automation/flows/target/TargetPageReusePolicy.js tests/main/automation/flows/target/TargetPageReusePolicy.test.js
git commit -m "feat: classify reusable Target checkout pages"
```

### Task 2: Integrate policy-driven cleanup into `runTargetFlow`

**Files:**
- Modify: `src/main/automation/flows/target.js:1-25,91-98,550-584`
- Create: `tests/main/automation/flows/target/TargetPageCleanup.test.js`

**Interfaces:**
- Consumes: `classifyTargetPageReuse` from Task 1.
- Produces: `cleanupTargetCheckoutPage({ page, pooled, requiresManual, reuseDecision, log }): Promise<void>` for a directly testable cleanup boundary.

- [ ] **Step 1: Write failing cleanup-boundary tests**

```js
import { describe, expect, it, vi } from 'vitest'
import { cleanupTargetCheckoutPage } from '../../../../../src/main/automation/flows/target.js'

const makePage = () => ({ close: vi.fn(async () => {}) })

describe('Target checkout page cleanup', () => {
  it('keeps a pooled page after an approved recoverable failure', async () => {
    const page = makePage()
    await cleanupTargetCheckoutPage({
      page,
      pooled: true,
      requiresManual: false,
      reuseDecision: { preserve: true, reason: 'recoverable-pre-submission-failure' }
    })
    expect(page.close).not.toHaveBeenCalled()
  })

  it('closes an unpooled or discarded page', async () => {
    const unpooled = makePage()
    const discarded = makePage()
    await cleanupTargetCheckoutPage({ page: unpooled, pooled: false, requiresManual: false, reuseDecision: { preserve: true, reason: 'recoverable' } })
    await cleanupTargetCheckoutPage({ page: discarded, pooled: true, requiresManual: false, reuseDecision: { preserve: false, reason: 'unsafe-failure' } })
    expect(unpooled.close).toHaveBeenCalledOnce()
    expect(discarded.close).toHaveBeenCalledOnce()
  })

  it('keeps existing manual-review pages regardless of reuse classification', async () => {
    const page = makePage()
    await cleanupTargetCheckoutPage({ page, pooled: true, requiresManual: true, reuseDecision: { preserve: false, reason: 'submission-attempted' } })
    expect(page.close).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the cleanup test and verify RED**

Run: `npm test -- tests/main/automation/flows/target/TargetPageCleanup.test.js`

Expected: FAIL because `cleanupTargetCheckoutPage` is not exported.

- [ ] **Step 3: Add minimal cleanup integration**

Import `classifyTargetPageReuse`. Record whether the page came from `BrowserPool.getCheckoutPage`, initialize `reuseDecision` to `{ preserve: false, reason: 'terminal-or-success' }`, assign it inside the `catch` before returning, and replace the existing `finally` close block with:

```js
await cleanupTargetCheckoutPage({
  page,
  pooled: usesPooledCheckoutPage,
  requiresManual,
  reuseDecision,
  log
})
```

Implement the exported helper:

```js
export async function cleanupTargetCheckoutPage({
  page,
  pooled,
  requiresManual,
  reuseDecision = { preserve: false, reason: 'default-close' },
  log: cleanupLog = log
}) {
  const preserve = requiresManual || (pooled && reuseDecision.preserve)
  cleanupLog.info('Target checkout page cleanup decision', {
    action: preserve ? 'preserve' : 'discard',
    reason: requiresManual ? 'manual-review' : reuseDecision.reason
  })
  if (!preserve) await page.close().catch(() => {})
}
```

- [ ] **Step 4: Run focused Target lifecycle tests**

Run: `npm test -- tests/main/automation/flows/target/TargetPageReusePolicy.test.js tests/main/automation/flows/target/TargetPageCleanup.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/submission-safety.test.js`

Expected: all focused tests PASS.

- [ ] **Step 5: Stage only Task 2 hunks and commit**

Inspect `git diff -- src/main/automation/flows/target.js` and stage only the import, reuse-decision, catch, cleanup helper, and finally-cleanup hunks; do not stage the pre-existing inventory-gate work in that file. Then commit:

```powershell
git add tests/main/automation/flows/target/TargetPageCleanup.test.js
git add -p src/main/automation/flows/target.js
git diff --cached -- src/main/automation/flows/target.js tests/main/automation/flows/target/TargetPageCleanup.test.js
git commit -m "feat: reuse recoverable Target checkout pages"
```

### Task 3: Verify BrowserPool reuse and the complete application

**Files:**
- Create: `tests/main/automation/BrowserPool.checkoutPage.test.js`

**Interfaces:**
- Consumes: `BrowserPool.getCheckoutPage(accountId, context)`.
- Produces: regression proof that an open reserved page is reused and a closed reserved page is replaced.

- [ ] **Step 1: Write the BrowserPool contract test**

```js
import { describe, expect, it, vi } from 'vitest'
import { BrowserPool } from '../../../src/main/automation/BrowserPool.js'

describe('BrowserPool checkout page reservation', () => {
  it('reuses an open page and replaces it after it closes', async () => {
    const first = { isClosed: vi.fn(() => false) }
    const second = { isClosed: vi.fn(() => false) }
    const context = { newPage: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) }
    const pool = new BrowserPool()

    expect(await pool.getCheckoutPage('account-1', context)).toBe(first)
    expect(await pool.getCheckoutPage('account-1', context)).toBe(first)
    first.isClosed.mockReturnValue(true)
    expect(await pool.getCheckoutPage('account-1', context)).toBe(second)
    expect(context.newPage).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the BrowserPool test**

Run: `npm test -- tests/main/automation/BrowserPool.checkoutPage.test.js`

Expected: PASS against the existing BrowserPool contract. If it passes immediately, keep it as characterization coverage rather than claiming a RED cycle.

- [ ] **Step 3: Run complete verification**

Run:

```powershell
npm test
npm run lint
npm run build
```

Expected: every command exits 0 with no test failures, lint errors, or build errors.

- [ ] **Step 4: Review the final diff and commit verification coverage**

```powershell
git diff --check
git add tests/main/automation/BrowserPool.checkoutPage.test.js
git commit -m "test: cover Target checkout page reservation"
git status --short
```

Confirm the feature commits are on `master`, unrelated worktree changes remain unstaged, and no generated artifacts or secrets were committed.
