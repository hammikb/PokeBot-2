const CHECKOUT_FLOW_RETAILERS = new Set(['walmart'])

export function buildTaskReadiness({ tasks, accountManager, settings = {} }) {
  const taskTestResults = settings.taskTestResults || {}
  return Object.fromEntries(
    tasks.map((task) => [
      task.id,
      buildSingleTaskReadiness(task, accountManager, settings, taskTestResults)
    ])
  )
}

function buildSingleTaskReadiness(task, accountManager, settings, taskTestResults) {
  const accountIds = parseAccountIds(task.account_ids)
  const accountChecks = accountIds.map((accountId) =>
    checkAccount(task, accountManager, settings, accountId)
  )
  const checks = [
    check(
      'Checkout Flow',
      CHECKOUT_FLOW_RETAILERS.has(task.retailer),
      CHECKOUT_FLOW_RETAILERS.has(task.retailer)
        ? `${task.retailer} checkout flow is available`
        : `${task.retailer} checkout automation is reset`
    ),
    check(
      'Product',
      Boolean(task.product_url),
      task.product_url ? 'Catalog product selected' : 'Missing product URL'
    ),
    check(
      'Accounts',
      accountIds.length > 0,
      accountIds.length > 0 ? `${accountIds.length} account(s) selected` : 'No accounts selected'
    ),
    check(
      'Sessions',
      accountChecks.length > 0 && accountChecks.every((entry) => entry.session.ok),
      summarizeAccountCheck(accountChecks, 'session')
    ),
    check(
      'CVV',
      accountChecks.length > 0 && accountChecks.every((entry) => entry.cvv.ok),
      summarizeAccountCheck(accountChecks, 'cvv')
    ),
    check(
      'Proxies',
      accountChecks.length > 0 && accountChecks.every((entry) => entry.proxy.ok),
      summarizeAccountCheck(accountChecks, 'proxy')
    ),
    checkLastTest(taskTestResults[task.id])
  ]

  return {
    ready: checks.every((entry) => entry.ok),
    checks
  }
}

function checkAccount(task, accountManager, settings, accountId) {
  const account = accountManager.getDecrypted(accountId)
  if (!account) {
    const missing = check('Account', false, `Account ${accountId} not found`)
    return { session: missing, cvv: missing, proxy: missing }
  }

  return {
    session: check(
      account.name,
      account.retailer === task.retailer && account.status !== 'unverified',
      account.retailer !== task.retailer
        ? `${account.name} is a ${account.retailer} account`
        : account.status === 'unverified'
          ? `${account.name} needs email/login verification`
          : `${account.name} marked ready`
    ),
    cvv: check(
      account.name,
      Boolean(account.cvv),
      account.cvv ? `${account.name} has CVV saved` : `${account.name} is missing CVV`
    ),
    proxy: checkProxy(account, task.retailer, settings.proxyTestResults || {})
  }
}

function checkProxy(account, retailer, proxyTestResults) {
  if (!account.proxy) return check(account.name, true, `${account.name} uses direct connection`)

  const result = proxyTestResults[account.proxy]?.[retailer]
  return check(
    account.name,
    result?.state === 'pass',
    result?.state === 'pass'
      ? `${account.name} proxy passed ${retailer}`
      : `${account.name} proxy has not passed ${retailer} yet`
  )
}

function checkLastTest(result) {
  if (!result) return check('Last Test', false, 'No checkout test has passed yet')
  return check(
    'Last Test',
    result.success === true,
    result.success
      ? `Passed ${formatWhen(result.testedAt)}`
      : result.error || 'Last checkout test failed'
  )
}

function summarizeAccountCheck(accountChecks, key) {
  if (accountChecks.length === 0) return 'No accounts selected'
  const failing = accountChecks.find((entry) => !entry[key].ok)
  if (failing) return failing[key].message
  return accountChecks.length === 1
    ? accountChecks[0][key].message
    : `All ${accountChecks.length} accounts ready`
}

function check(label, ok, message) {
  return { label, ok, message }
}

function parseAccountIds(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatWhen(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}
