# Pokébot Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the invite-only, multi-tenant Pokébot control plane: user/admin dashboard, two-device registration, synchronized tasks, one-device execution, remote commands, leases, runs, and seven-day diagnostics.

**Architecture:** A new dedicated Supabase project is the system of record and realtime transport. A separate Next.js application under `apps/dashboard` serves user and admin workflows on Vercel. The existing Electron app receives a focused control-plane client while retaining all retailer credentials, checkout profiles, and execution locally.

**Tech Stack:** Supabase Auth/Postgres/RLS/Realtime/Storage/Edge Functions, Next.js App Router, TypeScript, Vitest, Playwright, existing Electron/React/Vitest app, PostgreSQL pgTAP, Node.js 22.

**Design:** `docs/superpowers/specs/2026-06-25-pokebot-control-plane-design.md`

---

## Scope and sequencing

This plan implements Milestone 1 only. Catalog monitoring workers are covered by `docs/superpowers/plans/2026-06-25-pokebot-central-monitoring-worker.md`.

Remote checkout remains feature-flagged off. Remote commands may start and stop monitoring/test tasks during the initial soak period, but a remote command must not submit an order until the rollout gate is explicitly enabled.

Existing uncommitted edits in:

- `package.json`
- `package-lock.json`
- `src/main/index.js`
- `src/main/monitor/retailers/walmart.js`
- `src/main/tasks/TaskManager.js`

belong to the user. Before each modification, inspect and preserve those changes. Do not reset or overwrite them.

## Target file structure

```text
PokeBot 2/
├─ apps/
│  └─ dashboard/
│     ├─ app/
│     │  ├─ (auth)/login/page.tsx
│     │  ├─ (auth)/forgot-password/page.tsx
│     │  ├─ invite/[token]/page.tsx
│     │  ├─ dashboard/page.tsx
│     │  ├─ dashboard/devices/page.tsx
│     │  ├─ dashboard/tasks/page.tsx
│     │  ├─ dashboard/runs/[id]/page.tsx
│     │  ├─ admin/invites/page.tsx
│     │  ├─ admin/users/page.tsx
│     │  ├─ admin/audit/page.tsx
│     │  └─ api/diagnostics/[id]/route.ts
│     ├─ components/
│     ├─ lib/supabase/
│     ├─ lib/auth/
│     ├─ lib/commands/
│     ├─ tests/
│     ├─ middleware.ts
│     ├─ package.json
│     └─ .env.example
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/
│  ├─ functions/
│  │  └─ cleanup-diagnostics/index.ts
│  └─ tests/database/
├─ src/main/control-plane/
│  ├─ ControlPlaneClient.js
│  ├─ DeviceIdentity.js
│  ├─ DeviceRegistrar.js
│  ├─ TaskSync.js
│  ├─ CommandProcessor.js
│  ├─ TaskLeaseClient.js
│  ├─ RunReporter.js
│  ├─ DiagnosticsRedactor.js
│  └─ DiagnosticsUploader.js
├─ tests/main/control-plane/
└─ docs/runbooks/
   ├─ supabase-project-setup.md
   └─ control-plane-rollout.md
```

## Task 1: Establish the dedicated Supabase project configuration

**Files:**

- Create: `supabase/config.toml`
- Create: `supabase/seed.sql`
- Create: `apps/dashboard/.env.example`
- Create: `docs/runbooks/supabase-project-setup.md`

- [ ] **Step 1: Install and discover the Supabase CLI**

Run:

```powershell
npx supabase --version
npx supabase --help
npx supabase init --help
```

Expected: the CLI version and current command help. Do not guess flags.

- [ ] **Step 2: Initialize local Supabase files**

Run from the repository root:

```powershell
npx supabase init
```

Expected: `supabase/config.toml` exists without modifying Electron source files.

- [ ] **Step 3: Configure local Auth and dashboard URLs**

Set:

