# Pokébot Central Monitoring Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared product catalog and horizontally scalable Target, Walmart, and Pokémon Center monitoring service, then deploy and verify the ARM64 container on `pokebot-worker`.

**Architecture:** Supabase stores canonical products, retailer listings, subscriptions, worker heartbeats, listing leases, observations, and immutable drop events. Identical Node.js workers atomically lease listings, poll with bounded retailer-specific budgets, normalize observations, and publish authorized private Realtime events. Docker Compose runs the first worker on the prepared Raspberry Pi without public inbound ports.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Supabase/PostgreSQL, private Realtime Broadcast, Docker Buildx, Docker Compose, ARM64 Raspberry Pi OS/Debian 13.

**Prerequisite:** Milestone 1 completion gate in `docs/superpowers/plans/2026-06-25-pokebot-control-plane.md`.

---

## Target file structure

```text
PokeBot 2/
├─ services/
│  └─ monitor-worker/
│     ├─ src/
│     │  ├─ index.ts
│     │  ├─ config.ts
│     │  ├─ db.ts
│     │  ├─ worker/WorkerRuntime.ts
│     │  ├─ leases/ListingLeaseRepository.ts
│     │  ├─ observations/ObservationService.ts
│     │  ├─ adapters/RetailerAdapter.ts
│     │  ├─ adapters/target.ts
│     │  ├─ adapters/walmart.ts
│     │  └─ adapters/pokemonCenter.ts
│     ├─ tests/
│     ├─ fixtures/
│     ├─ Dockerfile
│     ├─ compose.yaml
│     ├─ package.json
│     └─ .env.example
├─ supabase/migrations/
├─ supabase/tests/database/
└─ docs/runbooks/
   ├─ monitor-worker-deployment.md
   └─ monitor-worker-operations.md
```

## Task 1: Add catalog, listing, and subscription schema

**Files:**

- Create: `supabase/migrations/<generated>_catalog_listings.sql`
- Create: `supabase/tests/database/catalog_listings.test.sql`

- [ ] **Step 1: Generate migration**

```powershell
npx supabase migration new catalog_listings
```

- [ ] **Step 2: Write failing pgTAP tests**

Test:

- Authenticated users can read active canonical products/listings.
- Only admins can create/update canonical products and approved listings.
- Users can create suggestions for themselves only.
- Users can subscribe only their own tasks.
- Duplicate retailer/item-key listing is rejected.
- Subscriptions expose no other user's task data.

- [ ] **Step 3: Implement schema**

Tables:

```sql
canonical_products (
  id uuid primary key,
  name text not null,
  category text,
  set_name text,
  image_url text,
  identifiers jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

retailer_listings (
  id uuid primary key,
  canonical_product_id uuid not null references canonical_products(id),
  retailer text not null check (retailer in ('target','walmart','pokemon-center')),
  retailer_item_key text not null,
  retailer_sku text,
  product_url text not null,
  display_name text not null,
  image_url text,
  active boolean not null default true,
  monitor_config jsonb not null default '{}'::jsonb,
  unique(retailer, retailer_item_key)
)

listing_suggestions (...)
listing_subscriptions (...)
```

- [ ] **Step 4: Add explicit Data API grants and RLS**

Grant read operations narrowly. Admin writes use protected server actions. Subscription policies verify the task belongs to `auth.uid()`.

- [ ] **Step 5: Verify**

```powershell
npx supabase db reset
npx supabase test db
npx supabase db advisors
```

- [ ] **Step 6: Commit**

```powershell
git add supabase
git commit -m "feat: add canonical catalog and retailer listings"
```

## Task 2: Add worker identities, listing leases, and health

**Files:**

- Create: `supabase/migrations/<generated>_monitor_workers_leases.sql`
- Create: `supabase/tests/database/monitor_workers_leases.test.sql`

- [ ] **Step 1: Write lease-race tests**

Test:

- Two workers racing for one listing produce one holder.
- Expired lease is reclaimable.
- Renew requires current holder and fencing token.
- Stale token cannot write observations.
- Worker credentials cannot read user diagnostics or checkout data.

- [ ] **Step 2: Implement worker tables**

