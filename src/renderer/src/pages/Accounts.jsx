/* eslint-disable react/prop-types */
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILERS } from '../../../shared/constants'

const SUPPORTED_ACCOUNT_RETAILERS = [
  RETAILERS.TARGET,
  RETAILERS.WALMART,
  RETAILERS.POKEMON_CENTER,
  RETAILERS.SAMS_CLUB
]
const PAYMENT_ACCOUNT_RETAILERS = new Set([
  RETAILERS.TARGET,
  RETAILERS.POKEMON_CENTER,
  RETAILERS.SAMS_CLUB
])
const INPUT_CLASS = 'w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200'

const makeEmptyForm = () => ({
  name: '',
  retailer: RETAILERS.TARGET,
  username: '',
  password: '',
  paymentMethodId: ''
})

export default function Accounts() {
  const {
    accounts,
    paymentMethods,
    createAccount,
    updateAccount,
    loadPaymentMethods,
    deleteAccount,
    setAccountStatus,
    openAccountSession,
    prepareAccountSession,
    inspectAccountCookies,
    checkAccountSession,
    autoLoginTargetAccount
  } = useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(makeEmptyForm)
  const [showPassword, setShowPassword] = useState(false)
  const [sessionStatus, setSessionStatus] = useState('')
  const [sessionCheckingId, setSessionCheckingId] = useState('')
  const [sessionPreparingId, setSessionPreparingId] = useState('')
  const [cookieCheckingId, setCookieCheckingId] = useState('')
  const [autoLoginId, setAutoLoginId] = useState('')
  const proxyCounts = getProxyCounts(accounts)

  useEffect(() => {
    loadPaymentMethods()
  }, [loadPaymentMethods])

  const setF = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event) => {
    event.preventDefault()
    const accountData = { ...form, name: form.name || makeAccountName(form) }
    await createAccount(accountData)
    setShowForm(false)
    setForm(makeEmptyForm())
  }

  const openSession = async (account) => {
    setSessionStatus(`Opening the saved browser profile for ${account.name}...`)
    try {
      await openAccountSession(account.id)
      setSessionStatus(
        `Browser opened for ${account.name}. Sign in if needed; this profile will be reused for tasks.`
      )
    } catch (err) {
      setSessionStatus(err.message || 'Could not open account browser')
    }
  }

  const checkSession = async (account) => {
    setSessionCheckingId(account.id)
    setSessionStatus(`Checking saved Target session for ${account.name}...`)
    try {
      const result = await checkAccountSession(account.id)
      const screenshot = result.screenshotPath ? ` Screenshot: ${result.screenshotPath}` : ''
      setSessionStatus(`${result.message || result.error || 'Session check finished'}${screenshot}`)
    } catch (err) {
      setSessionStatus(err.message || 'Could not check saved session')
    } finally {
      setSessionCheckingId('')
    }
  }

  const prepareSession = async (account) => {
    setSessionPreparingId(account.id)
    setSessionStatus(`Preparing the saved ${account.retailer} session for ${account.name}...`)
    try {
      const result = await prepareAccountSession(account.id)
      setSessionStatus(result.message || result.error || 'Session preparation finished')
    } catch (err) {
      setSessionStatus(err.message || 'Could not prepare account session')
    } finally {
      setSessionPreparingId('')
    }
  }

  const inspectCookies = async (account) => {
    setCookieCheckingId(account.id)
    setSessionStatus(`Checking saved ${account.retailer} cookies for ${account.name}...`)
    try {
      const result = await inspectAccountCookies(account.id)
      const domains = result.domains?.length ? ` Domains: ${result.domains.join(', ')}.` : ''
      setSessionStatus(`${result.message || 'Cookie check finished'}${domains}`)
    } catch (err) {
      setSessionStatus(err.message || 'Could not inspect account cookies')
    } finally {
      setCookieCheckingId('')
    }
  }

  const autoLogin = async (account) => {
    setAutoLoginId(account.id)
    setSessionStatus(`Running Target auto-login for ${account.name}...`)
    try {
      const result = await autoLoginTargetAccount(account.id)
      const screenshot = result.screenshotPath ? ` Screenshot: ${result.screenshotPath}` : ''
      setSessionStatus(`${result.message || result.error || 'Auto-login finished'}${screenshot}`)
    } catch (err) {
      setSessionStatus(err.message || 'Could not run Target auto-login')
    } finally {
      setAutoLoginId('')
    }
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-sm uppercase tracking-widest text-gray-400">
            Accounts ({accounts.length})
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            Store customer-provided retailer accounts and link each checkout profile to its saved
            payment.
          </p>
        </div>
        <button
          onClick={() => setShowForm((showing) => !showing)}
          className="text-sm bg-red-600 hover:bg-red-500 px-4 py-2 rounded uppercase tracking-wider font-bold"
        >
          {showForm ? 'Cancel' : '+ Add Account'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={submit}
          className="bg-[#111] border border-gray-800 rounded p-4 space-y-5 text-sm"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account Name">
              <input
                value={form.name}
                onChange={(event) => setF('name', event.target.value)}
                placeholder="Optional display name"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Retailer">
              <select
                value={form.retailer}
                onChange={(event) => setF('retailer', event.target.value)}
                className={INPUT_CLASS}
              >
                {SUPPORTED_ACCOUNT_RETAILERS.map((retailer) => (
                  <option key={retailer} value={retailer}>
                    {retailer}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {PAYMENT_ACCOUNT_RETAILERS.has(form.retailer) && (
            <Field label="Checkout Payment Method">
              <select
                value={form.paymentMethodId}
                onChange={(event) => setF('paymentMethodId', event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Use payment already saved on retailer</option>
                {paymentMethods.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.name} •••• {method.cardLast4}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Email / Username">
              <input
                required
                value={form.username}
                onChange={(event) => setF('username', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(event) => setF('password', event.target.value)}
                  className={INPUT_CLASS + ' pr-14'}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 text-xs uppercase tracking-wider"
                >
                  {showPassword ? 'hide' : 'show'}
                </button>
              </div>
            </Field>
          </div>

          <button
            type="submit"
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold text-sm"
          >
            Save Account
          </button>
        </form>
      )}

      <div className="space-y-2">
        {sessionStatus && (
          <div className="bg-[#111] border border-gray-800 rounded px-4 py-3 text-sm text-gray-500">
            {sessionStatus}
          </div>
        )}
        {accounts.map((account) => {
          const shipping = parseShipping(account.shipping_json)
          return (
            <div
              key={account.id}
              className="bg-[#111] border border-gray-800 rounded px-4 py-4 flex items-center gap-4 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-gray-200">{account.name}</span>
                  {account.status === 'unverified' && (
                    <span className="text-yellow-500 border border-yellow-700 rounded px-1 py-0.5 text-sm uppercase tracking-wider">
                      unverified
                    </span>
                  )}
                  {account.status === 'verified' && (
                    <span className="text-green-500 border border-green-700 rounded px-1 py-0.5 text-sm uppercase tracking-wider">
                      verified
                    </span>
                  )}
                </div>
                <div className="text-gray-500">
                  {account.retailer} - {account.username}
                </div>
                {PAYMENT_ACCOUNT_RETAILERS.has(account.retailer) && (
                  <select
                    value={account.payment_method_id || ''}
                    onChange={(event) =>
                      updateAccount(account.id, { paymentMethodId: event.target.value || null })
                    }
                    className="mt-2 max-w-sm bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-300"
                    aria-label={`Payment method for ${account.name}`}
                  >
                    <option value="">Use payment already saved on retailer</option>
                    {paymentMethods.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.name} •••• {method.cardLast4}
                      </option>
                    ))}
                  </select>
                )}
                {shipping.address1 && (
                  <div className="text-gray-600 truncate">
                    {shipping.address1}, {shipping.city}, {shipping.state} {shipping.zip}
                  </div>
                )}
                {account.proxy && (
                  <div className="text-gray-600">
                    proxy: {proxyHost(account.proxy)} ({proxyCounts[account.proxy] || 0} accounts)
                  </div>
                )}
              </div>
              {account.status === 'unverified' && (
                <button
                  onClick={() => setAccountStatus(account.id, 'verified')}
                  className="text-green-600 hover:text-green-400 shrink-0 text-sm"
                >
                  mark verified
                </button>
              )}
              <button
                onClick={() => openSession(account)}
                className="text-blue-500 hover:text-blue-300 shrink-0 text-sm"
                title="Open the saved browser profile for this retailer account"
              >
                open profile
              </button>
              <button
                onClick={() => prepareSession(account)}
                disabled={sessionPreparingId === account.id}
                className="text-cyan-500 hover:text-cyan-300 disabled:text-gray-700 shrink-0 text-sm"
                title="Load this retailer's checkout pages into the saved profile"
              >
                {sessionPreparingId === account.id ? 'preparing...' : 'prepare session'}
              </button>
              <button
                onClick={() => inspectCookies(account)}
                disabled={cookieCheckingId === account.id}
                className="text-purple-500 hover:text-purple-300 disabled:text-gray-700 shrink-0 text-sm"
                title="Inspect cookie counts and expiry without exposing cookie values"
              >
                {cookieCheckingId === account.id ? 'checking...' : 'cookie health'}
              </button>
              {account.retailer === RETAILERS.TARGET && (
                <>
                  <button
                    onClick={() => checkSession(account)}
                    disabled={sessionCheckingId === account.id}
                    className="text-green-500 hover:text-green-300 disabled:text-gray-700 shrink-0 text-sm"
                  >
                    {sessionCheckingId === account.id ? 'checking...' : 'check login'}
                  </button>
                  <button
                    onClick={() => autoLogin(account)}
                    disabled={autoLoginId === account.id}
                    className="text-yellow-500 hover:text-yellow-300 disabled:text-gray-700 shrink-0 text-sm"
                  >
                    {autoLoginId === account.id ? 'logging in...' : 'auto login'}
                  </button>
                </>
              )}
              <button
                onClick={() => deleteAccount(account.id)}
                className="text-red-600 hover:text-red-400 shrink-0"
              >
                delete
              </button>
            </div>
          )
        })}
        {accounts.length === 0 && (
          <div className="text-gray-600 text-sm">No accounts yet. Add one above.</div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-gray-500 uppercase tracking-wider block mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function getProxyCounts(accounts) {
  return accounts.reduce((counts, account) => {
    if (!account.proxy) return counts
    counts[account.proxy] = (counts[account.proxy] || 0) + 1
    return counts
  }, {})
}

function proxyHost(proxy) {
  const [host, port] = proxy.split(':')
  return host && port ? `${host}:${port}` : proxy
}

function parseShipping(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}

function makeAccountName(form) {
  return `${form.retailer}-${form.username}`
}