```toml
[auth]
site_url = "http://localhost:3000"
additional_redirect_urls = [
  "http://localhost:3000/auth/callback",
  "http://localhost:3000/update-password"
]
enable_signup = false

[storage]
file_size_limit = "50MiB"
```

- [ ] **Step 4: Document project creation and secrets**

`docs/runbooks/supabase-project-setup.md` must state:

- Create a new hosted Supabase project; do not reuse PokeAlert.
- Electron/browser receive `NEXT_PUBLIC_SUPABASE_URL` and the publishable key only.
- Vercel server routes receive `SUPABASE_SECRET_KEY`.
- Worker credentials are deferred to Milestone 2.
- Never commit `.env`, secret keys, invite tokens, or device secrets.
- Explicit Data API grants are required for new tables created after April 28, 2026.

- [ ] **Step 5: Add environment template**

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000
INVITE_TOKEN_PEPPER=
```

- [ ] **Step 6: Verify**

Run:

```powershell
npx supabase --help
git diff --check -- supabase apps/dashboard/.env.example docs/runbooks/supabase-project-setup.md
```

- [ ] **Step 7: Commit**

```powershell
git add supabase/config.toml supabase/seed.sql apps/dashboard/.env.example docs/runbooks/supabase-project-setup.md
git commit -m "chore: initialize dedicated control-plane backend"
```

## Task 2: Create identity, invite, role, and audit schema

**Files:**

- Create: `supabase/migrations/<generated>_identity_invites_audit.sql`
- Create: `supabase/tests/database/identity_invites_audit.test.sql`

- [ ] **Step 1: Generate the migration filename**

Run:

```powershell
npx supabase migration new identity_invites_audit
```

Use the exact generated filename.

- [ ] **Step 2: Write failing pgTAP authorization tests**

Cover:

- Anonymous users cannot read tables.
- User A cannot read User B's profile.
- A user cannot promote their own role.
- Only admins can read all profiles and audit events.
- Invite rows cannot be read by normal authenticated users.

Representative assertions:

```sql
select plan(8);
select has_table('public', 'profiles');
select has_table('public', 'invites');
select has_table('public', 'audit_events');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles has RLS'
);
select * from finish();
```

- [ ] **Step 3: Run the test and confirm failure**

```powershell
npx supabase start
npx supabase test db supabase/tests/database/identity_invites_audit.test.sql
```

Expected: FAIL because tables do not exist.

- [ ] **Step 4: Implement schema**

Create:

```sql
create type public.app_role as enum ('user', 'admin');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role public.app_role not null default 'user',
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null unique,
  role public.app_role not null default 'user',
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

Add indexes for normalized invite email, expiry, audit actor, target, and creation time.

- [ ] **Step 5: Add least-privilege grants and RLS**

Explicitly grant only required profile operations to `authenticated`. Do not grant invites or audit mutation rights to browser clients.

Policies:

```sql
alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.audit_events enable row level security;

create policy "users read own profile"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);
```

Admin policies must use a protected helper that reads `profiles.role`, not `user_metadata`. Put privileged helpers in a non-exposed `private` schema, revoke public execution, set `search_path`, and explicitly grant only required calls.

- [ ] **Step 6: Add profile provisioning trigger**

Create a trigger on `auth.users` that inserts a `profiles` row using server-controlled values. It must not copy role from user metadata.

- [ ] **Step 7: Run tests and advisors**

```powershell
npx supabase db reset
npx supabase test db
npx supabase db advisors
```

Expected: tests pass; no critical security advisor findings.

- [ ] **Step 8: Commit**

```powershell
git add supabase/migrations supabase/tests/database
git commit -m "feat: add control-plane identities invites and audit schema"
```

## Task 3: Implement secure invite creation and acceptance

**Files:**

- Create: `apps/dashboard/lib/invites/tokens.ts`
- Create: `apps/dashboard/lib/invites/service.ts`
- Create: `apps/dashboard/app/invite/[token]/actions.ts`
- Create: `apps/dashboard/app/invite/[token]/page.tsx`
- Create: `apps/dashboard/app/admin/invites/actions.ts`
- Test: `apps/dashboard/tests/invites.test.ts`

