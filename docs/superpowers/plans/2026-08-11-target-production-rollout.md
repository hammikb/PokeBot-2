# Target reliability production rollout implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Safely integrate, canary, deploy, and verify the approved Target monitoring, delivery, checkout, Realtime, and notification improvements.

**Architecture:** Build from an isolated snapshot that includes the user's current uncommitted checkout work, then apply changes in dependency order: backward-compatible database schema, preview web artifact, Pi canary and service restart, Electron integration and restart. Every mutable production step has a timestamped backup, objective health gates, and an explicit rollback target.

**Tech Stack:** Git worktrees, Supabase MCP, Vercel CLI 58.9.2, systemd/SSH, Electron/Vitest.

## Global Constraints

- Never expose or copy secrets into logs, plans, commits, command-line flags, or backup names.
- Do not modify, discard, stash-pop, reset, or commit the user's current primary-worktree changes.
- Apply the database migration before deploying code that writes new columns; all schema additions must be backward compatible.
- Deploy Vercel as a preview/prebuilt artifact, verify it, then promote the exact artifact.
- Back up Pi source/state with UTC timestamped names before replacing files.
- Keep Discord mentions disabled.
- Restart PokeBot only after the full integrated test/build passes and verify the new process start time.
- Any failed gate stops the rollout; do not continue by assumption.

---

### Task 1: Create an isolated integrated workspace and establish baselines

**Files:**
- Worktree: .worktrees/target-reliability
- Branch: codex/target-reliability
- Inputs: current HEAD plus a non-destructive snapshot of the primary worktree's tracked modifications.

**Interfaces:**
- Produces: isolated workspace containing both committed Target controller work and the user's uncommitted manual-takeover/warmup changes.
- Leaves: primary worktree byte-for-byte unchanged.

- [ ] **Step 1: Verify isolation prerequisites**

Run from the primary repository:

~~~powershell
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree
git check-ignore -v .worktrees
git status --short
~~~

Expected: normal checkout, no superproject, and .worktrees ignored.

- [ ] **Step 2: Create a non-destructive snapshot commit object**

Run git stash create without push/apply so the primary worktree is not changed. Record the returned object ID in memory only. Create branch codex/target-reliability from that object, then add .worktrees/target-reliability.

Verify the primary git status and file hashes are unchanged after creation.

- [ ] **Step 3: Install and run isolated baselines**

From the worktree:

~~~powershell
npm install
npm test
npm run build
python -m unittest discover -s tests/pi -v
~~~

For the unversioned PokeAlert web app:

~~~powershell
npm test
npm run build
~~~

If any baseline fails, stop and report the exact failure before implementation.

- [ ] **Step 4: Execute the two implementation plans inline**

Execute, in order:

1. docs/superpowers/plans/2026-08-11-target-monitoring-delivery.md
2. docs/superpowers/plans/2026-08-11-target-electron-resilience.md

Track every RED and GREEN command result. Do not skip commits between independently reviewable tasks.

### Task 2: Apply and verify the Supabase migration

**Files:**
- Apply: generated target_hotset_delivery migration.
- Verify: live project jbnnouwhesexfllninwb.

**Interfaces:**
- Produces: backward-compatible schema before any new writer is deployed.
- Rollback: disable seeded auto-watch rules first; additive nullable columns remain safe.

- [ ] **Step 1: Re-read final SQL and capture pre-migration evidence**

Query current column absence, current Target active/pinned counts, current five-minute cycle function definition, and current Realtime policies. Save no customer row contents.

- [ ] **Step 2: Apply through the Supabase migration tool**

Use the exact generated snake_case migration name and reviewed SQL. Do not use raw execute_sql for DDL.

- [ ] **Step 3: Verify schema and semantics**

Run read-only queries for columns, indexes, triggers, RLS policies, rule rows, automatic count, active Target count, and worker-health columns. Use a transaction-scoped synthetic product/drop fixture to verify source-event uniqueness and unchanged cycle grouping; roll it back.

- [ ] **Step 4: Run advisors**

Run both security and performance advisors. Distinguish pre-existing findings from findings introduced by this migration and remediate every new introduced finding before continuing.