```sql
workers (
  id uuid primary key,
  name text not null unique,
  credential_hash text not null,
  version text not null,
  architecture text not null,
  capabilities jsonb not null,
  started_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz
)

listing_leases (
  listing_id uuid primary key references retailer_listings(id),
  worker_id uuid not null references workers(id),
  fencing_token bigint not null,
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  expires_at timestamptz not null
)
```

- [ ] **Step 3: Implement trusted worker RPCs**

Create:

- `worker_heartbeat`
- `claim_listing_batch`
- `renew_listing_leases`
- `release_listing_leases`

Authenticate worker ID + random secret against a password hash inside narrowly granted private functions. Workers never receive Supabase user service access beyond these functions and observation/drop writes.

- [ ] **Step 4: Verify and commit**

```powershell
npx supabase test db
git add supabase
git commit -m "feat: coordinate monitor workers with fenced listing leases"
```

## Task 3: Scaffold the TypeScript worker and lease runtime

**Files:**

- Create: `services/monitor-worker/package.json`
- Create: `services/monitor-worker/tsconfig.json`
- Create: `services/monitor-worker/src/config.ts`
- Create: `services/monitor-worker/src/db.ts`
- Create: `services/monitor-worker/src/worker/WorkerRuntime.ts`
- Create: `services/monitor-worker/src/leases/ListingLeaseRepository.ts`
- Test: `services/monitor-worker/tests/WorkerRuntime.test.ts`
- Test: `services/monitor-worker/tests/ListingLeaseRepository.test.ts`

- [ ] **Step 1: Create pinned package**

Dependencies:

- `@supabase/supabase-js`
- `zod`
- `pino`
- `undici`

Dev dependencies:

- TypeScript
- Vitest
- ESLint
- `tsx`

- [ ] **Step 2: Write failing runtime tests**

Use a fake repository and clock. Test:

- Startup registers heartbeat.
- Claims bounded batches.
- Renews before lease expiry.
- Stops processing immediately after lease loss.
- Graceful shutdown releases leases.

- [ ] **Step 3: Implement config validation**

Required environment:

```dotenv
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
WORKER_ID=
WORKER_SECRET=
WORKER_NAME=pokebot-worker
LOG_LEVEL=info
MAX_ACTIVE_LISTINGS=25
LEASE_SECONDS=60
```

Reject missing/invalid values before network calls. Never log secrets.

- [ ] **Step 4: Implement runtime**

The runtime uses an `AbortController` per listing lease. Lease loss aborts adapter polling before another worker can take over.

- [ ] **Step 5: Verify and commit**

```powershell
cd services/monitor-worker
npm test -- --run
npm run lint
npm run build
git add services/monitor-worker
git commit -m "feat: scaffold fenced central monitor worker"
```

## Task 4: Define normalized observation and drop transition service

**Files:**

- Create: `supabase/migrations/<generated>_listing_observations_drops.sql`
- Create: `supabase/tests/database/listing_observations_drops.test.sql`
- Create: `services/monitor-worker/src/observations/Observation.ts`
- Create: `services/monitor-worker/src/observations/ObservationService.ts`
- Test: `services/monitor-worker/tests/ObservationService.test.ts`

- [ ] **Step 1: Write transition tests**

Test:

- Unknown -> out-of-stock does not create a drop.
- Out-of-stock -> in-stock creates one drop.
- Repeated in-stock observation creates no duplicate.
- Price-only changes are recorded but do not duplicate stock transition.
- Stale fencing token is rejected.
- Event idempotency suppresses retry duplicates.

- [ ] **Step 2: Implement schema**

Create:

- `listing_observations` with bounded retention fields
- `listing_states` with latest normalized state
- `drop_events` immutable and idempotent

Use a transaction/RPC to validate the fencing token, insert observation, compare prior state, update latest state, and conditionally insert one drop event.

- [ ] **Step 3: Implement normalized contract**

```ts
export interface ListingObservation {
  listingId: string
  retailer: 'target' | 'walmart' | 'pokemon-center'
  observedAt: string
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown'
  price: number | null
  currency: 'USD'
  fulfillment: Array<'shipping' | 'pickup' | 'delivery'>
  confidence: 'high' | 'medium' | 'low'
  responseFingerprint: string
  metadata: Record<string, string | number | boolean | null>
}
```

