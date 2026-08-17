# Pokemon Center Queue Routing and Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the queue detector cheaper and more reliable by allowing required first-party scripts, preserving static/third-party blocking, and backing off during site-wide challenges.

**Architecture:** Keep routing and backoff decisions pure in `pokemon_center_queue_core.py`; have `BrowserQueueProbe` enforce the routing policy and expose counters; have the controller/run loop apply a global challenge pause without changing queue transition semantics.

**Tech Stack:** Python 3, Patchright, asyncio, standalone regression scripts.

## Global Constraints

- Do not remove the Python monitor or deploy to the Pi until local checks pass.
- Do not log page bodies, cookies, proxy credentials, or ingest tokens.
- Keep direct-IP fallback disabled.

### Task 1: Safer request routing

**Files:**
- Modify: `scripts/pokemon_center_queue_core.py`
- Modify: `scripts/pokemon_center_queue_monitor.py`
- Test: `scripts/tests/test_pokemon_center_queue_classifier.py`
- Test: `scripts/tests/test_pokemon_center_queue_browser.py`

- [ ] Add failing cases proving first-party scripts and queue subdomains continue while third-party/static requests abort.
- [ ] Run both standalone tests and observe the expected failures.
- [ ] Implement suffix-aware first-party host matching and the revised resource policy.
- [ ] Run both standalone tests and `py_compile`.

### Task 2: Challenge classification and global backoff

**Files:**
- Modify: `scripts/pokemon_center_queue_core.py`
- Modify: `scripts/pokemon_center_queue_monitor.py`
- Test: `scripts/tests/test_pokemon_center_queue_classifier.py`

- [ ] Add failing cases for HTTP 200 security interstitial classification and challenge backoff thresholds.
- [ ] Run the classifier test and observe the expected failures.
- [ ] Implement pure `ChallengeBackoff` state with bounded exponential pause and reset after valid storefront/queue observations.
- [ ] Apply the pause in the monitor loop without rotating for every challenge.
- [ ] Run focused tests and compilation.

### Task 3: Cleanup and verification

**Files:**
- Modify: queue files only as needed after tests.

- [ ] Remove unused byte-cap constants/helpers or wire them into real behavior; choose removal for this scope.
- [ ] Run focused regression scripts, `py_compile`, and `git diff --check`.
- [ ] Review the final diff for secrets and unrelated files.
- [ ] Only after explicit deployment approval, back up and canary the Pi service.
