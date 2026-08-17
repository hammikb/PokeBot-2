# Pokemon Center Browser Comparison

## Current production choice

Keep Chromium with Patchright for the queue monitor. Patchright's automation
patches are Chromium-focused, and the Pi already has Chromium 149 installed.
Firefox is not installed on the Pi and is not part of the current Python
environment.

Keep Chromium/CloakBrowser for Electron checkout. Checkout depends on the
existing Chromium profiles, cookies, account ownership, and Electron browser
integration.

## Optional Firefox diagnostic

If Firefox is evaluated later, install it and ordinary Playwright separately;
do not change the production service or reuse checkout profiles. Run the same
URL, proxy, timeout, interval, and request-routing policy against both browsers
for 50–100 checks. Record only sanitized values:

- browser availability
- classification (`storefront`, `queue`, `blocked`, or `error`)
- HTTP status and final host
- navigation duration
- proxied/aborted request counts and best-effort bytes
- browser restarts and peak RSS

Promote Firefox only if it improves valid detections without increasing
security challenges, latency, memory, or proxy bytes. Otherwise remove the
diagnostic and keep the Chromium path.

## HTTP-first diagnostic

Raw HTTP should also be tested separately before wiring it into the monitor.
Use the current proxy explicitly, set `trust_env=False`, cap the response body,
and classify only confident storefront/queue responses as successful. A raw
403 or security interstitial should feed the existing challenge backoff rather
than immediately launching a browser fallback.