- [ ] **Step 1: Scaffold the Next.js app**

Use the current CLI help before execution:

```powershell
npx create-next-app@latest --help
```

Create `apps/dashboard` with App Router, TypeScript, ESLint, no example content, and a pinned lockfile.

- [ ] **Step 2: Add pinned Supabase dependencies**

```powershell
cd apps/dashboard
npm install --save-exact @supabase/ssr @supabase/supabase-js
npm install --save-dev --save-exact vitest @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 3: Add dashboard test scripts**

Add:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 4: Write failing token tests**

Test:

```ts
it('stores only a hash and verifies the raw token', async () => {
  const raw = createInviteToken()
  expect(raw).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  expect(hashInviteToken(raw)).not.toContain(raw)
  expect(verifyInviteToken(raw, hashInviteToken(raw))).toBe(true)
})
```

Also test expiry, revoked invites, used invites, wrong email normalization, and one-time concurrent acceptance.

- [ ] **Step 5: Implement token helpers**

Use `crypto.randomBytes(32).toString('base64url')` and HMAC-SHA-256 with `INVITE_TOKEN_PEPPER`. Compare hashes with `timingSafeEqual`.

- [ ] **Step 6: Implement admin create-invite action**

Requirements:

- Verify current user server-side.
- Verify protected admin role.
- Normalize email.
- Set `expires_at = now + 72 hours`.
- Insert only token hash.
- Return the raw invite URL once.
- Write `invite.created` audit event.

- [ ] **Step 7: Implement acceptance action**

Within server-only code:

1. Hash raw URL token.
2. Load invite and reject expired/revoked/used.
3. Create the Supabase Auth user with email confirmed and submitted password.
4. Atomically mark invite accepted by that user.
5. Roll back/delete the created Auth user if database acceptance loses a race.
6. Write `invite.accepted`.
7. Sign the user in or redirect to login.

Validate password length and email binding. Never log the token or password.

- [ ] **Step 8: Verify**

```powershell
cd apps/dashboard
npm test -- --run tests/invites.test.ts
npm run lint
npm run build
```

- [ ] **Step 9: Commit**

```powershell
git add apps/dashboard
git commit -m "feat: add invite-only dashboard authentication"
```

## Task 4: Add devices with a concurrency-safe two-device limit

**Files:**

- Create: `supabase/migrations/<generated>_devices.sql`
- Create: `supabase/tests/database/devices.test.sql`
- Create: `src/main/control-plane/DeviceIdentity.js`
- Create: `src/main/control-plane/DeviceRegistrar.js`
- Test: `tests/main/control-plane/DeviceIdentity.test.js`
- Test: `tests/main/control-plane/DeviceRegistrar.test.js`

- [ ] **Step 1: Generate migration**

```powershell
npx supabase migration new devices
```

- [ ] **Step 2: Write failing database race tests**

Test that:

- First and second active device registrations succeed.
- Third active registration fails.
- Two concurrent attempts for the second slot cannot both succeed.
- Revocation frees a slot.
- User A cannot read or mutate User B's devices.

- [ ] **Step 3: Implement `devices`**

Columns:

```sql
id uuid primary key default gen_random_uuid(),
user_id uuid not null references auth.users(id) on delete cascade,
installation_id uuid not null,
name text not null,
secret_hash text not null,
platform text not null,
architecture text not null,
app_version text not null,
capabilities jsonb not null default '{}'::jsonb,
last_seen_at timestamptz,
revoked_at timestamptz,
created_at timestamptz not null default now(),
unique(user_id, installation_id)
```

Create `private.register_device(...)` that:

- Takes a transaction-scoped advisory lock on `auth.uid()`.
- Counts active devices.
- Rejects count >= 2.
- Hashes the submitted device secret with `crypt(..., gen_salt('bf'))`.
- Returns the new device ID.

Create `private.verify_device(device_id, secret)` for narrowly scoped RPC wrappers. Revoke direct execution from `PUBLIC`.

- [ ] **Step 4: Implement local device identity**

`DeviceIdentity.js`:

- Creates one UUID installation ID.
- Creates one 32-byte base64url secret.
- Stores both encrypted with Electron `safeStorage` in the app user-data directory.
- Never writes the raw secret to logs or SQLite.
- Returns platform, architecture, app version, and capabilities.

- [ ] **Step 5: Implement registration client**

`DeviceRegistrar.js` calls the registration RPC under the authenticated Supabase user session and caches only the returned device ID plus encrypted identity.

- [ ] **Step 6: Test**

```powershell
npm test -- --run tests/main/control-plane/DeviceIdentity.test.js tests/main/control-plane/DeviceRegistrar.test.js
npx supabase db reset
npx supabase test db
```

- [ ] **Step 7: Commit**

```powershell
git add supabase/migrations supabase/tests src/main/control-plane tests/main/control-plane
git commit -m "feat: register up to two revocable devices per user"
```

## Task 5: Add cloud tasks and local checkout-profile mappings

**Files:**

- Create: `supabase/migrations/<generated>_tasks.sql`
- Create: `supabase/tests/database/tasks.test.sql`
- Modify: `src/main/db/migrations.js`
- Modify: `src/main/db.js`
- Create: `src/main/control-plane/TaskSync.js`
- Test: `tests/main/control-plane/TaskSync.test.js`

- [ ] **Step 1: Generate migration and write failing tests**

Test ownership isolation, assigned-device ownership, optimistic version updates, and valid task states.

- [ ] **Step 2: Implement cloud `tasks`**

Include:

```sql
id uuid primary key default gen_random_uuid(),
user_id uuid not null references auth.users(id),
assigned_device_id uuid references public.devices(id),
retailer text not null check (retailer in ('target','walmart','pokemon-center')),
retailer_listing_id uuid,
product_url text not null,
product_name text,
product_image_url text,
quantity integer not null default 1 check (quantity between 1 and 20),
buy_limit integer not null default 1,
max_price numeric(12,2),
mode text not null,
schedule jsonb,
enabled boolean not null default false,
state text not null default 'draft',
required_capabilities jsonb not null default '{}'::jsonb,
version bigint not null default 1,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

