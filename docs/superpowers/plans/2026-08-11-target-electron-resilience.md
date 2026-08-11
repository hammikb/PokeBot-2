# Target Electron resilience implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Keep browser-only Target cart recovery alive while stock is valid, eliminate competing Realtime reconnect loops, and expose desktop-notification delivery evidence.

**Architecture:** One private product channel carries both drop and inventory events. The installed Supabase client owns automatic reconnect; generation guards ignore stale callbacks and a delayed sweep replaces only channels that remain unhealthy. An inventory gate selects the existing 120-second deadline or a hard 10-minute in-stock deadline before every cart click, while notification telemetry stays off the checkout critical path.

**Tech Stack:** Electron 42, Node.js ESM, @supabase/supabase-js 2.112.0, Vitest 4, React 19/Zustand.

## Global Constraints

- Keep TARGET_CART_STRATEGY = browser, 0 ms intentional pre-click delay, 100 ms polling, 1.5-second result windows, 400 ms transient retry, 30 recognized-error retries, and two reload fallbacks.
- Existing cart/success evidence always freezes clicking before inventory or retry logic is consulted again.
- Use the existing 120-second deadline when inventory or channel health is unavailable; extend only to a hard 600,000 ms while a valid post-drop in-stock state is available.
- Stop before the next click on a valid out-of-stock event newer than the triggering drop.
- Never retry after order submission starts or after an account/payment/safety-terminal failure.
- Let supabase-js own normal automatic reconnection; do not add a second fixed reconnect loop.
- Do not delay checkout while recording desktop-notification telemetry.
- Preserve the uncommitted manual-takeover and browser warmup changes in the user's primary worktree.

---

### Task 1: Realtime inventory cache and generation-safe recovery

**Files:**
- Modify: src/main/monitor/SupabaseMonitorSource.js
- Modify: tests/main/monitor/SupabaseMonitorSource.test.js

**Interfaces:**
- Produces: getInventoryGate(productUrl, dropObservedAt) returning { mode, available, observedAt, reason }.
- Produces: recoverInterruptedChannels({ minInterruptedMs }) returning Promise<{ recovered: number }>.
- Channel events: drop remains unchanged; inventory payload is cached and emitted as inventory.

- [ ] **Step 1: Read test-quality rules and write failing inventory tests**

Read C:/Users/kaib1/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/test-driven-development/writing-good-tests.md. Extend the fake channel so handlers are keyed by Broadcast event, then add:

~~~js
it('returns an extended gate for a valid post-drop in-stock inventory event', async () => {
  const { client, broadcast } = makeFakeClient()
  const source = new SupabaseMonitorSource({ client })
  await source.addProduct(TARGET_PRODUCT)
  broadcast('inventory', {
    product_id: 'prod-1',
    available: true,
    observed_at: '2026-08-11T08:36:12.000Z'
  })
  expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:11.000Z'))
    .toMatchObject({ mode: 'extend', available: true })
})
~~~

Add separate tests for newer out-of-stock → mode stop, pre-drop observation → fallback, interrupted channel → fallback, and successful catch-up restoring health.

- [ ] **Step 2: Write failing reconnect-loop tests**

Simulate CHANNEL_ERROR, then an intentional removeChannel that invokes the old callback with CLOSED. Assert no timer or replacement is created from the stale generation. Simulate one channel remaining interrupted for 30 seconds and assert recoverInterruptedChannels replaces exactly that current channel once while healthy siblings remain untouched.

- [ ] **Step 3: Run and verify RED**

~~~powershell
npx vitest run tests/main/monitor/SupabaseMonitorSource.test.js
~~~

Expected: failures for the missing inventory handler/gate and current 1.5-second replacement behavior.

- [ ] **Step 4: Implement the minimal source changes**

Replace reconnect timers with channel generations, an inventory map, and one shared recovery promise. Each subscription captures its generation and registers both drop and inventory Broadcast handlers. A status callback returns immediately when its captured generation is stale.

Remove _scheduleReconnect. Record interruptedAt on CHANNEL_ERROR, TIMED_OUT, or unexpected current-generation CLOSED. Clear it only after SUBSCRIBED plus successful durable catch-up.

For Target products, _runInventoryCatchUp selects the newest subscribed TCIN row from target_inventory_observations ordered by observed_at descending with limit 1. Gate extension requires current channel SUBSCRIBED, no catch-up error, an observation at or after the triggering drop, and available true. A newer available false returns stop. Every other case returns fallback.

recoverInterruptedChannels filters current-generation entries whose interruptedAt age meets minInterruptedMs, increments only those generations before removal, recreates them once, and shares one in-flight promise.

