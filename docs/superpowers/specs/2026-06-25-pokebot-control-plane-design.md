# Pokébot Multi-Tenant Control Plane and Central Monitoring

**Date:** 2026-06-25
**Status:** Approved design
**Repository:** PokeBot 2
**Deployment:** Supabase + Vercel + dedicated ARM64 monitoring workers
**Initial worker host:** Raspberry Pi 4, `pokebot-worker`

## Goal

Build a Guppy-style backend for Pokébot that supports hundreds of invited users while keeping retailer sessions, credentials, shipping addresses, payment methods, cookies, and checkout execution on each user's computer.

The platform has two delivery milestones:

1. **Control plane:** invite-only accounts, up to two devices per user, cloud-synchronized tasks, one assigned executor per task, remote controls, realtime state, task leases, run history, and privacy-safe diagnostics.
2. **Central monitoring:** a shared catalog and horizontally scalable workers for Target, Walmart, and Pokémon Center. Each retailer listing is monitored once and its normalized stock events are fanned out to authorized tasks.

The platform must not circumvent retailer queues, CAPTCHAs, access controls, or rate limits. Remote checkout remains disabled until command delivery and monitoring complete soak testing.

## System Architecture

### Dedicated Supabase project

The new Supabase project is separate from the existing PokeAlert project. It provides:

- Email/password authentication
- PostgreSQL as the system of record
- Row-level security for tenant isolation
- Realtime Broadcast and Presence over private channels
- Private Storage buckets for sanitized diagnostics
- Scheduled retention cleanup
- Audit records and operational state

Only publishable client credentials are shipped to Electron and browser code. Secret or service credentials are restricted to trusted server-side components.

Supabase's April 28, 2026 behavior change means new tables may not be exposed to the Data API automatically. Migrations must explicitly grant only the required operations to `authenticated` or other intended roles and enable RLS on every exposed table.

### Next.js dashboard on Vercel

A separate Next.js application provides:

- Invite acceptance
- Login and password reset
- User task, device, run, and diagnostic views
- Remote task controls
- Admin invite, user, device, catalog, worker, feature-flag, limit, diagnostic, and audit views

Browser code uses only the publishable Supabase key and the signed-in user's session. Privileged actions execute in authenticated server routes or trusted functions and validate admin authorization from protected server-controlled data.

### Pokébot Electron client

The existing Electron application remains the executor. It gains:

- Supabase session management
- Device registration and revocation handling
- Cloud task synchronization
- Local checkout-profile mapping
- Command consumption and acknowledgement
- Task lease acquisition and renewal
- Realtime progress reporting
- Client-side diagnostic redaction and upload

### Dedicated monitoring workers

Node.js workers run as ARM64-compatible Docker containers. The first worker runs on the prepared Raspberry Pi at `/opt/pokebot-worker`. Additional workers can join without changing the client or database contract.

Workers:

- Claim retailer-listing leases
- Monitor Target, Walmart, and Pokémon Center
- Normalize observations
- Detect confirmed state transitions
- Publish immutable drop events
- Report worker health and adapter failures

### Local-only data

The following remain in encrypted local storage and never enter the backend:

- Retailer usernames and passwords
- Retailer cookies and browser profiles
- Payment methods and card data
- Shipping addresses
- Local account/session identifiers
- Task-to-checkout-profile mappings

Cloud tasks refer only to a local profile slot or capability requirement. The cloud never receives the underlying profile data.

## Trust Boundaries

The backend controls identities, devices, tasks, commands, leases, monitoring, run metadata, diagnostics, limits, and feature availability.

The desktop controls retailer authentication, browser sessions, readiness validation, local profile selection, checkout execution, and sensitive-value redaction.

The dashboard cannot initiate arbitrary code. It can create only typed, validated commands supported by the desktop command registry.

Monitoring workers cannot access user checkout profiles. Desktop clients cannot use worker or admin credentials. Browser clients cannot access service credentials.

## Accounts and Invites

### Invite flow

- Public registration is disabled.
- An admin creates a one-time invite tied to an email address.
- Invites expire after 72 hours and can be revoked before acceptance.
- Invite acceptance verifies the token, email, expiry, and unused state.
- The user sets a password and receives a normal Supabase Auth session.
- Supabase handles password-reset emails.
- Invite acceptance is idempotent and records the accepting user.

Invite tokens are stored as hashes, never plaintext. The raw token exists only in the invitation URL.

### Roles

Initial roles are:

- `user`: owns devices, tasks, runs, and diagnostics.
- `admin`: manages invites, users, catalog mappings, platform limits, workers, diagnostics, and audit records.
- `worker`: a machine identity used only by monitoring services.