Do not store account IDs, shipping IDs, payment IDs, cookies, or retailer credentials.

- [ ] **Step 3: Add local mapping table**

Create local SQLite table:

```sql
create table if not exists cloud_task_profiles (
  cloud_task_id text primary key,
  local_account_ids text not null default '[]',
  local_payment_id text,
  local_shipping_id text,
  readiness_status text not null default 'unmapped',
  updated_at integer not null
);
```

Ensure JSON fallback declares the same columns.

- [ ] **Step 4: Implement `TaskSync`**

Responsibilities:

- Pull the current user's tasks.
- Subscribe to private `user:{user_id}` task notifications.
- Reconcile from the database after reconnect.
- Upsert cloud task snapshots into a separate local cache or map.
- Join local profile readiness without uploading local IDs.
- Push user-authored non-sensitive task changes with expected version.

- [ ] **Step 5: Verify**

```powershell
npm test -- --run tests/main/control-plane/TaskSync.test.js tests/main/db.test.js
npx supabase test db
```

- [ ] **Step 6: Commit**

```powershell
git add supabase/migrations supabase/tests src/main/db.js src/main/db/migrations.js src/main/control-plane tests/main/control-plane
git commit -m "feat: synchronize cloud tasks with local checkout profiles"
```

## Task 6: Add commands, atomic claims, leases, and fencing

**Files:**

- Create: `supabase/migrations/<generated>_commands_leases.sql`
- Create: `supabase/tests/database/commands_leases.test.sql`
- Create: `src/main/control-plane/CommandProcessor.js`
- Create: `src/main/control-plane/TaskLeaseClient.js`
- Test: `tests/main/control-plane/CommandProcessor.test.js`
- Test: `tests/main/control-plane/TaskLeaseClient.test.js`

