# Account Registration Automation — Design

**Date:** 2026-05-29  
**Status:** Approved

## Goal

Automate account creation on Target and Walmart. User provides credentials + shipping info; bot navigates to signup page, fills the form, submits, saves the account as `unverified`, and notifies the user to verify their email.

## Data Layer

### DB Migration

Add `status` column to `accounts` table:

```sql
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
```

- `'active'` — manually added accounts (existing behavior)
- `'unverified'` — bot-registered, awaiting email verification
- `'verified'` — email confirmed (set manually or later via IMAP)

### AccountManager changes

- `getAll()` — include `status` in SELECT
- `setStatus(id, status)` — UPDATE accounts SET status WHERE id
- `create()` — accept optional `status` param (default `'active'`)

### New IPC constants (constants.js)

- `ACCOUNTS_REGISTER` — `'accounts:register'` — trigger on-site registration
- `ACCOUNTS_SET_STATUS` — `'accounts:set-status'` — manually mark verified/active

## Registration Flows

### Files

- `src/main/automation/flows/register-target.js`
- `src/main/automation/flows/register-walmart.js`

### Signature

```js
export async function runTargetRegistration(context, { email, password, firstName, lastName, phone })
export async function runWalmartRegistration(context, { email, password, firstName, lastName, phone })
```

Returns: `{ success: boolean, needsVerification: boolean, alreadyExists: boolean, error?: string }`

### Target flow

1. `page.goto('https://www.target.com/account/create')`
2. Fill email, password, first name, last name
3. Submit form
4. Detect: success confirmation, "already exists" error, or generic error
5. Close page, return result

### Walmart flow

1. `page.goto('https://www.walmart.com/account/create')`
2. Fill email, password, first name, last name, phone
3. Submit form
4. Detect: success confirmation, "already exists" error, or generic error
5. Close page, return result

Both use `waitForCaptchaIfNeeded`. Address/shipping not filled at registration (sites don't ask at signup).

## IPC Handler — accounts:register

Located in `ipc.js`. On call:

1. Validate payload (retailer, email, password, firstName, lastName required)
2. Open browser context via BrowserPool
3. Run appropriate registration flow
4. If success: call `accountManager.create({ ..., status: 'unverified' })`
5. Emit `account:status` event with `{ id, status: 'unverified', message: 'Check your email to verify' }`
6. Return `{ success, accountId, needsVerification, alreadyExists, error }`

## UI Changes — Accounts.jsx

### Single account form

- Add "Register on Site" checkbox (default unchecked)
- When checked: submit calls `accounts:register` IPC instead of `accounts:create`
- Status shown inline after submission

### Bulk creation panel

- New panel below existing bulk-import section
- Same CSV format: `retailer,email,password,first,last,address1,address2,city,state,zip,phone,proxy`
- "Create Accounts on Site" button — iterates rows, calls `accounts:register` per row
- Progress: "Registering 3/10..." with per-row status

### Account list

- Show status badge (`unverified` in yellow, `verified` in green, `active` no badge)
- "Mark Verified" button on unverified accounts (calls `accounts:set-status`)

## Error Handling

- Network timeout → `{ success: false, error: 'Timeout' }`
- Already registered → `{ success: false, alreadyExists: true }` — do not save duplicate
- Captcha unsolved timeout → propagate error from `waitForCaptchaIfNeeded`
- Bulk: continue on per-row failure, collect errors, report at end

## Future

- IMAP auto-verification: `AccountManager.setStatus` already in place; IMAP flow just calls it after clicking link
