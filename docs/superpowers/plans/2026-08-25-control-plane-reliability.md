# Control Plane Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Pi, Vercel, Supabase, and Electron communication recoverable and diagnosable without changing checkout or queue execution.

**Architecture:** Keep Supabase Realtime as Electron's fast monitor path and use database catch-up as the durable path. Keep Vercel as the authenticated ingest/command API, with the Pi agent polling and atomically leasing commands. Persist only safe cursors and operational metadata locally; never move checkout credentials or browser state to the cloud.

**Tech Stack:** Electron main process, Supabase JS/Reatime, SQLite/JSON local DB, Next.js route handlers, Supabase Postgres migration, Python Pi agent, Vitest/Node tests.

**Spec:** `docs/superpowers/specs/2026-08-25-control-plane-reliability-design.md`

## Global Constraints

- Do not modify checkout, queue joining, browser profile, payment, or shipping behavior.
- Keep service credentials out of browser/Electron renderer code.
- Preserve existing API paths and allow-lists for compatibility.
- All new behavior requires a failing regression test before production code.
- Do not deploy or promote Vercel production from this plan; push source branches only, then merge to the requested base branches after verification.

---

### Task 1: Baseline and repository boundaries

**Files:**
- Read: Electron `package.json`, website `package.json`, Pi `deploy/pi_agent.py`
- Test: existing Electron and website suites

- [ ] **Step 1: Run baseline tests**

Run `npm test` in the Electron worktree and `npm test` in the website worktree. Record failures before changing code.

- [ ] **Step 2: Confirm Git boundaries**

Confirm Electron is `PokeBot-2`, website is `PokeAlert`, and `Test HTPPCLOACK` has no Git remote. Do not stage unrelated pre-existing changes.

### Task 2: Persist Electron monitor cursors and metrics

**Files:**
- Create: `src/main/monitor/MonitorDeliveryState.js`
- Modify: `src/main/monitor/SupabaseMonitorSource.js`
- Modify: `src/main/tasks/TaskManager.js`
- Test: `tests/main/monitor/MonitorDeliveryState.test.js`
- Test: `tests/main/monitor/SupabaseMonitorSource.test.js`

**Interfaces:**
- `MonitorDeliveryState.load(productId)` returns `{ observedAt: string, eventId: string } | null`.
- `MonitorDeliveryState.save(productId, cursor)` persists a bounded JSON record.
- `MonitorDeliveryState.clear(productId)` removes a product cursor.
- `SupabaseMonitorSource.getDeliveryMetrics()` returns `{ realtime, catchUp, duplicates, lastCatchUpAt }`.

- [ ] **Step 1: Write failing tests**

Cover round-tripping a cursor through the local settings table, restoring it before catch-up, counting duplicate deliveries, and clearing it when a product is released.

- [ ] **Step 2: Run the focused tests and verify failure**

Run `npm test -- tests/main/monitor/MonitorDeliveryState.test.js tests/main/monitor/SupabaseMonitorSource.test.js`. The new assertions must fail because the state adapter and metrics do not yet exist.

- [ ] **Step 3: Implement the state adapter and source integration**

Use the existing `settings` table with a namespaced key. Load the persisted cursor once per product, save the cursor after each accepted event, and keep the existing one-second overlap and in-memory duplicate suppression.

- [ ] **Step 4: Run focused tests**

Run the same command and verify all focused tests pass.

### Task 3: Version ingest events and add safe idempotency

**Files:**
- Create: website `supabase/migrations/20260825090000_ingest_delivery_receipts.sql`
- Modify: website `lib/ingest-payload.js`
- Modify: website `app/api/ingest/route.js`
- Modify: `deploy/target-stock-observer-go/main.go`
- Modify: `deploy/pi-health-reporter-go/main.go`
- Test: website `test/dashboard.test.js`
- Test: Go `deploy/target-stock-observer-go/main_test.go`

**Interfaces:**
- Ingest envelope fields: `schema_version`, `event_id`, `source`, `sent_at`, `attempt`, `type`, `payload`.
- Duplicate event responses remain HTTP 200 with `{ ok: true, duplicate: true }`.

