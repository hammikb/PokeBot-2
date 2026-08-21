# Checkout Account Ownership Design

## Goal

Prevent a test checkout or manual `Run now` checkout from being closed or displaced by another task using the same retailer account.

## Design

TaskManager will maintain an explicit checkout ownership lease keyed by account ID. A test checkout and `Run now` acquire the lease before launching automation. Existing automatic drop handling also consults the lease before starting an account checkout.

The lease records the task, product, mode, and acquisition time. While held, other tasks receive a clear account-busy result and do not launch a browser. The owning checkout pins its browser context; cleanup from unrelated tasks cannot close a pinned context.

The lease is released in a `finally` path after success, ordinary failure, explicit stop, or manual-review handoff. A manual-review/test-ready result keeps the browser context available but releases only when the user closes or takes over the checkout. Stale leases are recoverable on app startup and never permanently block an account.

## UI behavior

Tasks show `busy` state for an account conflict and explain which product currently owns it. `Run now` and test actions report the busy reason instead of silently failing.

## Testing

Regression tests cover lease acquisition/rejection, release on all terminal paths, preservation of manual-review contexts, and blocking concurrent tasks sharing one account.
