# Pokémon Center Queue Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Pi's continuously blocked raw-HTTP Pokémon Center detector with a persistent, proxy-only Chromium monitor that reports truthful state and preserves the existing `queue_open` integration.

**Architecture:** Pure classification, transition, proxy-health, and telemetry logic lives in a dependency-free core module. The service script owns one Patchright Chromium process and recreates only its proxy-bound context/page when blocked or broken, while existing `httpx` clients continue to publish logs, Discord alerts, and drop events. Deployment retains the current systemd service identity and Supabase payload contract.

**Tech Stack:** Python 3, Patchright async API, httpx, standalone Python regression tests, systemd, Supabase/Vercel ingest, Electron/Vitest compatibility tests.

## Global Constraints

- All Pokémon Center fetches must use a configured proxy; never fall back to the Pi's home IP.
- Only explicit queue evidence may emit `queue_open`.
- Blocked, error, and unknown observations must not open or close a queue cycle.
- Preserve `retailer: pokemon-center`, `product_key: site-queue`, and `drop_type: queue_open`.
- Never log proxy credentials, tokens, cookies, or raw page HTML.
- Keep one Chromium process and at most one active browser context/page.
- Commit completed work to local `master` without staging unrelated user changes.

---

### Task 1: Pure detector state and proxy policy

**Files:**
- Create: `scripts/pokemon_center_queue_core.py`
- Modify: `scripts/tests/test_pokemon_center_queue_classifier.py`

**Interfaces:**
- Produces: `Observation(kind, status, url, detail)`, `classify_observation(status, url, frame_texts) -> Observation`, `QueueTransitionTracker.observe(observation) -> str | None`, `ProxyHealthPool.current() -> tuple[int, str]`, `record_success(index)`, `record_failure(index, now)`, and `rotate(now) -> tuple[int, str]`.
- Consumes: literal frame text and status values captured by the browser boundary in Task 2.

- [ ] **Step 1: Write failing classifier tests**

Add literal cases proving queue copy becomes `queue`, recognizable navigation/storefront copy becomes `storefront`, HTTP 403 and Imperva/CAPTCHA frames become `blocked`, and an empty HTTP 200 page becomes `error`. Keep compatibility assertions for `queue_state_from_text` until callers migrate.

- [ ] **Step 2: Run classifier tests and verify RED**

Run: `python scripts/tests/test_pokemon_center_queue_classifier.py`

Expected: FAIL because `pokemon_center_queue_core` and its classifier do not exist.

- [ ] **Step 3: Implement the minimal pure classifier**

Create a frozen `Observation` dataclass and classify in strict order: blocked status/text, explicit queue markers, valid storefront markers, then error. Store only bounded, non-sensitive detail.

- [ ] **Step 4: Run classifier tests and verify GREEN**

Run: `python scripts/tests/test_pokemon_center_queue_classifier.py`

Expected: PASS with the classifier regression success message.

- [ ] **Step 5: Write failing transition and proxy-policy tests**

Add cases proving: one queue observation opens once; blocked/error observations preserve the last known state; two valid storefront observations close an open queue; failed proxies are quarantined; a known-good proxy is preferred; cooldown makes a quarantined proxy eligible again; and no eligible proxy raises instead of returning a direct connection.

- [ ] **Step 6: Run policy tests and verify RED**

Run: `python scripts/tests/test_pokemon_center_queue_classifier.py`

Expected: FAIL because `QueueTransitionTracker` and `ProxyHealthPool` do not exist.

- [ ] **Step 7: Implement transition and proxy policy**

Use explicit state, consecutive-valid-close counting, per-proxy failure counts, cooldown deadlines, and last-success ranking. Do not let blocked/error observations mutate queue-open state.

- [ ] **Step 8: Run focused tests and commit**

Run: `python scripts/tests/test_pokemon_center_queue_classifier.py`

Expected: PASS.

Commit only the core module and its test:

```bash
git add scripts/pokemon_center_queue_core.py scripts/tests/test_pokemon_center_queue_classifier.py
git commit -m "feat: model pokemon center queue health"
```

### Task 2: Persistent proxy-only browser probe

**Files:**
- Modify: `scripts/pokemon_center_queue_monitor.py`
- Create: `scripts/tests/test_pokemon_center_queue_browser.py`

**Interfaces:**
- Consumes: `classify_observation`, `ProxyHealthPool`, and `Observation` from Task 1.
- Produces: `BrowserQueueProbe.start()`, `check() -> Observation`, `rotate(now)`, and `close()`; `check()` retains the current context after success and returns classified failures rather than throwing routine site blocks.

- [ ] **Step 1: Write a failing persistent-session test**

Use complete asynchronous fakes for the Patchright browser/context/page boundary. Make two checks and assert the same browser context is reused, the configured proxy is passed to `new_context`, and nonessential resources are aborted.

- [ ] **Step 2: Run the browser test and verify RED**

Run: `python scripts/tests/test_pokemon_center_queue_browser.py`

Expected: FAIL because `BrowserQueueProbe` does not exist.

- [ ] **Step 3: Implement minimal browser lifecycle**

Move the production Pokémon Center fetch from `httpx` to one Patchright Chromium process. Create one proxy-bound context/page, apply resource routing, gather bounded text from all frames, include the main response status and final URL, and call the pure classifier.

- [ ] **Step 4: Run the browser test and verify GREEN**

Run: `python scripts/tests/test_pokemon_center_queue_browser.py`

Expected: PASS.

- [ ] **Step 5: Write failing recovery tests**