Authorization data must not depend on user-editable metadata. Admin status is stored in protected app metadata or an RLS-protected membership table maintained only by trusted server code.

## Devices

Each user may have no more than two active devices.

A device record contains:

- User ID
- Human-readable name
- Stable installation ID
- Hashed device credential identifier
- Platform and architecture
- App version
- Supported capabilities
- Registration, last-seen, and revocation timestamps
- Current online and health state

Device credentials are individually revocable. Revocation invalidates pending commands and active leases for that device. Device secrets are stored encrypted by the operating system on the desktop; the backend stores only verifiers or hashes.

Devices send bounded heartbeats. Realtime Presence may improve dashboard responsiveness, but persisted `last_seen_at` remains authoritative.

## Tasks and Local Profile Mapping

Tasks are owned by users and visible on both of their devices. Each task has exactly one assigned executor device.

Cloud task data includes:

- User and assigned-device IDs
- Retailer and retailer-listing ID
- Product display metadata
- Quantity and buy limit
- Maximum price
- Task mode
- Schedule
- Enabled state
- Execution state and version
- Capability requirements
- Created and updated timestamps

Each device keeps a local mapping from cloud task ID to an encrypted local checkout profile. A task cannot enter `ready` on a device until the mapping exists and local readiness checks pass.

Reassigning a task does not copy sensitive data. The destination device must map a compatible local profile before execution.

## Commands

Supported initial commands are:

- `start`
- `stop`
- `pause`
- `resume`
- `test`
- `reassign`

Commands contain:

- User, task, and target-device IDs
- Command type and validated payload
- Idempotency key
- Creation and expiration timestamps
- Claim, acknowledgement, completion, and failure timestamps
- Result or error code

The dashboard inserts a short-lived command through a validated server action. A private Realtime channel notifies the target device.

The desktop:

1. Reloads the command from PostgreSQL.
2. Verifies ownership, target device, supported type, payload, and expiry.
3. Atomically claims it.
4. Executes it once.
5. Persists acknowledgement and final result.

Replayed deliveries return the existing result and never repeat execution. Commands that expire before claim are marked expired and shown clearly in the dashboard.

## Task Leases and State

Before execution, the assigned device acquires a renewable lease. The lease operation verifies:

- The task belongs to the same user.
- The device is active and assigned.
- No unexpired lease exists.
- The task state permits execution.

Leases contain holder, fencing token, acquisition time, renewal time, and expiry. Every state-changing run write includes the fencing token so a stale device cannot report after losing its lease.

If a device disappears, the lease expires and the run becomes interrupted. The backend does not automatically move or restart checkout on another device. The user must explicitly reassign and restart.

Task state follows:

```text
draft -> ready -> starting -> monitoring -> triggered -> running
                                                 |          |
                                                 v          v
                                               stopped  succeeded
                                                          failed
                                                       interrupted
```

Invalid transitions are rejected in the database transaction that records them.

## Realtime Topics

All application topics are private and require RLS authorization on `realtime.messages`.

Initial topic families:

- `user:{user_id}`: task summaries and account-level notifications
- `device:{device_id}`: commands and device-specific updates
- `task:{task_id}`: status and progress
- `listing:{listing_id}`: normalized monitoring events for authorized subscribers
- `admin:workers`: worker health for admins

Clients instantiate channels with `config: { private: true }`. Policies use `realtime.topic()` and membership checks. Realtime authorization is treated as notification authorization, not as the only data-security boundary; every underlying table also has RLS.

## Runs and Events

Every execution creates a run containing:

- User, task, and device IDs
- Lease fencing token
- Retailer and product snapshot
- Start, trigger, completion, and duration timestamps
- Final status
- Failure code and sanitized message
- Sanitized order-result metadata
- App and platform versions

Run events are append-only and include sequence number, event type, timestamp, progress, sanitized message, and structured metadata. Sequence and idempotency constraints suppress duplicates after reconnects.

Order-result metadata may contain retailer order reference, item count, total amount, and result status only after redaction. It must not contain card values, retailer credentials, addresses, cookies, or tokens.

## Diagnostics

### Allowed diagnostic objects

- Sanitized logs
- Sanitized HTML snapshots
- Redacted screenshots
- Compressed, redacted run recordings

Recording is disabled during payment entry and final order submission. Raw recordings are never uploaded.

### Client-side redaction

Before upload, the desktop:

- Removes passwords, cookies, authorization headers, access tokens, and storage values.
- Removes or masks payment fields, addresses, emails, phone numbers, and account identifiers.
- Removes scripts, hidden inputs, event handlers, and embedded session data from HTML.
- Applies visual masks before screenshots or recording frames are captured.
- Runs forbidden-pattern validation over the final artifact.
- Rejects the upload if validation fails.