Metadata must be sanitized and size-bounded.

- [ ] **Step 4: Broadcast drops**

After a drop insert, call `realtime.send` to private topic `listing:{listing_id}`, event `drop`. Add `realtime.messages` RLS allowing only users with a listing subscription and admins to receive.

- [ ] **Step 5: Verify and commit**

```powershell
npx supabase test db
cd services/monitor-worker
npm test -- --run tests/ObservationService.test.ts
git add supabase services/monitor-worker
git commit -m "feat: normalize observations and publish deduplicated drops"
```

## Task 5: Implement shared retailer scheduling and safety controls

**Files:**

- Create: `services/monitor-worker/src/adapters/RetailerAdapter.ts`
- Create: `services/monitor-worker/src/limits/RateBudget.ts`
- Create: `services/monitor-worker/src/resilience/CircuitBreaker.ts`
- Create: `services/monitor-worker/src/scheduler/ListingScheduler.ts`
- Test: `services/monitor-worker/tests/RateBudget.test.ts`
- Test: `services/monitor-worker/tests/CircuitBreaker.test.ts`
- Test: `services/monitor-worker/tests/ListingScheduler.test.ts`

- [ ] **Step 1: Write failing timing tests with fake clocks**

Verify bounded concurrency, jitter range, retailer-wide budgets, exponential backoff, timeout cancellation, and circuit-open behavior.

- [ ] **Step 2: Define adapter interface**

```ts
export interface RetailerAdapter {
  retailer: ListingObservation['retailer']
  observe(listing: RetailerListing, signal: AbortSignal): Promise<ListingObservation>
}
```

- [ ] **Step 3: Implement rate budgets**

Start conservative and configurable. No adapter may bypass the shared retailer budget. HTTP 403/429 and challenge pages lower concurrency and open the circuit rather than triggering evasion.

- [ ] **Step 4: Implement circuit breaker**

States: closed, open, half-open. Health output includes reason and reopen time.

- [ ] **Step 5: Verify and commit**

```powershell
cd services/monitor-worker
npm test -- --run
git add services/monitor-worker
git commit -m "feat: add bounded retailer monitoring scheduler"
```

## Task 6: Implement Target adapter from captured fixtures

**Files:**

- Create: `services/monitor-worker/src/adapters/target.ts`
- Create: `services/monitor-worker/fixtures/target/*.json`
- Test: `services/monitor-worker/tests/adapters/target.test.ts`

- [ ] **Step 1: Create sanitized fixtures**

Capture only public product/availability responses or sanitized HTML. Remove cookies, tokens, location identifiers tied to a person, and request headers.

- [ ] **Step 2: Write parser tests**

Cover in stock, out of stock, pickup-only, shipping, missing price, malformed response, and challenge page.

- [ ] **Step 3: Implement adapter**

Prefer ordinary public product data already used by the existing monitor. Use timeout, conditional headers where supported, and no browser fingerprint or anti-bot bypass.

Challenge/CAPTCHA response returns a typed `blocked` adapter error and opens the circuit.

- [ ] **Step 4: Verify and commit**

```powershell
cd services/monitor-worker
npm test -- --run tests/adapters/target.test.ts
git add services/monitor-worker
git commit -m "feat: add Target central monitoring adapter"
```

## Task 7: Implement Walmart adapter from captured fixtures

**Files:**

- Create: `services/monitor-worker/src/adapters/walmart.ts`
- Create: `services/monitor-worker/fixtures/walmart/*.json`
- Test: `services/monitor-worker/tests/adapters/walmart.test.ts`

- [ ] **Step 1: Add sanitized fixtures and parser tests**

Cover in stock, out of stock, marketplace seller, retailer-owned listing, queue page, malformed response, 429, and challenge page.

- [ ] **Step 2: Implement adapter**

Queue pages are reported as availability metadata only. The worker does not enter, bypass, or optimize a retailer queue.

Marketplace offers remain distinguishable so task policy can reject non-retailer-owned inventory.