- [ ] **Step 1: Write failing tests**

Test normalization of the envelope, rejection of malformed event IDs, duplicate receipt behavior, and preservation of existing drop payloads.

- [ ] **Step 2: Run tests and verify failure**

Run `npm test -- test/dashboard.test.js` and `go test ./...` in the Go observer directory. New assertions must fail before implementation.

- [ ] **Step 3: Implement the minimum envelope and receipt path**

Create a service-role-only receipt table keyed by `(source, event_id)`. Consume a valid envelope in the route, insert the receipt once, and treat a unique conflict as a successful duplicate. Attach the metadata to logs/health/inventory where columns already exist; do not change the drop schema beyond existing `source_event_id`.

- [ ] **Step 4: Run focused tests**

Run the website dashboard tests and Go tests again.

### Task 4: Harden Pi command processing

**Files:**
- Modify: `Test HTPPCLOACK/deploy/pi_agent.py`
- Modify: website `app/api/command/route.js`
- Create: website `supabase/migrations/20260825091000_pi_command_leases.sql`
- Test: `Test HTPPCLOACK/test_pi_agent.py`
- Test: website `test/dashboard.test.js`

**Interfaces:**
- Command lifecycle: `pending → running → done|error|expired`.
- Lease fields: `claimed_by`, `claimed_at`, `lease_expires_at`, `acknowledged_at`, `completed_at`.

- [ ] **Step 1: Write failing tests**

Cover expiration validation, reclaiming an abandoned running command, and ensuring a command is not executed twice by the same poller.

- [ ] **Step 2: Run the Python and website tests and verify failure**

Run `python -m unittest -v test_pi_agent.py` in `Test HTPPCLOACK` and `npm test -- test/dashboard.test.js` in the website worktree.

- [ ] **Step 3: Implement atomic lease updates and bounded recovery**

Have the agent claim only pending commands or expired leases, set a short lease before execution, persist acknowledgement before the handler, and expire abandoned leases. Keep the current action/service allow-lists and execution handlers unchanged.

- [ ] **Step 4: Run focused tests**

Run both test commands again and compile the agent with `python -m py_compile deploy/pi_agent.py`.

### Task 5: Expose transport and freshness health

**Files:**
- Modify: Electron `src/main/monitor/SupabaseMonitorSource.js`
- Modify: Electron `src/main/tasks/TaskManager.js`
- Modify: Electron `src/main/health/MonitorHealth.js`
- Modify: website `lib/dashboard-queries.js`
- Modify: website `app/MonitorCard.jsx`
- Test: Electron monitor/health tests
- Test: website `test/operations.test.js` and `test/dashboard.test.js`

- [ ] **Step 1: Write failing tests**

Assert that process heartbeat, telemetry reachability, Realtime subscription state, last event age, catch-up errors, and command-agent freshness are returned as separate fields.

- [ ] **Step 2: Run focused tests and verify failure**

Run the affected Electron Vitest files and website Node tests.

- [ ] **Step 3: Implement read-only health fields and UI labels**

Preserve existing status values for compatibility, but add separate diagnostic fields and display them without changing control actions.

- [ ] **Step 4: Run focused tests and build**

Run affected tests, `npm run build` in both projects, and Electron preload verification.

### Task 6: Verify, review, commit, and push

- [ ] **Step 1: Run full Electron verification**

Run `npm run verify` in the Electron worktree.

- [ ] **Step 2: Run full website verification**

Run `npm test` and `npm run build` in the website worktree.

- [ ] **Step 3: Review diffs and protect unrelated changes**

Run `git diff --check`, inspect staged file lists, and confirm no checkout/queue files changed.

- [ ] **Step 4: Commit each repository**

Commit the Electron and website changes separately with descriptive messages. Commit only intended files.

- [ ] **Step 5: Push requested base branches**

Merge the verified feature branches into the repositories' existing base branch (`master` for both discovered Git repositories), then push the base branch without force-pushing.
