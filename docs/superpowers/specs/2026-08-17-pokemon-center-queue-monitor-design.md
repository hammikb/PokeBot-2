# Pokémon Center Queue Monitor Reliability Design

**Date:** 2026-08-17

## Problem

The Raspberry Pi service `pokemon-center-queue.service` is active but its detector is not healthy. From its 2026-08-14 restart through inspection on 2026-08-17, it recorded 250 consecutive failed checks, overwhelmingly HTTP 403 responses from Pokémon Center's Imperva protection. Cycling through the configured Webshare proxies did not restore raw HTTP access.

The deployed script imports Patchright but production uses only `httpx`. Its existing Chromium diagnostic loaded the real storefront through two of the first four sampled proxies. This establishes that the browser path is viable with the existing Pi and proxy pool. The Pi had approximately 3.2 GB of available memory during inspection, enough for one resource-limited persistent Chromium session.

The Electron queue joiner is downstream of the Pi detector. Its existing Supabase subscription and `queue_open` contract must remain compatible.

## Goals

- Detect a real Pokémon Center virtual queue reliably from the headless Pi.
- Never interpret an Imperva challenge, HTTP error, empty document, or navigation failure as a queue transition.
- Retain a successful browser identity instead of starting a fresh client on every check.
- Recover automatically from blocked proxies and crashed browser pages.
- Keep bandwidth and Pi resource usage bounded.
- Make the detector's true health visible remotely without requiring SSH access.
- Preserve the current `queue_open` event contract consumed by Supabase, Vercel, and Electron.
- Keep the previous lightweight implementation available through Git history and avoid unrelated changes.

## Non-goals

- Solving or bypassing interactive CAPTCHAs.
- Automating Pokémon Center checkout.
- Replacing the existing Supabase fan-out or Electron queue-joining browser in this project.
- Running multiple simultaneous Chromium browsers for this single site.

## Selected Architecture

Use one persistent headless Patchright/Chromium browser as the production detector. The detector owns one browser context and one page tied to a selected proxy. A successful storefront response preserves that context, including cookies, for future checks. A blocked or broken context is discarded before rotating to another proxy.

Raw `httpx` remains appropriate for the PokeAlert ingest, watchlist, and Discord endpoints, but it will no longer fetch Pokémon Center. A raw-HTTP fallback is intentionally excluded because it currently fails every observed production request and adds traffic without producing signal.

### State classifier

Each browser observation produces one of four explicit states:

- `storefront`: a valid Pokémon Center page with recognizable storefront evidence and no queue markers.
- `queue`: explicit queue copy, or a Queue-it/waiting-room URL together with queue copy.
- `blocked`: HTTP 403/429, Imperva/CAPTCHA frame, access restriction, or device-verification interstitial.
- `error`: navigation timeout, destroyed browser/page, empty or otherwise unclassifiable response.

Only `queue` can open a queue cycle. Only consecutive valid `storefront` observations can close one. `blocked` and `error` preserve the last known queue state and cannot emit either transition.

### Browser and proxy lifecycle

- Launch one headless Chromium process with `--no-sandbox` and `--disable-dev-shm-usage` for Pi compatibility.
- Create a context and page for the selected proxy; retain them after successful checks.
- Abort images, media, fonts, stylesheets, and known nonessential analytics/advertising requests.
- Navigate to the configured Pokémon Center URL at the existing normal cadence.
- After repeated `blocked` or `error` observations, close the affected context, quarantine that proxy for a bounded cooldown, and create a fresh context on the next eligible proxy.
- Prefer previously successful proxies while still allowing quarantined proxies to be retried after cooldown.
- If the page or Chromium process crashes, rebuild it through the same recovery path.
- Never fall back to the Pi's home IP when the proxy configuration is missing or exhausted.

### Transition and alert behavior

- Persist the queue-open state across service restarts as today.
- Emit one Supabase/Discord alert when a valid observation changes from non-queue to queue.
- Require the configured number of consecutive valid storefront observations before declaring a queue closed.
- Do not repeat an open alert while the same queue cycle remains active.
- If publishing fails, retain enough state to retry delivery without fabricating a new site transition.

### Remote observability

Publish structured detector health through the existing PokeAlert ingest/log path. Health must include:

- detector state (`storefront`, `queue`, `blocked`, or `error`)
- last successful observation time
- last check time
- last HTTP status when available
- consecutive failure count
- successful and failed check totals
- rolling or lifetime success percentage
- non-secret proxy identifier/index and proxy health state
- browser/context restart and proxy-rotation counts
- last error category and bounded error message

Routine checks should not produce one remote log per poll. Publish immediately on state transitions and failures crossing meaningful thresholds, plus a periodic heartbeat. Local journal entries should follow the same transition-oriented pattern.

No proxy credentials, ingest tokens, cookies, page HTML, or sensitive browser state may be logged.

## Integration Boundaries

The Pi continues publishing `queue_open` through the existing ingest endpoint with the current product identity (`retailer: pokemon-center`, `product_key: site-queue`). Supabase schema and Electron subscription payloads do not change.

The Electron `PokemonCenterQueueJoiner` remains a separate downstream component. Compatibility verification must prove that a representative `queue_open` event still reaches its existing handler. Electron-specific admission and cooldown weaknesses discovered during inspection are tracked separately and are not required to replace the failed Pi detector.

## Testing Strategy

- Unit-test classification of storefront, queue, Imperva verification, CAPTCHA/access restriction, HTTP failures, and empty pages.
- Unit-test queue transition rules so blocked/error observations cannot open or close a queue.
- Unit-test proxy quarantine, preference, cooldown expiry, and fail-closed behavior.
- Unit-test alert deduplication and retryable publication state.
- Exercise the browser observation boundary with controlled fake pages/responses; external network calls remain outside unit tests.
- Run the existing Python and JavaScript suites that protect the Supabase/Electron `queue_open` contract.
- On the Pi, run the one-shot browser diagnostic, deploy, restart the service, and verify fresh journal evidence of a valid storefront observation plus a healthy remote heartbeat.
- Observe multiple scheduled checks to ensure the persistent session remains healthy and no rapid 403 loop returns.

## Rollout and Recovery

Deploy the versioned script and unit file through the repository's existing SSH deployment workflow. Before restart, preserve the currently deployed script as a timestamped backup on the Pi. Validate Python syntax and focused tests locally and on the Pi before switching the service.

If production verification fails, restore the backup script and restart the service. Because the existing implementation is already blind, rollback is operationally safe but must remain available.

## Success Criteria

- A browser observation loads and classifies the live storefront through at least one configured proxy.
- Scheduled production checks record successful observations instead of an uninterrupted 403 sequence.
- Blocked proxies rotate without exposing the home IP or generating false queue alerts.
- A synthetic queue fixture emits exactly one compatible `queue_open` event.
- Detector health is understandable from the website/log feed without SSH.
- Focused Python tests, relevant Electron/Supabase tests, and deployment smoke checks pass.