Redaction failures do not block task completion. They create a local diagnostic error and upload only safe metadata.

### Storage and access

Diagnostics use private Storage buckets with paths scoped by user and run. Signed download URLs are short-lived.

Users may view and delete their diagnostics. Admins may view, download, and delete diagnostics automatically. Every admin action is recorded in an append-only audit log with actor, target, action, timestamp, request context, and reason where required.

### Retention

Detailed diagnostic objects expire seven days after creation. Users may delete them sooner. A scheduled cleanup removes Storage objects through the Storage API and then marks or removes associated metadata. Direct SQL deletion from `storage.objects` is prohibited.

Lightweight run metrics remain after diagnostic expiry for aggregate statistics.

## Catalog

### Canonical products

A canonical product represents one Pokémon item independent of retailer. It contains normalized title, set/category, image, optional identifiers, and active status.

### Retailer listings

A retailer listing maps a canonical product to:

- Retailer
- Retailer item key, such as Target TCIN or Walmart item ID
- Canonical URL
- Retailer SKU where applicable
- Current display title and image
- Active status
- Monitoring configuration

The unique identity is retailer plus retailer item key.

Admins can create and update mappings. Users can submit mapping suggestions, but suggestions do not become monitorable until approved.

### Subscriptions

Tasks subscribe to retailer listings. Multiple tasks and users watching the same listing do not create extra retailer polls.

## Monitoring Workers

### Lease model

Workers atomically claim listing leases from PostgreSQL. A lease has a worker ID, fencing token, acquisition time, renewal time, and expiry.

Workers periodically renew leases. If a worker dies, another worker may claim the listing after expiry. Writes from stale fencing tokens are rejected.

### Retailer adapters

Initial adapters:

- Target
- Walmart
- Pokémon Center

Each adapter:

- Uses ordinary publicly reachable pages or permitted endpoints.
- Has bounded concurrency and request timeouts.
- Applies randomized jitter and exponential backoff.
- Uses conditional requests where supported.
- Shares a retailer-wide rate budget.
- Produces a normalized observation contract.
- Opens a circuit breaker after repeated failures.

The system does not bypass CAPTCHAs, queues, access controls, or retailer rate limits.

### Observation contract

An observation contains:

- Listing and retailer IDs
- Observed timestamp
- Availability state
- Price and currency
- Fulfillment methods
- Source and confidence
- Response fingerprint
- Sanitized adapter metadata

Workers retain the latest state and a bounded observation history. A confirmed state transition creates one immutable drop event. Debounce and deduplication prevent repeated events for an unchanged state.

### Fan-out

Drop events are inserted once and broadcast to private listing topics. Authorized tasks receive the event. The assigned desktop still evaluates task-specific maximum price, quantity, mode, readiness, and local profile availability before acting.

## Worker Operations

Workers report:

- Worker ID and version
- Host architecture
- Started and last-heartbeat timestamps
- Active lease count
- Per-retailer success/error counts
- Queue depth
- Circuit-breaker state
- Memory and event-loop health

The initial Raspberry Pi deployment uses Docker Compose in `/opt/pokebot-worker` with:

- Restart policy `unless-stopped`
- Bounded container logs
- Health check
- Read-only application filesystem where practical
- Non-root container user
- Environment file readable only by the deployment user
- No inbound public ports

The worker makes outbound TLS connections to Supabase and retailer sites. Supabase secret credentials exist only in the worker environment and Vercel server environment.

## Dashboard

### User experience

Users can:

- Accept an invite, sign in, and reset passwords.
- View and rename their two devices.
- Revoke a device.
- Create and edit tasks.
- Assign tasks to an active device.
- See local-readiness requirements without exposing local profile data.
- Start, stop, pause, resume, and test tasks remotely.
- View live state, command acknowledgements, runs, events, and diagnostics.
- Delete diagnostics before retention expiry.

### Admin experience

Admins can:

- Create, resend, revoke, and inspect invites.
- Disable users and revoke sessions/devices.
- Inspect task and worker health.
- Manage canonical products and retailer listings.
- Review user mapping suggestions.
- Configure feature flags and per-user limits.
- View diagnostics.
- Review audit records.

Admin diagnostic access is automatic by approved product decision, but always audited.

## Initial Data Model

The implementation plan will define migrations for these logical tables:

- `profiles`
- `invites`
- `devices`
- `tasks`
- `device_task_profiles` only as local SQLite data, not cloud data
- `commands`
- `task_leases`
- `runs`
- `run_events`
- `diagnostic_objects`
- `audit_events`
- `feature_flags`
- `user_limits`
- `canonical_products`
- `retailer_listings`
- `listing_suggestions`
- `listing_subscriptions`
- `listing_leases`
- `listing_observations`
- `drop_events`
- `workers`

Every public/exposed table has RLS enabled. Policies include ownership predicates rather than relying only on `TO authenticated`. Update policies use both `USING` and `WITH CHECK`. Views exposed to clients use `security_invoker = true`.

Privileged functions live outside exposed schemas where possible, validate `auth.uid()` or worker identity explicitly, set a safe `search_path`, and have narrowly granted execution rights.

## Failure Handling

- Offline devices do not retain commands indefinitely; commands expire visibly.
- Realtime reconnects reconcile from PostgreSQL rather than trusting missed messages.
- Diagnostic upload failures do not change run outcome.
- Expired leases make runs interrupted and fence stale writers.
- Worker lease loss stops monitoring before another worker takes over.
- Retailer adapter failures use retry budgets and circuit breakers.
- Duplicate commands, events, and observations are suppressed by unique idempotency keys.
- Storage cleanup is retryable and records failures for admin review.
- Feature flags can disable remote checkout, diagnostics, individual retailers, or central monitoring without shipping a new client.

## Testing

### Database and authorization

- Invite expiry, one-time use, revocation, and email binding
- Maximum two active devices per user under concurrent registration
- RLS isolation between users on every exposed table
- Admin authorization and audit coverage
- Device revocation invalidates commands and leases
- Data API grants match intended client operations
- Private Realtime topics reject unauthorized users

### Commands and leases

- Command expiry and idempotent replay
- Two devices racing to claim one command
- Two devices racing for one task lease
- Fencing rejects stale device writes
- Reconnect reconciliation after missed broadcasts
- Invalid task-state transitions are rejected

### Diagnostics

- Redaction fixtures for credentials, cookies, cards, addresses, emails, phone numbers, and tokens
- Screenshot/recording masking
- Forbidden-pattern upload rejection
- User/admin Storage access
- Audit records for admin access
- Seven-day cleanup and user-triggered deletion

### Monitoring

- Adapter contract fixtures for all three retailers
- Rate-budget, timeout, retry, and circuit-breaker behavior
- Observation normalization
- State-transition debounce and deduplication
- Multi-worker lease acquisition and expiry
- Fencing-token enforcement
- Authorized event fan-out

### Deployment and end-to-end

- ARM64 image build
- Container health check on Raspberry Pi
- Dashboard command to simulated desktop acknowledgement
- Listing transition to authorized task trigger
- Desktop local-readiness gate
- Soak testing with remote checkout disabled

## Delivery Sequence

### Milestone 1: Control plane

1. Create the dedicated Supabase project and migration framework.
2. Implement invite-only Auth, profiles, admin roles, and audit records.
3. Add device registration, two-device enforcement, revocation, and heartbeats.
4. Add cloud tasks and local profile mapping.
5. Add commands, private Realtime notifications, task leases, and run events.
6. Add the Next.js user/admin dashboard.
7. Add diagnostics redaction, Storage upload, access, audit, and cleanup.
8. Run isolation, race, reconnect, and soak tests.

### Milestone 2: Catalog and central monitoring

1. Add canonical products, retailer listings, suggestions, and subscriptions.
2. Implement worker identities, listing leases, observations, and drop events.
3. Implement Target, Walmart, and Pokémon Center adapters.
4. Build and publish the ARM64 worker image.
5. Deploy one worker to `pokebot-worker`.
6. Verify leases, health reporting, event fan-out, and restart recovery.
7. Add capacity only by starting more identical workers.

## Explicit Non-Goals

- Storing or synchronizing retailer credentials, cookies, payment methods, or shipping addresses
- Server-side checkout
- CAPTCHA solving
- Queue bypassing
- Anti-bot evasion
- Automatic checkout failover to another device
- Public account registration
- Supporting retailers beyond Target, Walmart, and Pokémon Center in the first central-monitoring release

## Success Criteria

The design is successful when:

- Invited users can access only their own data.
- A user cannot register more than two active devices.
- A task is visible on both devices but executable only by its assigned device.
- Remote commands execute once and report durable results.
- Device or network loss cannot produce duplicate task execution.
- Detailed diagnostics are redacted, access-controlled, audited, and deleted after seven days.
- Hundreds of users watching one listing result in one shared monitor lease, not hundreds of polls.
- Monitoring workers can be added or replaced without client changes.
- The Raspberry Pi worker survives reboot and resumes healthy monitoring.
- No retailer/payment secret leaves the desktop.
