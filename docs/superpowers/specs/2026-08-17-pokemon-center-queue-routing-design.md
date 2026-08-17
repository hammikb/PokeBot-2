# Pokemon Center Queue Routing and Backoff Design

## Goal

Reduce proxy bandwidth and rotation churn without preventing the Pokemon Center page from rendering its queue/storefront state.

## Design

- Allow navigation documents, first-party JavaScript, and same-origin `xhr`/`fetch` requests.
- Continue aborting images, media, fonts, stylesheets, websockets, non-GET requests, and hosts outside an explicit first-party/queue allowlist.
- Match allowed hosts by exact host or safe subdomain suffix so queue/CDN subdomains are not accidentally blocked.
- Classify HTTP 200 security interstitials separately from generic browser failures.
- Add a global challenge backoff after repeated blocked/interstitial results across proxies; retain per-proxy quarantine for ordinary proxy failures.
- Keep bandwidth counters explicitly best-effort and remove the unused hard byte-cap helper rather than implying it enforces a cap.

## Verification

Focused standalone Python regression checks, `py_compile`, and a local dry-run of the request policy must pass before any Pi deployment. The Pi rollout remains reversible: back up the two queue files, copy the tested files, restart the service, and inspect fresh logs.
