# Target Conditional Cart Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the real Target cart after an ambiguous Add to Cart response before issuing another click.

**Architecture:** Extend the existing cart-attempt controller with one injected recovery callback. Keep browser navigation and TCIN reading in `target.js`, then return verified cart state through the controller's existing evidence contract so checkout safety remains centralized.

**Tech Stack:** JavaScript, Playwright, Vitest, Electron

## Global Constraints

- Invoke recovery only after `no-response`.
- Cap the browser recovery probe at 2,000 ms.
- An absent, failed, or timed-out probe must resume the normal add flow.
- Exact TCIN, quantity, and price validation remain mandatory before checkout.
- Do not change explicit 401/403, CAPTCHA, sign-out, out-of-stock, or submission safety behavior.

---

### Task 1: Controller recovery boundary

**Files:**
- Modify: `src/main/automation/flows/target/TargetCartAttemptController.js`
- Test: `tests/main/automation/flows/target/TargetCartAttemptController.test.js`

**Interfaces:**
- Consumes: `recoverAmbiguousCart(): Promise<CartState | null>`
- Produces: sanitized `ambiguous_cart_recovery` events and existing cart evidence results

- [ ] **Step 1: Write failing controller tests**

Add tests proving a no-response probes before a second click, a present cart returns without another click, absence continues, and non-ambiguous outcomes do not probe.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/main/automation/flows/target/TargetCartAttemptController.test.js`

Expected: FAIL because `recoverAmbiguousCart` is not invoked.

- [ ] **Step 3: Implement the minimal controller branch**

Before probable-evidence and inventory evaluation, call `recoverAmbiguousCart` only when `pendingRetryKind === 'no-response'`. Return verified state through the existing result shape or continue on null.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/main/automation/flows/target/TargetCartAttemptController.test.js`

Expected: PASS.

### Task 2: Bounded Target browser cart probe

**Files:**
- Modify: `src/main/automation/flows/target.js`
- Test: `tests/main/automation/flows/target/TargetAmbiguousCartRecovery.test.js`

**Interfaces:**
- Produces: `recoverAmbiguousTargetCart(page, tcin, options): Promise<CartState | null>`
- Supplies: controller `recoverAmbiguousCart` callback

- [ ] **Step 1: Write failing browser-boundary tests**

Test exact-TCIN presence, absence, timeout/failure fallback, and the 2,000 ms navigation/read budget using a controlled page double.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/main/automation/flows/target/TargetAmbiguousCartRecovery.test.js`

Expected: FAIL because the exported recovery helper does not exist.

- [ ] **Step 3: Implement the bounded probe and wire it into `browserAddToCart`**

Navigate to `/co-cart` with the bounded timeout, read only the requested TCIN, return valid state when found, and return null on absence or recoverable timeout. The existing controller restores the product page before the next click.

- [ ] **Step 4: Run focused and regression tests**

Run: `npm test -- tests/main/automation/flows/target/TargetAmbiguousCartRecovery.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/automation/flows/target-high-demand.test.js tests/main/automation/flows/submission-safety.test.js`

Expected: PASS.

### Task 3: Verification and commit

**Files:**
- Verify only the files listed above and the two design documents.

- [ ] **Step 1: Run scoped lint, the full test suite, and production build**

Run scoped ESLint on changed source/tests, then `npm test` and `npm run build`.

- [ ] **Step 2: Review the staged diff for unrelated dirty-worktree changes**

Stage only conditional-recovery hunks and confirm no pre-existing inventory-gate or other user changes are included.

- [ ] **Step 3: Commit directly to `master`**

Commit message: `feat: recover ambiguous Target cart attempts`