- [ ] **Step 5: Verify GREEN and commit**

~~~powershell
npx vitest run tests/main/monitor/SupabaseMonitorSource.test.js
git add src/main/monitor/SupabaseMonitorSource.js tests/main/monitor/SupabaseMonitorSource.test.js
git commit -m "fix: make Target realtime recovery generation safe"
~~~

### Task 2: Heartbeat recovery delegates to the existing source

**Files:**
- Modify: src/main/tasks/TaskManager.js
- Modify: tests/main/tasks/TaskManager.supabase.test.js
- Modify: tests/main/tasks/TaskManager.monitorHealth.test.js

**Interfaces:**
- Consumes: SupabaseMonitorSource.recoverInterruptedChannels({ minInterruptedMs: 30000 }).
- Produces: one debounced recovery request after heartbeat failure; full source replacement remains restricted to auth change/system resume.

- [ ] **Step 1: Write a failing heartbeat test**

Create a source with spies for recoverInterruptedChannels and stop. Send two timeout heartbeats, advance fake timers beyond REALTIME_RECOVERY_DELAY_MS, and assert:

~~~js
expect(source.recoverInterruptedChannels).toHaveBeenCalledWith({ minInterruptedMs: 30_000 })
expect(source.stop).not.toHaveBeenCalled()
~~~

Add a test that repeated disconnected heartbeats while recovery is pending do not create a second sweep.

- [ ] **Step 2: Run and verify RED**

~~~powershell
npx vitest run tests/main/tasks/TaskManager.supabase.test.js tests/main/tasks/TaskManager.monitorHealth.test.js
~~~

Expected: failure because heartbeat recovery currently replaces the whole source.

- [ ] **Step 3: Implement delegation**

Change only the heartbeat timer callback. Call recoverInterruptedChannels({ minInterruptedMs: 30_000 }) on the current source; if no source exists, call _getSupabaseSource. Preserve refreshMonitorConnections for explicit system-resume/auth paths. Log counts only.

- [ ] **Step 4: Verify GREEN and commit**

~~~powershell
npx vitest run tests/main/tasks/TaskManager.supabase.test.js tests/main/tasks/TaskManager.monitorHealth.test.js
git add src/main/tasks/TaskManager.js tests/main/tasks/TaskManager.supabase.test.js tests/main/tasks/TaskManager.monitorHealth.test.js
git commit -m "fix: delegate realtime recovery without source churn"
~~~

### Task 3: Inventory-aware Target cart deadline

**Files:**
- Modify: src/main/automation/flows/target/TargetCartPolicy.js
- Modify: src/main/automation/flows/target/TargetCartAttemptController.js
- Modify: src/main/automation/flows/target.js
- Modify: src/main/tasks/TaskManager.js
- Modify: tests/main/automation/flows/target/TargetCartPolicy.test.js
- Modify: tests/main/automation/flows/target/TargetCartAttemptController.test.js
- Modify: tests/main/tasks/TaskManager.test.js

**Interfaces:**
- Adds policy inventoryDeadlineMs: 600000.
- Adds controller/flow option getInventoryGate(): Promise<{ mode: extend | stop | fallback, reason? }>.

- [ ] **Step 1: Write failing budget tests**

Test TargetCartBudget time, delay, click, and reload guards with both 120,000 and 600,000 ms. Existing calls without an override must retain 120,000 ms behavior.

- [ ] **Step 2: Write failing controller behavior tests**

~~~js
it('continues after 120 seconds while healthy inventory remains in stock', async () => {
  const run = harness({
    nowValues: [0, 121_000, 121_000, 121_000],
    getInventoryGate: async () => ({ mode: 'extend' }),
    clickOutcomes: [{ kind: 'success', evidence: CART_EVIDENCE }]
  })
  await expect(runTargetCartAttempt(run.options)).resolves.toMatchObject({ quantity: 1 })
})

it('stops before another click after a newer valid out-of-stock event', async () => {
  const run = harness({
    getInventoryGate: vi.fn()
      .mockResolvedValueOnce({ mode: 'extend' })
      .mockResolvedValueOnce({ mode: 'stop', reason: 'confirmed-out-of-stock' })
  })
  await expect(runTargetCartAttempt(run.options)).rejects.toMatchObject({ code: 'out-of-stock' })
  expect(run.clickAndObserve).toHaveBeenCalledTimes(1)
})
~~~

Also prove fallback expires at 120 seconds, extension expires at 600 seconds, cart evidence returns before gate re-evaluation, and no gate permits a 31st recognized retry or third reload.

- [ ] **Step 3: Run and verify RED**