- [ ] **Step 3: Verify and commit**

```powershell
cd services/monitor-worker
npm test -- --run tests/adapters/walmart.test.ts
git add services/monitor-worker
git commit -m "feat: add Walmart central monitoring adapter"
```

## Task 8: Implement Pokémon Center adapter from captured fixtures

**Files:**

- Create: `services/monitor-worker/src/adapters/pokemonCenter.ts`
- Create: `services/monitor-worker/fixtures/pokemon-center/*.html`
- Test: `services/monitor-worker/tests/adapters/pokemonCenter.test.ts`

- [ ] **Step 1: Add sanitized HTML fixtures**

Cover available, sold out, preorder, missing price, malformed page, and challenge response.

- [ ] **Step 2: Implement parser**

Use deterministic HTML parsing. Do not execute page scripts in the central worker unless a later approved design explicitly adds a browser worker.

- [ ] **Step 3: Verify and commit**

```powershell
cd services/monitor-worker
npm test -- --run tests/adapters/pokemonCenter.test.ts
git add services/monitor-worker
git commit -m "feat: add Pokemon Center monitoring adapter"
```

## Task 9: Add catalog/admin dashboard integration

**Files:**

- Create/modify: `apps/dashboard/app/admin/catalog/**`
- Create: `apps/dashboard/app/dashboard/catalog/page.tsx`
- Create: `apps/dashboard/tests/catalog.test.ts`
- Modify: `src/main/control-plane/TaskSync.js`
- Test: `tests/main/control-plane/TaskSync.test.js`

- [ ] **Step 1: Implement admin catalog management**

Admins create canonical products, retailer mappings, activate/deactivate listings, and approve suggestions.

- [ ] **Step 2: Implement user catalog**

Users browse active mappings, suggest additions, and create tasks from a listing.

- [ ] **Step 3: Subscribe desktops**

Task sync joins private `listing:{listing_id}` channels only for the user's active tasks. A drop is treated as a notification; the desktop reloads listing/event data, validates max price and local readiness, then triggers the assigned task.

- [ ] **Step 4: Verify and commit**

```powershell
cd apps/dashboard
npm test -- --run tests/catalog.test.ts
npm run build
cd ../..
npm test -- --run tests/main/control-plane/TaskSync.test.js
git add apps/dashboard src/main/control-plane tests/main/control-plane
git commit -m "feat: connect catalog subscriptions to desktop tasks"
```

## Task 10: Containerize and verify ARM64 image

**Files:**

- Create: `services/monitor-worker/Dockerfile`
- Create: `services/monitor-worker/compose.yaml`
- Create: `services/monitor-worker/.dockerignore`
- Create: `services/monitor-worker/.env.example`
- Create: `services/monitor-worker/src/health.ts`
- Create: `docs/runbooks/monitor-worker-deployment.md`

- [ ] **Step 1: Create a non-root multi-stage Dockerfile**

Requirements:

- Node 22 ARM64-capable base
- Production dependencies only in final stage
- Non-root user
- Read-only application files
- `HEALTHCHECK`
- SIGTERM graceful shutdown

- [ ] **Step 2: Create Compose service**

```yaml
services:
  monitor-worker:
    build: .
    restart: unless-stopped
    env_file: .env
    read_only: true
    tmpfs:
      - /tmp:size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    healthcheck:
      test: ['CMD', 'node', 'dist/health.js']
      interval: 30s
      timeout: 5s
      retries: 3
```

No public ports.

- [ ] **Step 3: Build locally for ARM64**

```powershell
docker buildx build --platform linux/arm64 -t pokebot-monitor-worker:test --load services/monitor-worker
docker image inspect pokebot-monitor-worker:test
```

Expected architecture: `arm64`.

- [ ] **Step 4: Run container tests with fake backend**

Run the image with non-secret test environment and assert health becomes healthy.

- [ ] **Step 5: Commit**

```powershell
git add services/monitor-worker docs/runbooks/monitor-worker-deployment.md
git commit -m "build: package ARM64 monitor worker"
```

## Task 11: Provision a worker identity and deploy to Raspberry Pi

