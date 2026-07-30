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

- `pokemon_center_queue_monitor.py` — Pokemon Center waiting-room detector.
- `target_stock_observer.py` — low-bandwidth Target availability observer.
- `walmart_restock_scanner.py` — low-bandwidth Walmart restock scanner.
- `walmart_queue_rank_tracker.mjs` — broad, low-bandwidth Walmart category and queue detector.
- `monitor_walmart_pokemon.mjs` — legacy Node Walmart monitor.
- `pokebot_drop_pusher.py` — reusable Supabase drop publishing module.

These monitors are proxy-sensitive. Review their environment variables and
fail-closed behavior before installing them on a Pi.

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