- [ ] **Step 1: Generate migration and failing race tests**

Cover:

- Command target must be the task's assigned active device.
- Expired commands cannot be claimed.
- Two claims produce one winner.
- Replayed command returns existing result.
- Two devices cannot hold one task lease.
- Stale fencing token cannot write run state.

- [ ] **Step 2: Implement `commands` and `task_leases`**

Commands have typed command checks, unique idempotency key per user, expiry, claim, acknowledgement, completion, and error fields.

Leases have:

```sql
task_id uuid primary key references public.tasks(id) on delete cascade,
device_id uuid not null references public.devices(id),
fencing_token bigint not null,
acquired_at timestamptz not null,
renewed_at timestamptz not null,
expires_at timestamptz not null
```

- [ ] **Step 3: Implement RPCs**

Create narrowly granted functions:

- `claim_command(command_id, device_id, device_secret)`
- `complete_command(command_id, device_id, device_secret, result)`
- `acquire_task_lease(task_id, device_id, device_secret)`
- `renew_task_lease(task_id, fencing_token, device_secret)`
- `release_task_lease(task_id, fencing_token, device_secret)`

Each function verifies active device, ownership, assignment, and state in one transaction.

- [ ] **Step 4: Implement `CommandProcessor`**

Subscribe to `device:{device_id}` private Broadcast. On notification, reload and claim from PostgreSQL. Map only known commands to injected handlers. Do not allow arbitrary method names, shell commands, URLs, or JavaScript.

- [ ] **Step 5: Integrate safe handlers**

Initially wire:

- `start`: monitoring and test modes only while `remote_checkout_enabled` is false.
- `stop`
- `pause`
- `resume`
- `test`
- `reassign`: dashboard/database operation, not arbitrary desktop execution.

Modify `TaskManager` through a small adapter rather than embedding Supabase logic inside checkout flows.

- [ ] **Step 6: Verify**

```powershell
npm test -- --run tests/main/control-plane/CommandProcessor.test.js tests/main/control-plane/TaskLeaseClient.test.js tests/main/tasks/TaskManager.test.js
npx supabase test db
```

- [ ] **Step 7: Commit**

```powershell
git add supabase/migrations supabase/tests src/main/control-plane tests/main/control-plane src/main/tasks/TaskManager.js
git commit -m "feat: execute idempotent remote commands with task leases"
```

## Task 7: Add run records and append-only progress events

**Files:**

- Create: `supabase/migrations/<generated>_runs_events.sql`
- Create: `supabase/tests/database/runs_events.test.sql`
- Create: `src/main/control-plane/RunReporter.js`
- Test: `tests/main/control-plane/RunReporter.test.js`
- Modify: `src/main/tasks/TaskManager.js`

- [ ] **Step 1: Add failing tests**

Test:

- Run belongs to user/task/device.
- Fencing token is required.
- Event sequence is unique per run.
- User reads own runs only.
- Invalid final-state transitions fail.

- [ ] **Step 2: Implement schema and transition RPC**

Create `runs` and `run_events`. Use an RPC that validates task lease fencing token and allowed transitions. Keep run events append-only.

- [ ] **Step 3: Implement reporter**

`RunReporter` provides:

- `startRun`
- `appendEvent`
- `markTriggered`
- `completeRun`
- `interruptRun`

It sanitizes messages and retries with event idempotency keys. Reporting failures are logged but must not crash local stop operations.

- [ ] **Step 4: Integrate around task execution**

Create runs before local execution, emit progress from existing TaskManager events, and finalize with sanitized result metadata. Never send local account IDs or checkout-profile values.

- [ ] **Step 5: Verify and commit**

```powershell
npm test -- --run tests/main/control-plane/RunReporter.test.js tests/main/tasks/TaskManager.test.js
npx supabase test db
git add supabase/migrations supabase/tests src/main/control-plane tests/main/control-plane src/main/tasks/TaskManager.js
git commit -m "feat: report fenced task runs and progress events"
```

## Task 8: Add diagnostics redaction, private storage, and retention

