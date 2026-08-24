# Target Bulk Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the production Go Target observer to batched fulfillment checks with proxy-only retry, batch deferral, and a reversible rollback path.

**Architecture:** The observer will collect the existing watchlist TCINs, split them into batches of 24, and query Target's fulfillment-summary endpoint through reserved proxy sessions. A failed batch will retry the same bulk request through available proxies; an exhausted batch or missing TCIN will be recorded as deferred and retried on the next cycle. The monitor will never fan out into per-product requests.

**Tech Stack:** Go, Target RedSky fulfillment endpoint, Pi systemd service, existing proxy pool, Supabase/Vercel ingest.

**Spec:** User-approved bulk approach with a Pi backup before deployment.

## Global Constraints

- All Target requests must remain Pi proxy-only.
- Do not modify or restart Electron, checkout, or queue services.
- Keep the current production binary recoverable on the Pi.
- Do not log API keys, proxy credentials, or ingest tokens.

### Task 1: Bulk request and response parsing

**Files:**
- Modify: `deploy/target-stock-observer-go/main.go`
- Test: `deploy/target-stock-observer-go/main_test.go`

- [ ] Add failing tests for TCIN batching, bulk response parsing, and missing-TCIN detection.
- [ ] Add a bulk request builder using `product_summary_with_fulfillment_v1` and `tcins` batches capped at 24.
- [ ] Parse `data.product_summaries` into the existing observation model.

### Task 2: Bulk-only retry and defer

**Files:**
- Modify: `deploy/target-stock-observer-go/main.go`
- Test: `deploy/target-stock-observer-go/main_test.go`

- [ ] Add failing tests proving a failed batch can be retried through another proxy and never uses per-product fallback.
- [ ] Reserve proxies for bulk requests and release them on success or failure.
- [ ] Defer an exhausted or incomplete batch to the next cycle without creating individual requests.

### Task 3: Production deployment

**Files:**
- Modify: `deploy/target-stock-observer-go/target-stock-observer-go.service`

- [ ] Run `go test ./...`, `go vet ./...`, and a Linux ARM64 build.
- [ ] Back up the current Pi binary, source, and service unit.
- [ ] Enable bulk mode in the Target Go service only.
- [ ] Restart only `target-stock-observer-go.service`.

### Task 4: Verification

- [ ] Confirm the service reports bulk mode and the expected 44-product watchlist.
- [ ] Confirm complete bulk cycles, proxy-only bulk retries, and deferred-batch behavior in journald.
- [ ] Confirm `api-monitor.service` and `pokemon-center-queue.service` remain inactive and no Electron process was restarted.
