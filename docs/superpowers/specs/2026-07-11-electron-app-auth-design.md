# Sub-project A — Per-user auth for the Electron app

**Date:** 2026-07-11
**Status:** Approved (brainstorm)
**Repo:** PokeBot 2 (Electron client)
**Supabase project:** PokeAlert (`jbnnouwhesexfllninwb`, org `jmhfmfrhaoimrhqbbwsn`, us-west-2)
**Blocks:** Sub-project B (billing/paywall), Sub-project C (task↔central-monitoring ref-counting), Sub-project D (realtime alerts by default)

## Context

The app currently has no login screen — it boots straight to the Dashboard. Supabase access is a
single **shared bot account**: an email/password saved in the `settings` table
(`supabaseEmail` / `supabasePasswordEnc`, set via the Settings page's "Bot Email" field) that
`getSupabaseSession()` ([src/main/supabase/session.js](../../../src/main/supabase/session.js))
signs in with once at startup. Every install, and every user of an install, shares that one
Supabase identity.

Per the [B2 monitor-mode spec](2026-06-15-supabase-monitor-mode-b2-design.md), the `products` /
`subscriptions` / `drops` schema and its RLS policies are already designed around real per-user
identity (`subscriptions.user_id → auth.users`, `auth.uid()`-scoped RLS, a private-per-product
realtime broadcast channel gated by subscription). None of that can work correctly — ref-counted
monitoring (sub-project C), scoped realtime alerts (sub-project D), or a paid gate (sub-project B)
— while every user is the same `auth.uid()`. This spec builds the real per-user identity those
depend on.

## Goal

Replace the shared bot-account mechanism with real per-user Supabase Auth:

- A login/signup screen gates the entire app UI — no task/account/catalog data is shown or
  interactive until authenticated.
- Email + password, via Supabase Auth (`signInWithPassword` / `signUp`).
- Signup happens in-app; no paid gate yet (sub-project B adds that later) and no email
  confirmation step (see prerequisite below) — sign up and you're in.
- Session survives app restarts (encrypted refresh token, same local vault key used for
  account/payment secrets).
- The old shared bot-account settings UI and IPC are removed — one auth mechanism, not two.

**Out of scope** (deferred to later sub-projects): billing/paywall enforcement, password reset,
ref-counted `subscriptions` wiring for task↔monitor, realtime alert delivery fixes, multi-window /
multiple simultaneous logged-in users per install.

## ⚠️ Manual prerequisite (outside this repo)

Supabase project **PokeAlert** → Authentication → Providers → Email → **"Confirm email" must be
OFF**. With it on, `signUp()` returns a session-less user and the app can't drop the new user
straight into the app as scoped here. This is a dashboard setting, not something this change can
flip in code — confirm it manually before/while testing signup.

## Architecture

Main process owns one authenticated Supabase client for the app's lifetime. This replaces
`getSupabaseSession()`'s bot-login flow, not adds a second path alongside it — two ways to
establish a Supabase identity is a bug farm, so the old one is deleted as part of this work.

- On sign-in/sign-up, the resulting session's refresh token is encrypted with the existing local
  vault key ([src/main/crypto.js](../../../src/main/crypto.js), same key used for account/payment
  secrets) and stored in the `settings` table.
- On launch, main tries to silently restore that session (`refreshSession` with the stored
  token). Only if that fails — no token, expired, network down — does the renderer show the
  login screen.
- The whole app is gated: `App.jsx` renders `Login` instead of the nav/router until
  authenticated. The existing `loadTasks/loadAccounts/loadCatalog/loadSettings` bootstrap in
  `App.jsx`'s effect only runs post-auth.
- All existing Supabase consumers (`TaskManager`, `SupabaseMonitorSource`, catalog IPC handlers)
  keep working unchanged — they just get the client from the new module instead of the old one;
  the client shape (`supabase-js` `SupabaseClient`) is identical.

## Components

| File                                                              | Change                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/supabase/authSession.js` _(new, replaces `session.js`)_ | Owns the one client instance for app lifetime. Exposes `signIn(email, pw)`, `signUp(email, pw)`, `signOut()`, `restoreSession()`, `getClient()`. Emits state changes (via EventEmitter or callback) for main/index.js to relay over IPC. |
| `src/main/supabase/SupabaseClient.js`                             | Add `signUp`, `restoreSession(refreshToken)`, `signOut` methods alongside the existing `signIn`.                                                                                                                                         |
| `src/main/ipc.js`                                                 | Add `AUTH_SIGN_IN`, `AUTH_SIGN_UP`, `AUTH_SIGN_OUT`, `AUTH_GET_STATUS` handlers. **Remove** `SUPABASE_SET_PASSWORD` / `SUPABASE_CLEAR_CREDENTIALS` handlers and the `supabaseEmail`/`supabasePasswordEnc` settings usage.                |
| `src/main/index.js`                                               | Startup calls `authSession.restoreSession()` instead of `getSupabaseSession({ getSettings, encryptionKey })`. Relay `AUTH_STATE_CHANGED` to the renderer over IPC.                                                                       |
| `src/renderer/src/pages/Login.jsx` _(new)_                        | Email/password form, Sign In ⇄ Sign Up toggle, inline error message, loading state.                                                                                                                                                      |
| `src/renderer/src/App.jsx`                                        | On mount, request auth status; render `<Login/>` in place of the nav/router while unauthenticated; existing data-loading effect gated on `authenticated`. Listen for `AUTH_STATE_CHANGED` pushes.                                        |
| `src/renderer/src/store/appStore.js`                              | Add `authStatus` (`checking` \| `authenticated` \| `unauthenticated`), `authUser`, `authError`; actions `signIn`, `signUp`, `signOut`, `checkAuthStatus`.                                                                                |
| `src/renderer/src/pages/Settings.jsx`                             | Remove the "Bot Email" / password fields and the clear-credentials button (obsolete). Add a Sign Out button.                                                                                                                             |
| `src/shared/constants.js`                                         | Add the four new `AUTH_*` IPC channel names; remove the two obsolete `SUPABASE_SET_PASSWORD` / `SUPABASE_CLEAR_CREDENTIALS` entries.                                                                                                     |

## Data flow

**Startup:** main creates the Supabase client → `authSession.restoreSession()` reads the stored
encrypted refresh token (if any) → success: mark `authenticated`, continue app init exactly as
today (TaskManager, browser pool, etc. all still construct regardless of auth — auth only gates
the _renderer_ UI, not backend wiring) → failure/none: mark `unauthenticated`.

**Sign in / sign up:** renderer form submit → `AUTH_SIGN_IN` / `AUTH_SIGN_UP` IPC → main calls
Supabase → on success, encrypt + store the new refresh token, emit `AUTH_STATE_CHANGED
{ authenticated: true, user }` → renderer flips from `Login` to the main app and runs its normal
bootstrap (`loadTasks`, etc.).

**Sign out:** `AUTH_SIGN_OUT` IPC → main calls `client.auth.signOut()`, clears the stored refresh
token setting, emits `AUTH_STATE_CHANGED { authenticated: false }` → renderer shows `Login` again.

**Realtime:** unchanged in behavior — `SupabaseMonitorSource` and friends call
`authSession.getClient()` instead of `getSupabaseSession()`, get back the same kind of client,
already signed in as the real user.

## Error handling

- Bad credentials on sign-in → Supabase error message shown inline on the form.
- Sign-up with an already-registered email → inline error ("Email already registered — try
  signing in").
- No network, or Supabase unreachable, during startup `restoreSession()` → treat as
  unauthenticated (show `Login`), don't crash. No retry loop — next attempt is either the user
  submitting the form or the next app launch.
- Stored refresh token invalid/expired at startup → same fallback, and the stale token is cleared
  so it isn't retried forever.

## Testing

- One focused automated check, `tests/main/auth.session.test.js`, matching existing test
  conventions (`tests/main/*.test.js`, mocked Supabase client): sign-in stores an encrypted
  refresh token → `restoreSession` with that token succeeds → `signOut` clears it.
- Manual pass: sign up with a brand-new email against the real PokeAlert project and confirm it
  lands in the main app immediately, with no email-confirmation interstitial (validates the
  dashboard prerequisite above is actually set).
