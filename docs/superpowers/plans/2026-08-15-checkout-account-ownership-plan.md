# Checkout Account Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent concurrent tasks from closing or reusing a Target account’s test/manual checkout browser, while exposing a clear busy state.

**Architecture:** Add a TaskManager account lease map with explicit owner metadata and a protected browser pin. All checkout entry points acquire the lease before launching and release it in terminal paths; manual/test-ready paths retain the lease until explicit release or browser close. Existing account busy checks and IPC/UI status events surface conflicts.

**Tech Stack:** Electron main process, JavaScript, Playwright browser pool, Vitest, React/Zustand renderer.

## Global Constraints

- Never close a browser context owned by a test/manual checkout from unrelated task cleanup.
- Never retry an order after submission becomes uncertain.
- Preserve existing automatic monitoring behavior and explicit task stop behavior.
- Keep existing account assignments and database schema unchanged.

---

### Task 1: Add failing account-lease tests

**Files:**
- Create: `tests/main/tasks/AccountCheckoutLease.test.js`
- Modify: `src/main/tasks/TaskManager.js`

**Interfaces:**
- Produce `TaskManager.acquireAccountCheckout(accountId, owner)` returning `{ acquired: boolean, reason?: string, owner?: object }`.
- Produce `TaskManager.releaseAccountCheckout(accountId, ownerId)` returning `boolean`.

- [ ] **Step 1: Write failing tests**

Test that the first owner acquires an account, a second owner is rejected with the first owner metadata, and the original owner can release it. Test that a release from a non-owner does not clear the lease.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js`

Expected: FAIL because the lease methods do not exist.

- [ ] **Step 3: Implement the minimal lease map**

Add a private `Map` in `TaskManager`, normalize owner IDs, and implement acquire/release without changing checkout flow yet.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js`

Expected: PASS.

### Task 2: Protect checkout execution and cleanup

**Files:**
- Modify: `src/main/tasks/TaskManager.js`
- Test: `tests/main/tasks/AccountCheckoutLease.test.js`

**Interfaces:**
- Consume the lease methods from Task 1 at `_runFlowForAccount` and `runTaskNow`/`testTask` entry points.

- [ ] **Step 1: Add failing concurrency test**

Create two tasks using one account, start the first checkout, and assert the second returns `accountBusy: true` without launching a browser.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js`

Expected: FAIL because both tasks currently launch/use the same account.

- [ ] **Step 3: Acquire lease before launch and release terminal runs**

Acquire using a stable owner ID derived from task ID and checkout mode. Return a structured busy result when acquisition fails. Release in `finally`; preserve the lease and browser pin for `testMode`/`requiresManualCheckout` results.

- [ ] **Step 4: Prevent unrelated cleanup**

Make `_closeAccountContext` respect the lease owner and keep the context pinned for the owning checkout. Only the owner or explicit release may close it.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/main/tasks/AccountCheckoutLease.test.js tests/main/tasks/TaskManager.test.js`

Expected: PASS.

### Task 3: Surface busy state in IPC/store/UI

**Files:**
- Modify: `src/main/tasks/TaskManager.js`
- Modify: `src/main/ipc.js`
- Modify: `src/renderer/src/store/appStore.js`
- Modify: `src/renderer/src/pages/Tasks.jsx`
- Test: `tests/renderer/Tasks.test.js`

**Interfaces:**
- Emit `taskStatus` with `status: 'busy'`, `accountBusy: true`, and owner metadata.
- Renderer displays the busy reason and disables test/run-now/start actions for that task.

- [ ] **Step 1: Add failing UI regression test**

Assert the task row renders the busy owner/product message and disables checkout actions when the task status is `busy`.

- [ ] **Step 2: Run it to verify failure**

Run: `npx vitest run tests/renderer/Tasks.test.js`

Expected: FAIL because busy status is not rendered.

- [ ] **Step 3: Implement status propagation and UI disabling**

Preserve the current `Run now` and test actions, but show the account owner and disable competing actions until the lease is released.

- [ ] **Step 4: Run focused UI tests and build**

Run: `npx vitest run tests/renderer/Tasks.test.js && npm run build`

Expected: PASS and a successful Electron build.

### Task 4: Full verification

**Files:**
- Modify: none

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all existing and new tests pass.

- [ ] **Step 2: Run the Electron build**

Run: `npm run build`

Expected: main, preload, and renderer bundles build successfully.