### Task 3: Build, preview, and promote PokeAlert

**Files:**
- Project root: C:/Users/kaib1/OneDrive/Desktop/Projects/Test HTPPCLOACK/pokealert-web
- Link: existing single-project .vercel/project.json
- CLI: vercel 58.9.2

**Interfaces:**
- Produces: one verified immutable preview artifact promoted to production.
- Rollback: previously recorded production deployment URL.

- [ ] **Step 1: Record current production deployment and verify project identity**

Run from the linked web root:

~~~powershell
npx --yes vercel@58.9.2 whoami
npx --yes vercel@58.9.2 ls
~~~

Confirm the linked project name is pokealert without printing IDs/tokens. Record the current production URL for rollback.

- [ ] **Step 2: Pull preview settings, build, and deploy prebuilt**

~~~powershell
npx --yes vercel@58.9.2 pull --yes --environment=preview
npx --yes vercel@58.9.2 build
$previewUrl = npx --yes vercel@58.9.2 deploy --prebuilt
~~~

Capture the preview URL from stdout.

- [ ] **Step 3: Verify preview through Vercel protection**

Use vercel curl against / and /api/watchlist with only authorized test headers already present in the local secure environment. POST malformed source_event_id and expect 500/validation response without a row. POST a valid UUID for a non-buyable synthetic product once, replay it, and verify one Supabase row total.

Inspect preview build/runtime logs and require zero new error-level entries from these checks.

- [ ] **Step 4: Promote the exact preview**

~~~powershell
npx --yes vercel@58.9.2 promote $previewUrl
npx --yes vercel@58.9.2 inspect $previewUrl --wait
~~~

After promotion, repeat watchlist and idempotency checks against production. If either fails, run vercel rollback with the recorded deployment URL.

### Task 4: Canary and deploy the Pi monitor and schedule agent

**Files:**
- Source backup: `/home/hammikb/api-monitor-python/ApiMonitor.py.backup-$rolloutUtc`
- State backup: `/home/hammikb/api-monitor-python/api_monitor_state.json.backup-$rolloutUtc`
- Agent backup: `/opt/pokealert-agent/pi_agent.py.backup-$rolloutUtc`
- Deploy: target_reliability.py plus patched ApiMonitor.py and pi_agent.py.

**Interfaces:**
- Produces: durable outbox dispatch, incremental watcher batches, 15-second watchlist refresh, dated schedule overrides, and worker health evidence.
- Rollback: restore all three matching UTC backups and restart only affected services.

- [ ] **Step 1: Capture live pre-deploy evidence**

Set `rolloutUtc=$(date -u +%Y%m%dT%H%M%SZ)` once and retain it for every backup in this rollout. Record service active state, main PID/start time, last 100 non-secret log lines, watchlist count, current schedule hash, state-file hash, and current outbox absence. Confirm disk space and Pi temperature remain healthy.

- [ ] **Step 2: Create backups and stage files**

Resolve every absolute target and verify it is under /home/hammikb/api-monitor-python or /opt/pokealert-agent before copying. Back up source/state/agent, upload to /tmp/pokealert-canary, compile there, and run local plus remote unit tests.

- [ ] **Step 3: Run a no-delivery canary**

Run the patched monitor against a temporary state file with delivery shadow enabled and without the production Discord destination. Require two complete watchlist cycles, expected bounded product/context counts, no uncaught task errors, and no all-batch rebuild when one synthetic watchlist item changes.

- [ ] **Step 4: Deploy monitor and restart only api-monitor.service**

Install the tested module and patched source atomically, then:

~~~bash
restartUtc=$(date -u --iso-8601=seconds)
sudo systemctl restart api-monitor.service
systemctl is-active api-monitor.service
systemctl show api-monitor.service -p MainPID -p ActiveEnterTimestamp
journalctl -u api-monitor.service --since "$restartUtc" --no-pager
~~~

Require active status, new PID/start time, expected hot-set count, outbox depth zero, successful watchlist heartbeat, and two Target cycles without a global block storm.

- [ ] **Step 5: Deploy agent and verify dated schedule behavior**