~~~powershell
npx vitest run tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/tasks/TaskManager.test.js
~~~

- [ ] **Step 4: Implement minimal gate checks**

Add inventoryDeadlineMs 600000. Let budget guards accept an optional deadline override. Resolve the gate at loop start, immediately before authorizeClick, and before sleeping. Throw TargetCartBudgetError with code out-of-stock for stop. Use 600,000 only for extend; fallback uses 120,000.

Pass the callback through browserAddToCart and runTargetFlow. In TaskManager, provide:

~~~js
getInventoryGate: () =>
  this._supabaseSource?.getInventoryGate?.(dropEvent.productUrl, dropEvent.observedAt) ||
  { mode: 'fallback', reason: 'inventory-source-unavailable' }
~~~

Do not classify out-of-stock as retryable in the outer three-attempt RetryManager.

- [ ] **Step 5: Verify GREEN and commit**

~~~powershell
npx vitest run tests/main/automation/flows/target/TargetCartPolicy.test.js tests/main/automation/flows/target/TargetCartAttemptController.test.js tests/main/tasks/TaskManager.test.js
git add src/main/automation/flows/target.js src/main/automation/flows/target src/main/tasks/TaskManager.js tests/main/automation/flows/target tests/main/tasks/TaskManager.test.js
git commit -m "feat: keep Target cart retries aligned with inventory"
~~~

### Task 4: Non-blocking desktop-notification evidence and health UI

**Files:**
- Modify: src/main/notify/desktop.js
- Modify: src/main/notify/NotificationEngine.js
- Modify: src/main/health/MonitorHealth.js
- Modify: src/main/index.js
- Modify: src/renderer/src/pages/Tasks.jsx
- Create: tests/main/notify/desktop.test.js
- Modify: tests/main/notify/NotificationEngine.test.js
- Modify: tests/main/health/MonitorHealth.test.js

**Interfaces:**
- Produces: createDesktopNotifier({ Notification, now, onEvent }).
- send(dropEvent) returns { supported, accepted, notificationId, error? }.
- NotificationEngine.getHealthSnapshot returns lastAttempt, lastShown, lastFailed, lastClicked, and activeCount.
- MonitorHealth snapshot adds notifications without changing Realtime classification.

- [ ] **Step 1: Write failing adapter and health tests**

Use a fake EventEmitter Notification. Test unsupported, constructor failure, accepted urgent stock alert with urgency critical and timeoutType never, ordinary checkout-step priority, and show/failed/click/close telemetry. Verify the adapter retains the instance until failed or close.

Inject NotificationEngine health into MonitorHealth and assert it appears separately without changing healthy monitor classification.

- [ ] **Step 2: Run and verify RED**

~~~powershell
npx vitest run tests/main/notify/desktop.test.js tests/main/notify/NotificationEngine.test.js tests/main/health/MonitorHealth.test.js
~~~

- [ ] **Step 3: Implement adapter, engine, and health plumbing**

Use a Map keyed by sanitized eventId, id, dropCycleId, or randomUUID fallback. Attach listeners before show. Emit only IDs, event names, timestamps, and capped error text. Remove retained objects on failed/close and cap active objects at 100.

NotificationEngine.fire awaits only construction/show, stores and returns the immediate result, and receives later events synchronously. Pass the engine into MonitorHealth from index.js.

In Tasks.jsx, add one concise line under monitor health:

~~~jsx
<span>
  Desktop alert: {notifications?.lastFailed ? 'failed' : notifications?.lastShown ? 'shown' : 'no evidence yet'}
</span>
~~~

Show timestamp and sanitized reason when present. Reuse MONITOR_HEALTH_GET; add no IPC channel.

- [ ] **Step 4: Run targeted and full verification**

~~~powershell
npx vitest run tests/main/notify tests/main/health/MonitorHealth.test.js tests/main/monitor/SupabaseMonitorSource.test.js tests/main/tasks/TaskManager.monitorHealth.test.js
npm run lint
npm test
npm run build
~~~

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/notify src/main/health/MonitorHealth.js src/main/index.js src/renderer/src/pages/Tasks.jsx tests/main/notify tests/main/health/MonitorHealth.test.js
git commit -m "feat: expose desktop alert delivery evidence"
~~~

## Plan verification

- Context7 confirms private Supabase channels require auth and that supabase-js already performs automatic reconnection; the plan removes the competing timer.
- Context7 confirms Electron supports isSupported, show, failed, click, close, urgency critical, and timeoutType never.
- Every new production interface has a failing-test step before implementation.
- Inventory affects only cart acquisition before submission and cannot loosen retry/reload caps.
- Notification telemetry cannot block or fail checkout.