Add cases proving a blocked observation quarantines and rotates the proxy/context after the configured threshold, a destroyed page is recreated, proxy credentials do not appear in labels/errors, and exhaustion raises without launching a direct context.

- [ ] **Step 6: Run recovery tests and verify RED**

Run: `python scripts/tests/test_pokemon_center_queue_browser.py`

Expected: FAIL on missing recovery behavior.

- [ ] **Step 7: Implement recovery and cleanup**

Close the old page/context on rotation, keep the single Chromium process, choose the next eligible proxy through `ProxyHealthPool`, count restarts/rotations, and close all resources in `finally` and on cancellation.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
python scripts/tests/test_pokemon_center_queue_classifier.py
python scripts/tests/test_pokemon_center_queue_browser.py
python -m py_compile scripts/pokemon_center_queue_core.py scripts/pokemon_center_queue_monitor.py
```

Expected: all commands exit 0.

Commit only the browser implementation and test:

```bash
git add scripts/pokemon_center_queue_monitor.py scripts/tests/test_pokemon_center_queue_browser.py
git commit -m "feat: monitor pokemon center with persistent browser"
```

### Task 3: Transition-safe alerts and remote health

**Files:**
- Modify: `scripts/pokemon_center_queue_monitor.py`
- Modify: `scripts/tests/test_pokemon_center_queue_browser.py`
- Modify: `scripts/systemd/pokemon-center-queue.service`
- Modify: `scripts/README.md`

**Interfaces:**
- Consumes: browser observations and transition decisions from Tasks 1-2.
- Produces: bounded health snapshots sent through `remote_log`, transition-triggered `publish_queue_open`, and environment settings for failure threshold, proxy cooldown, heartbeat interval, and navigation timeout.

- [ ] **Step 1: Write failing orchestration tests**

Drive a finite monitor-cycle helper with literal observation sequences. Prove `storefront -> queue -> queue` publishes once, `queue -> blocked -> error` does not close, `queue -> storefront -> storefront` closes once, and a failed publisher remains retryable without inventing a new site transition.

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `python scripts/tests/test_pokemon_center_queue_browser.py`

Expected: FAIL because finite cycle orchestration/health snapshots are missing.

- [ ] **Step 3: Implement transition-safe orchestration**

Replace the raw-HTTP loop with browser observations and `QueueTransitionTracker`. Preserve the persisted open flag, retry an undelivered open alert, and use the normal/open intervals only after valid state observations.

- [ ] **Step 4: Add and verify health snapshots**

Track total/success/failed checks, last check/success, status, state, consecutive failures, proxy label/state, browser restarts, rotations, and a bounded error category/message. Publish on state changes, failure thresholds, rotations, and the configured heartbeat interval; keep routine polls local and quiet.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
python scripts/tests/test_pokemon_center_queue_classifier.py
python scripts/tests/test_pokemon_center_queue_browser.py
python scripts/tests/test_pokebot_push.py
python -m py_compile scripts/pokemon_center_queue_core.py scripts/pokemon_center_queue_monitor.py
```

Expected: all commands exit 0.

- [ ] **Step 6: Document and configure operations**

Add exact environment defaults to the systemd template for blocked/error rotation threshold, proxy cooldown, heartbeat, and navigation timeout. Update the script index with the browser-first behavior, expected memory profile, health fields, and diagnostic command.

- [ ] **Step 7: Commit the orchestration unit**

```bash
git add scripts/pokemon_center_queue_monitor.py scripts/tests/test_pokemon_center_queue_browser.py scripts/systemd/pokemon-center-queue.service scripts/README.md
git commit -m "feat: report pokemon center detector health"
```

### Task 4: Compatibility, deployment, and live verification

**Files:**
- Modify only if a proven defect is found: `scripts/diagnostics/diagnose_pokemon_center_queue.py`
- No expected changes: `src/main/tasks/TaskManager.js`, `src/main/monitor/SupabaseMonitorSource.js`

**Interfaces:**
- Consumes: the final monitor script, core module, test files, and systemd environment.
- Produces: a backed-up Pi deployment and fresh evidence that scheduled checks work through Chromium while Electron's event contract remains intact.

- [ ] **Step 1: Run the complete local verification set**

Run:

```bash
python scripts/tests/test_pokemon_center_queue_classifier.py
python scripts/tests/test_pokemon_center_queue_browser.py
python scripts/tests/test_pokebot_push.py
npx vitest run tests/main/automation/PokemonCenterQueueJoiner.test.js tests/main/automation/retailer-fixtures.test.js tests/main/tasks/TaskManager.supabase.test.js
npm run lint
npm run build
```

Expected: all commands exit 0 with zero failed tests and zero lint/build errors.

- [ ] **Step 2: Back up and deploy to the Pi**

Copy the deployed monitor to a timestamped backup, upload the core module, monitor, and tests to `/home/hammikb/api-monitor-python`, validate syntax/tests on the Pi, then install only the reviewed environment additions and restart `pokemon-center-queue.service`.

- [ ] **Step 3: Verify the live browser path**

Run the one-shot diagnostic and inspect fresh service journal entries. Require a valid `storefront` or `queue` observation through a non-secret proxy label, no direct-IP fallback, and a structured health heartbeat.

- [ ] **Step 4: Observe scheduled checks and resource use**

Wait for multiple configured check intervals, then verify the same healthy browser session remains active, the journal is not in a rapid warning loop, memory remains acceptable, and service restart count is stable.

- [ ] **Step 5: Verify integration and repository state**

Confirm the Supabase/Electron focused tests still pass, inspect `git diff --check`, confirm every intended file is committed on local `master`, and leave unrelated working-tree changes untouched.