Install the tested agent patch atomically and restart pokealert-agent.service. Submit or locally invoke a non-current test date override and verify the ordinary window remains active now; validate one current-date override using schedule calculation only, then restore the approved schedule file. Confirm worker health shows active profile and next transition.

- [ ] **Step 6: Verify durable Discord evidence without mentions**

Use one synthetic non-buyable event. Require cloud HTTP 2xx, one Supabase row, Discord HTTP 2xx, a returned Discord message ID, outbox returns to zero, and no mention field/content. Replay the same source_event_id and require one Supabase row.

If delivery fails, retain the outbox and investigate; do not mark success or delete state.

### Task 5: Integrate, verify, and restart Electron

**Files:**
- Source: isolated codex/target-reliability branch.
- Destination: primary worktree with existing uncommitted user changes.

**Interfaces:**
- Produces: one primary working tree containing both prior user changes and the verified reliability changes.
- Rollback: feature branch remains intact; primary pre-integration diff/hash inventory is recorded.

- [ ] **Step 1: Record primary state and identify overlap**

Re-run git status and hashes for every modified primary file. Compare the feature branch to the non-destructive snapshot parent. Classify files as new/non-overlap or overlap. Expect TaskManager.js, Tasks.jsx, and their tests to overlap.

- [ ] **Step 2: Port only feature deltas**

Apply new/non-overlap commits normally only when Git proves they do not touch dirty paths. For overlaps, use apply_patch against the current primary file, preserving manual takeover, warmupUrl, package upgrades, BrowserPool changes, and existing tests. Do not reset, checkout, or overwrite whole dirty files.

- [ ] **Step 3: Run the complete integrated verification**

From the primary worktree:

~~~powershell
npm run check:structure
npm run lint
npm test
npm run test:electron
python -m unittest discover -s tests/pi -v
~~~

Require all commands exit 0. Re-run the focused Target controller, Supabase source, TaskManager, NotificationEngine, and MonitorHealth tests after the full suite.

- [ ] **Step 4: Verify runtime configuration before restart**

Inspect built output/log configuration and require TARGET_CART_STRATEGY browser, 100 ms polling, 1.5-second outcome, 400 ms transient delay, 30 retry cap, two reloads, 120-second fallback, and 600-second healthy-stock ceiling.

- [ ] **Step 5: Restart PokeBot and prove it loaded the new code**

Resolve the current PokeBot/Electron process command and executable. Stop only that exact process tree, launch the same approved command from the primary project, and verify:

- process start time is after the build;
- startup logs show browser-only Target policy;
- restored Supabase channels reach SUBSCRIBED plus catch-up;
- no 1.5-second CLOSED reconnect loop appears for at least two minutes;
- a synthetic desktop alert records shown or an explicit supported/failed result;
- no real order submission occurs during canaries.

### Task 6: Final operational verification and rollback record

**Files:**
- Update: docs/superpowers/plans/2026-08-11-target-production-rollout.md checkboxes/results.
- Create only if useful: docs/operations/2026-08-11-target-reliability-rollout.md without secrets.

- [ ] **Step 1: Verify the complete path**

For one synthetic event, record timestamps for Pi detection, durable state write, cloud acknowledgment, Electron receipt, desktop notification event, Discord acknowledgment/message ID, and outbox drain. Assert exactly one cloud row after replay.

- [ ] **Step 2: Verify live health for ten minutes**

Require stable Pi service, expected Target checks, acceptable block rate relative to the pre-deploy baseline, no growing outbox, no Realtime loop, no unhandled Electron errors, and no Vercel 5xx from changed routes.

- [ ] **Step 3: Record rollback commands and backup names**

Document the exact previous Vercel URL, Pi backup paths, migration feature-disable SQL, and PokeBot branch/process command. Do not include secrets.

- [ ] **Step 4: Run fresh final verification**

Run all commands from Task 5 Step 3 again and read complete output. Query Supabase advisors again after live validation. Only then claim completion.

## Plan verification

- Rollout order prevents new writers from preceding the schema.
- Preview deployment is promoted without rebuild.
- Pi and Electron restarts target exact services/processes and have start-time evidence.
- Primary dirty changes are preserved through a snapshot-based worktree and overlap-aware port.
- Every production mutation has a recorded rollback target.