**Files:**

- Modify: `docs/runbooks/monitor-worker-deployment.md`
- Create on Pi: `/opt/pokebot-worker/compose.yaml`
- Create on Pi: `/opt/pokebot-worker/.env`

- [ ] **Step 1: Create worker identity**

Through an admin-only trusted operation:

- Generate a 32-byte random worker secret.
- Store only its hash in `workers`.
- Record worker ID/name `pokebot-worker`.
- Transfer the raw secret once to the Pi `.env`.

Do not print the secret in chat, logs, Git, or command output.

- [ ] **Step 2: Copy deployment files**

Use:

```powershell
scp services/monitor-worker/compose.yaml pokebot-worker:/opt/pokebot-worker/
```

Transfer image through a registry or build on the Pi. Prefer a private registry with an immutable digest once available.

- [ ] **Step 3: Create protected environment**

On Pi:

```bash
chmod 600 /opt/pokebot-worker/.env
chown hammikb:hammikb /opt/pokebot-worker/.env
```

- [ ] **Step 4: Deploy**

```powershell
ssh pokebot-worker "cd /opt/pokebot-worker && docker compose pull && docker compose up -d"
```

If building directly:

```powershell
ssh pokebot-worker "cd /opt/pokebot-worker && docker compose up -d --build"
```

- [ ] **Step 5: Verify**

```powershell
ssh pokebot-worker "cd /opt/pokebot-worker && docker compose ps"
ssh pokebot-worker "cd /opt/pokebot-worker && docker compose logs --tail=100 monitor-worker"
```

Expected:

- Container healthy
- Worker heartbeat visible
- No secret values in logs
- Lease count bounded by configuration
- Temperature and throttling healthy

- [ ] **Step 6: Reboot verification**

```powershell
ssh pokebot-worker "sudo reboot"
```

After reconnect:

```powershell
ssh pokebot-worker "cd /opt/pokebot-worker && docker compose ps"
```

Expected: worker restarted automatically and resumed heartbeat/leases.

## Task 12: End-to-end shared-monitoring and scale verification

**Files:**

- Create: `services/monitor-worker/tests/integration/multi-worker.test.ts`
- Create: `docs/runbooks/monitor-worker-operations.md`

- [ ] **Step 1: Multi-worker lease test**

Run two worker instances against the local Supabase stack. Assert each listing has one active lease and stale fencing writes fail.

- [ ] **Step 2: Fan-out test**

Create two users with multiple tasks subscribed to one listing. Feed a fixture transition and assert:

- One retailer observation path runs.
- One drop event is inserted.
- Both authorized users receive it.
- An unsubscribed user cannot join the private topic.

- [ ] **Step 3: Failure tests**

Verify:

- Worker termination causes lease recovery after expiry.
- 429/challenge opens the circuit.
- Repeated unchanged stock emits no duplicate.
- Realtime reconnect reloads missed events.
- Pi restart restores worker health.

- [ ] **Step 4: Capacity soak**

Use fixture-backed adapters to simulate hundreds of users and thousands of subscriptions without retailer traffic. Measure database query rate, Realtime joins, lease renewal load, memory, and event-loop lag.

- [ ] **Step 5: Full verification**

```powershell
npx supabase db reset
npx supabase test db
cd services/monitor-worker
npm test -- --run
npm run lint
npm run build
docker buildx build --platform linux/arm64 -t pokebot-monitor-worker:verify --load .
cd ../..
ssh pokebot-worker "cd /opt/pokebot-worker && docker compose ps"
```

- [ ] **Step 6: Commit**

```powershell
git add services/monitor-worker/tests docs/runbooks/monitor-worker-operations.md
git commit -m "test: verify shared monitoring and worker recovery"
```

## Milestone 2 completion gate

Completion requires fresh evidence that:

- All three adapter fixture suites pass.
- Database RLS and lease tests pass.
- One listing produces one poll path regardless of subscriber count.
- Unauthorized Realtime joins fail.
- ARM64 image builds.
- Pi container is healthy after reboot.
- Worker loss recovers without duplicate active leases.
- No CAPTCHA, queue, access-control, or rate-limit bypass exists.
