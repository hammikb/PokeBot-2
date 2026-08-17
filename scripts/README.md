# Script Index

The npm scripts in `package.json` are the normal entry points for desktop
development, validation, and packaging. Files in this directory fall into the
following groups.

## Desktop build and validation

- `clean-build-artifacts.mjs` — removes generated build directories.
- `optional-native-rebuild.js` — best-effort Electron native dependency rebuild.
- `run-electron-vite.mjs` — starts Electron Vite in development or preview mode.
- `validate-release-env.mjs` — blocks release publishing when signing variables are missing.
- `verify-electron-preload.mjs` — packaged preload/auth smoke test.
- `scrapling_lookup.py` — optional local product lookup helper.

## Production Pi monitoring

- `pokemon_center_queue_monitor.py` — persistent, proxy-only Chromium detector for the Pokemon Center waiting room.
- `target_stock_observer.py` — low-bandwidth Target availability observer.
- `walmart_restock_scanner.py` — low-bandwidth Walmart restock scanner.
- `walmart_queue_rank_tracker.mjs` — broad, low-bandwidth Walmart category and queue detector.
- `monitor_walmart_pokemon.mjs` — legacy Node Walmart monitor.
- `pokebot_drop_pusher.py` — reusable Supabase drop publishing module.

These monitors are proxy-sensitive. Review their environment variables and
fail-closed behavior before installing them on a Pi.

### Pokemon Center detector operations

The Pokemon Center detector keeps one headless Chromium process and one
proxy-bound browser context alive between checks. It blocks images, media,
fonts, and stylesheets to reduce bandwidth. A blocked context is replaced only
after repeated failures, and a quarantined proxy is not retried until its
cooldown expires. It never falls back to the Pi's home IP.

Its periodic remote health record includes the classified state, last HTTP
status, last successful check, success percentage, consecutive failures,
non-secret proxy label, rotations, and browser restarts. Use the existing logs
page to distinguish a healthy `storefront` state from `blocked` or `error`.

Relevant systemd environment settings are:

- `POKEMON_CENTER_FAILURE_THRESHOLD=2`
- `POKEMON_CENTER_PROXY_COOLDOWN_SECONDS=900`
- `POKEMON_CENTER_HEALTH_HEARTBEAT_SECONDS=300`
- `POKEMON_CENTER_NAVIGATION_TIMEOUT_MS=30000`

Run a one-shot live browser check before deployment with:

```bash
python scripts/diagnostics/diagnose_pokemon_center_queue.py
```

## Organized support folders

- `systemd/` — deployment unit and override templates. Paths and users are
  machine-specific examples and must be reviewed before installation.
- `diagnostics/` — one-shot investigation tools; not long-running services.
- `maintenance/` — one-time migration and patch helpers; not normal startup commands.
- `tests/` — standalone Python smoke/regression scripts for Pi modules.

Run standalone scripts from the repository root, for example:

```bash
python scripts/tests/test_target_stock_observer.py
python scripts/diagnostics/diagnose_pokemon_center_queue.py
```