**Files:**

- Create: `supabase/migrations/<generated>_diagnostics_storage.sql`
- Create: `supabase/tests/database/diagnostics.test.sql`
- Create: `supabase/functions/cleanup-diagnostics/index.ts`
- Create: `src/main/control-plane/DiagnosticsRedactor.js`
- Create: `src/main/control-plane/DiagnosticsUploader.js`
- Test: `tests/main/control-plane/DiagnosticsRedactor.test.js`
- Test: `tests/main/control-plane/DiagnosticsUploader.test.js`

- [ ] **Step 1: Create redaction fixtures first**

Fixtures must contain fake:

- Passwords
- Session cookies
- Authorization headers
- Card numbers and CVV
- Addresses
- Emails and phone numbers
- Hidden inputs
- Local storage/session storage values

Tests assert none survive output.

- [ ] **Step 2: Implement deterministic redaction**

Redact structured fields before regex fallback. Parse HTML, remove scripts/event attributes/hidden inputs, replace sensitive values, and validate final bytes against forbidden patterns.

Screenshots/recordings must be captured only after page-level visual masks are applied. Disable capture for payment entry and final order submission phases.

- [ ] **Step 3: Add private bucket and metadata**

Create private `diagnostics` bucket plus `diagnostic_objects` metadata table. Storage policies allow users to access their own prefix. Admin access occurs through audited server routes, not a blanket browser policy.

- [ ] **Step 4: Implement uploader**

The uploader:

- Redacts before upload.
- Rejects failed validation.
- Uses user/run-scoped object paths.
- Inserts metadata with `expires_at = created_at + interval '7 days'`.
- Never blocks run completion.

- [ ] **Step 5: Implement cleanup Edge Function**

The function finds expired metadata, removes objects through the Storage API, and then marks deletion. It records failures for retry. Schedule it daily using supported Supabase Cron/Function scheduling for the created project.

- [ ] **Step 6: Verify**

```powershell
npm test -- --run tests/main/control-plane/DiagnosticsRedactor.test.js tests/main/control-plane/DiagnosticsUploader.test.js
npx supabase test db
npx supabase functions serve cleanup-diagnostics --no-verify-jwt
```

Use only local fake objects during function verification.

- [ ] **Step 7: Commit**

```powershell
git add supabase src/main/control-plane tests/main/control-plane
git commit -m "feat: upload redacted seven-day diagnostics"
```

## Task 9: Build authenticated user and admin dashboard pages

**Files:**

- Create/modify: `apps/dashboard/app/**`
- Create: `apps/dashboard/components/**`
- Create: `apps/dashboard/lib/supabase/server.ts`
- Create: `apps/dashboard/lib/supabase/browser.ts`
- Create: `apps/dashboard/middleware.ts`
- Test: `apps/dashboard/tests/authorization.test.ts`
- Test: `apps/dashboard/tests/commands.test.ts`

- [ ] **Step 1: Implement Supabase SSR clients**

Use current official `@supabase/ssr` cookie patterns. Never use service credentials in browser code.

- [ ] **Step 2: Implement protected route guards**

User routes require a valid user. Admin routes require protected admin role from the database. Middleware may improve UX but server components/actions must enforce authorization independently.

- [ ] **Step 3: Implement user pages**

Deliver:

- Dashboard summary
- Device list/rename/revoke
- Task list/create/edit/assign
- Remote command controls
- Runs and live event view
- Diagnostic list/view/delete

- [ ] **Step 4: Implement admin pages**

Deliver:

- Invite management
- User disable/re-enable
- Device revocation
- Diagnostic access
- Audit log
- Feature flag and user-limit controls

- [ ] **Step 5: Audit admin diagnostic access**

The download route verifies admin role, inserts `diagnostic.viewed` or `diagnostic.downloaded`, then creates a short-lived signed Storage URL.

- [ ] **Step 6: Verify**

```powershell
cd apps/dashboard
npm test -- --run
npm run lint
npm run build
```

