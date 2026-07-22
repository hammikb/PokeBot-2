# Admin pin + website monitoring toggle (sub-project C follow-up)

**Date:** 2026-07-15
**Status:** Approved (brainstorm)
**Repos:** Supabase project PokeAlert (`jbnnouwhesexfllninwb`) + pokealert-web
(`C:\Users\kaib1\OneDrive\Desktop\Projects\Test HTPPCLOACK\pokealert-web`, no git repo,
deployed with `npx vercel deploy --prod --yes`)
**Builds on:** ref-counted central monitoring (2026-07-14 spec).

## Problem

The Vercel dashboard and Electron ref-counting fight over the single `products.active`
column. The admin dashboard writes `active` directly (add form, Power button), while the
`subscriptions_sync_product_active` trigger recomputes `active` from the subscriber count —
so a user subscribing then unsubscribing silently undoes an admin's "monitor this."
Separately, the dashboard's Catalog section shows a static "Added" badge that only means "a
products row exists," not "currently monitored" — after Electron-side unsubscribes flipped
rows inactive, the site still looked like it was monitoring them.

## Design

**Separate admin intent from user demand.** New column `products.pinned boolean not null
default false` = "admin wants this monitored regardless of subscribers." The invariant
becomes:

```
active = pinned OR EXISTS(subscription for this product)
```

- Website add/toggle controls `pinned` only. Electron tasks control `subscriptions` only.
  Neither can clobber the other.
- Trigger updated to compute the new invariant. A `SECURITY DEFINER` helper
  `admin_set_product_pinned(p_id uuid, p_pinned boolean)` flips the pin and recomputes
  `active` atomically; EXECUTE revoked from `anon`/`authenticated` (service-role/website only).
- Backfill: rows currently `active=true` with zero subscriptions (the 10 legacy admin
  watchlist rows) become `pinned=true`.
- Electron: no changes. Self-registered products default `pinned=false` (pure ref-count);
  subscribing to an inactive product still reactivates it via the trigger.

**Website changes (pokealert-web):**

- `api/products/route.js` POST: adds with `pinned=true` (admin adds are pins).
- `api/products/[id]/route.js` PATCH: accepts `{ pinned }`, calls the RPC. DELETE unchanged
  (FK already cascades subscriptions).
- Products panel: Status column shows `Pinned` / `N watching` / `Off` (subscriber counts from
  the subscriptions rows the page already fetches). Power button toggles the pin.
- Catalog section: the Add/"Added" button becomes an on/off monitoring toggle reflecting
  real `active` state. ON pins (creating the row if needed); OFF unpins — if users still
  watch it, it stays monitored and shows the watcher count instead of pretending it's off.

## Out of scope

- Auth on the dashboard itself (it's already service-role-backed and private).
- Any Pi worker change (`/api/watchlist` still filters `active=true`).
- Electron UI for showing watcher counts.

## Verification

- SQL matrix after migration: pin on/off × subscribe/unsubscribe → `active` always equals
  `pinned OR has-subs`.
- Website `npm test` (existing dashboard tests) + production deploy + live check.
