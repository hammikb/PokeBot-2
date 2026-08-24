# Target Proxy Pool Reliability Implementation Plan

**Goal:** Raise the percentage of complete 44-product Target bulk cycles without increasing requests or falling back to per-product checks.

**Architecture:** Keep the existing two-batch bulk workflow and proxy-only network boundary. Give every sticky proxy a long-lived HTTP client and cookie jar, rank ready proxies by observed Target success with controlled exploration, persist anonymized health counters across restarts, and publish one compact pool/cycle summary.

**Tech Stack:** Go standard library, systemd, Raspberry Pi ARM64.

---

### Task 1: Lock behavior with tests

- Add tests for persistent per-proxy clients.
- Add tests for proven-proxy preference and controlled exploration.
- Add tests for credential-free health persistence.
- Add tests for compact proxy-pool and full-cycle metrics.
- Run the focused Go tests and confirm the new tests fail before implementation.

### Task 2: Implement the reliability changes

- Store one reusable HTTP client/cookie jar per proxy.
- Prefer proven ready proxies while periodically testing unproven proxies.
- Preserve and restore health by anonymized proxy ID using an atomic mode-0600 state file.
- Summarize proven, unproven, cooling, and degraded proxies plus complete-cycle rate.
- Leave batch size 24, two bulk batches, and two failovers unchanged.

### Task 3: Verify and deploy

- Run `gofmt`, the complete Go test suite, `go vet`, and an ARM64 build.
- Back up the Pi binary, unit file, and health state before deployment.
- Deploy only `target-stock-observer-go`, reload systemd, and restart only that service.
- Inspect live logs and service state across multiple polling cycles.
- Commit only the focused Target monitor files and push `master`.
