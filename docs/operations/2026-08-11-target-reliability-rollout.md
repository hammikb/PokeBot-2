# Target reliability rollout — 2026-08-11

## Outcome

- Supabase hot-set and durable-delivery migrations are live.
- PokeAlert production is deployed from the verified preview artifact.
- The Pi Target monitor and schedule agent are live with durable delivery, incremental watchlist refresh, health evidence, and dated release overrides.
- The Electron app is running the browser-only Target checkout policy with inventory-aware retry gating and desktop notification evidence.
- Discord mentions remain disabled.

## Production evidence

- PokeAlert production deployment: `https://pokealert-71ifs0c6u-hammikbs-projects.vercel.app`
- Previous production deployment: `https://pokealert-khuund2x4-hammikbs-projects.vercel.app`
- Live watchlist API: 41 total active items; Pi Target hot set: 39 products.
- Ingest validation rejected malformed `source_event_id` with HTTP 400.
- Web and Pi canaries each produced one row after replay; duplicate replay returned idempotent success.
- Pi delivery canary: cloud HTTP 200, Discord HTTP 200 with a message ID, no mention payload, outbox depth 0.
- Pi services after rollout:
  - `api-monitor.service`: PID 1878032, active since 2026-08-11 10:44:53 PDT.
  - `pokealert-agent.service`: PID 1879242, active since 2026-08-11 10:46:49 PDT.
- Latest central snapshot at 2026-08-11 18:05:24 UTC: status `ok`, 150 checks, 39 products, 4 contexts, blocked rate 0.0467.
- Latest worker health: watchlist 39, outbox 0, schedule profile `default`, next transition 2026-08-12 05:00:00 UTC.
- Electron preload/auth/event smoke passed. Native desktop notification canary returned `supported: true` and `shown`.
- Relaunched Electron process was responsive for more than two minutes with 4 tasks monitoring and 6 idle.
- Vercel reported no production error-level logs during the rollout window.

## Verification

- Electron: 69 test files / 451 tests passed.
- Pi: 18 reliability and patcher tests passed locally; the patched production source compiled and matched the remote canary.
- PokeAlert: 34 tests passed and the Next.js production build passed.
- Electron production build and preload bridge verification passed.
- Repository structure check passed.
- ESLint exited 0. In the primary checkout it excluded `.worktrees`, `Polar Extension`, `.codex-diagnostics`, and generated `out` trees so unrelated nested workspaces and generated artifacts were not traversed; the isolated integration branch also passed the repository's unmodified lint command.
- Fresh Supabase advisors showed the pre-existing control-plane/auth policy and unused-index backlog; no new Target migration finding was introduced.

## Pi rollback points

- `/home/hammikb/api-monitor-python/ApiMonitor.py.backup-20260811T174314Z`
- `/home/hammikb/api-monitor-python/api_monitor_state.json.backup-20260811T174314Z`
- `/opt/pokealert-agent/pi_agent.py.backup-20260811T174314Z`
- Live Target schedule hash remained `134a6c093056a9345f1d7fe7b5de2e9009a00a2899882fbc5af96e954c191c62`.

Rollback procedure:

1. Restore the matching monitor source and state backups to their original paths.
2. Restore the matching agent backup to `/opt/pokealert-agent/pi_agent.py`.
3. Restart `api-monitor.service` and `pokealert-agent.service` and verify new PIDs and fresh heartbeats.
4. If the web artifact must be reverted, promote the previous production deployment listed above.
5. To disable only the database hot set without reversing additive schema, disable the rows in `public.target_auto_watch_rules`, run `public.refresh_target_auto_watch()`, and verify active-product invariants before any further change.

## Source rollback and preservation

- Verified feature branch: `codex/target-reliability`; implementation head `00bf515` (followed only by this rollout record).
- Isolated worktree: `.worktrees/target-reliability`.
- Primary app command: `npm run dev`; final launcher PID 48912 and Electron PID 39416 at verification time.
- The feature delta was ported into the primary working tree without committing, resetting, or overwriting the user's pre-existing uncommitted changes. The isolated branch/worktree is retained as a recovery point.

## Rollout notes

- Local Vercel prebuilt packaging hit Windows/OneDrive symlink error `EPERM` after a successful application build. The source was therefore built as a Vercel preview, verified, and promoted through Vercel's exact-preview promotion flow.
- Windows Computer Use was unavailable after its prescribed retry/reset sequence. Live UI verification used the successful Electron Playwright smoke screenshot, native notification canary, process responsiveness, and persisted task-state evidence.