- [ ] **Step 7: Commit**

```powershell
git add apps/dashboard
git commit -m "feat: add Pokebot user and admin control dashboard"
```

## Task 10: Wire Electron authentication, startup, IPC, and UI

**Files:**

- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Modify: `src/shared/constants.js`
- Modify: `src/preload/index.js`
- Modify: `src/renderer/src/App.jsx`
- Modify: `src/renderer/src/store/appStore.js`
- Create: `src/renderer/src/pages/CloudAccount.jsx`
- Create: `src/renderer/src/pages/CloudTasks.jsx`
- Test: `tests/main/ipc.control-plane.test.js`

- [ ] **Step 1: Add failing IPC tests**

Test login, logout, register device, map task profile, sync now, and connection status. Ensure no IPC returns raw device secrets or decrypted local checkout profiles.

- [ ] **Step 2: Extend `ControlPlaneClient`**

Add sign-in, sign-out, token refresh, realtime auth refresh, and reconnect reconciliation. Persist the Supabase refresh session using OS-protected storage, not plaintext settings.

- [ ] **Step 3: Wire startup**

On app readiness:

1. Load protected session.
2. Restore Supabase session.
3. Register/verify device.
4. Start heartbeat, task sync, and command processor.
5. Reconcile pending commands and runs.

Shutdown stops timers and releases leases best-effort.

- [ ] **Step 4: Add renderer pages**

Show:

- Cloud login state
- Registered device name/status
- Cloud tasks and assigned executor
- Local profile mapping readiness
- Last command/run status

Never display or expose raw secrets.

- [ ] **Step 5: Preserve local mode**

If no cloud session exists, existing local tasks and checkout remain usable. The new control plane must not force migration during development.

- [ ] **Step 6: Verify**

```powershell
npm test -- --run tests/main/ipc.control-plane.test.js tests/main/tasks/TaskManager.test.js
npm run lint
npm run build
```

- [ ] **Step 7: Commit**

```powershell
git add src tests
git commit -m "feat: connect Electron client to Pokebot control plane"
```

## Task 11: End-to-end isolation, race, reconnect, and soak verification

**Files:**

- Create: `apps/dashboard/tests/e2e/control-plane.spec.ts`
- Create: `tests/integration/control-plane-simulator.test.js`
- Create: `docs/runbooks/control-plane-rollout.md`

- [ ] **Step 1: Build a simulated device harness**

Simulate two users with two devices each. The harness consumes realtime notifications but always reconciles from PostgreSQL.

- [ ] **Step 2: Test isolation and races**

Verify:

- User A cannot read/control User B.
- Third device is rejected under concurrent registration.
- One command executes once after duplicate Broadcast delivery.
- One lease winner exists.
- Stale fencing writes fail.
- Revoked device loses command/lease rights.

- [ ] **Step 3: Test diagnostics**

Upload fake redacted artifacts, verify user/admin access and audit, run cleanup against expired fake objects, and verify deletion.

- [ ] **Step 4: Run full verification**

```powershell
npx supabase db reset
npx supabase test db
npm test -- --run
npm run lint
npm run build
cd apps/dashboard
npm test -- --run
npm run lint
npm run build
```

- [ ] **Step 5: Document rollout**

Rollout states:

1. Internal account only.
2. Commands enabled for monitoring/test mode.
3. Ten invited users, remote checkout still disabled.
4. 72-hour reconnect/lease soak.
5. Explicit review before enabling any remote checkout capability.

- [ ] **Step 6: Commit**

```powershell
git add apps/dashboard/tests tests/integration docs/runbooks/control-plane-rollout.md
git commit -m "test: verify control-plane isolation and reliability"
```

## Milestone 1 completion gate

Do not begin Milestone 2 until:

- All database tests pass.
- Security advisors have no unresolved critical findings.
- Dashboard and Electron builds pass.
- Cross-user isolation tests pass.
- Command and lease race tests pass.
- Diagnostics redaction and cleanup pass.
- The user approves the Milestone 1 rollout evidence.
