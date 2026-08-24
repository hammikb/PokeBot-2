# Target Bulk Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the production Go Target observer to batched fulfillment checks while preserving per-product recovery and a reversible rollback path.

**Architecture:** The observer will collect the existing watchlist TCINs, split them into batches of 24, and query Target's fulfillment-summary endpoint through reserved proxy sessions. A failed batch will retry through available proxies; any batch failure or missing TCIN will fall back to the existing per-product checker for only the affected products.

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

### Task 2: Retry and targeted fallback

**Files:**
- Modify: `deploy/target-stock-observer-go/main.go`
- Test: `deploy/target-stock-observer-go/main_test.go`

- [ ] Add failing tests proving a failed batch can be retried and that only failed or missing products use the per-product fallback.
- [ ] Reserve proxies for bulk requests and release them on success or failure.
- [ ] Reuse the existing per-product failover path for fallback products.

### Task 3: Production deployment

**Files:**
- Modify: `deploy/target-stock-observer-go/target-stock-observer-go.service`

- [ ] Run `go test ./...`, `go vet ./...`, and a Linux ARM64 build.
- [ ] Back up the current Pi binary, source, and service unit.
- [ ] Enable bulk mode in the Target Go service only.
- [ ] Restart only `target-stock-observer-go.service`.

### Task 4: Verification

- [ ] Confirm the service reports bulk mode and the expected 44-product watchlist.
- [ ] Confirm complete bulk cycles and targeted fallback behavior in journald.
- [ ] Confirm `api-monitor.service` and `pokemon-center-queue.service` remain inactive and no Electron process was restarted.
