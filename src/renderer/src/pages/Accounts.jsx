/* eslint-disable react/prop-types */
import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILERS } from '../../../shared/constants'

const SUPPORTED_ACCOUNT_RETAILERS = [RETAILERS.TARGET, RETAILERS.WALMART]
const INPUT_CLASS = 'w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200'

const makeEmptyForm = () => ({
  name: '',
  retailer: RETAILERS.TARGET,
  username: '',
  password: '',
  cvv: '',
  proxy: '',
  shipping: {
    firstName: '',
    lastName: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    phone: ''
  }
})

export default function Accounts() {
  const { accounts, createAccount, deleteAccount, settings, registerAccount, setAccountStatus, accountRegistrationStatuses } = useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(makeEmptyForm)
  const [bulkRows, setBulkRows] = useState('')
  const [bulkStatus, setBulkStatus] = useState('')
  const [registerOnSite, setRegisterOnSite] = useState(false)
  const [registerStatus, setRegisterStatus] = useState('')
  const [bulkCreateRows, setBulkCreateRows] = useState('')
  const [bulkCreateStatus, setBulkCreateStatus] = useState('')
  const importedProxies = Array.isArray(settings.proxies) ? settings.proxies : []
  const proxyCounts = getProxyCounts(accounts)

  const setF = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const setShipping = (key, value) =>
    setForm((current) => ({
      ...current,
      shipping: {
        ...current.shipping,
        [key]: value
      }
    }))

  const submit = async (event) => {
    event.preventDefault()
    const accountData = { ...form, name: form.name || makeAccountName(form) }
    if (registerOnSite) {
      setRegisterStatus('Registering...')
      const result = await registerAccount({
        ...accountData,
        email: form.username,
        firstName: form.shipping.firstName,
        lastName: form.shipping.lastName,
        phone: form.shipping.phone
      })
      if (result.success) {
        setRegisterStatus('Registered — check email to verify')
        setForm(makeEmptyForm())
        setRegisterOnSite(false)
      } else {
        setRegisterStatus(result.alreadyExists ? 'Already registered on site' : result.error || 'Registration failed')
      }
    } else {
      await createAccount(accountData)
      setShowForm(false)
      setForm(makeEmptyForm())
    }
  }

  const bulkCreateOnSite = async () => {
    const rows = parseBulkRows(bulkCreateRows)
    if (rows.length === 0) {
      setBulkCreateStatus('No valid rows found')
      return
    }
    let succeeded = 0
    let failed = 0
    for (let i = 0; i < rows.length; i++) {
      setBulkCreateStatus(`Registering ${i + 1}/${rows.length}...`)
      const row = rows[i]
      const result = await registerAccount({
        ...row,
        email: row.username,
        firstName: row.shipping.firstName,
        lastName: row.shipping.lastName,
        phone: row.shipping.phone
      })
      if (result.success) succeeded++
      else failed++
    }
    setBulkCreateRows('')
    setBulkCreateStatus(`Done: ${succeeded} registered, ${failed} failed`)
  }

  const importBulkAccounts = async () => {
    const rows = parseBulkRows(bulkRows)
    if (rows.length === 0) {
      setBulkStatus('No valid rows found')
      return
    }

    setBulkStatus(`Importing ${rows.length} accounts...`)
    for (const row of rows) {
      await createAccount(row)
    }
    setBulkRows('')
    setBulkStatus(`Imported ${rows.length} accounts`)
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-sm uppercase tracking-widest text-gray-400">
            Accounts ({accounts.length})
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            Store customer-provided Target and Walmart account details for checkout tasks.
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
              <input
                required
                type="password"
                value={form.password}
                onChange={(event) => setF('password', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="CVV">
              <input
                value={form.cvv}
                onChange={(event) => setF('cvv', event.target.value)}
                maxLength={4}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Proxy">
              <select
                value={form.proxy}
                onChange={(event) => setF('proxy', event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">No proxy</option>
                {importedProxies.map((proxy) => (
                  <option key={proxy} value={proxy}>
                    {proxyLabel(proxy, proxyCounts)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="First Name">
              <input
                required={registerOnSite}
                value={form.shipping.firstName}
                onChange={(event) => setShipping('firstName', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Last Name">
              <input
                required={registerOnSite}
                value={form.shipping.lastName}
                onChange={(event) => setShipping('lastName', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <Field label="Address">
            <input
              value={form.shipping.address1}
              onChange={(event) => setShipping('address1', event.target.value)}
              placeholder="Street address"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Address 2">
            <input
              value={form.shipping.address2}
              onChange={(event) => setShipping('address2', event.target.value)}
              placeholder="Apt, suite, unit"
              className={INPUT_CLASS}
            />
          </Field>

          <div className="grid grid-cols-4 gap-3">
            <Field label="City">
              <input
                value={form.shipping.city}
                onChange={(event) => setShipping('city', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="State">
              <input
                value={form.shipping.state}
                onChange={(event) => setShipping('state', event.target.value.toUpperCase())}
                maxLength={2}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Zip">
              <input
                value={form.shipping.zip}
                onChange={(event) => setShipping('zip', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Phone">
              <input
                value={form.shipping.phone}
                onChange={(event) => setShipping('phone', event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="registerOnSite"
              checked={registerOnSite}
              onChange={(e) => setRegisterOnSite(e.target.checked)}
              className="accent-red-600"
            />
            <label htmlFor="registerOnSite" className="text-gray-400 uppercase tracking-wider">
              Register on site (bot creates account)
            </label>
          </div>

          {registerStatus && (
            <div className={`text-sm ${registerStatus.includes('fail') || registerStatus.includes('error') || registerStatus.includes('Already') ? 'text-red-400' : 'text-green-400'}`}>
              {registerStatus}
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold text-sm"
          >
            {registerOnSite ? 'Register on Site' : 'Save Account'}
          </button>
        </form>
      )}

      <section className="bg-[#111] border border-gray-800 rounded p-4 space-y-4 text-sm">
        <div>
          <h3 className="text-gray-400 uppercase tracking-widest mb-1.5">Bulk Import</h3>
          <p className="text-gray-600">
            CSV format:
            retailer,email,password,first,last,address1,address2,city,state,zip,phone,proxy
          </p>
        </div>
        <textarea
          value={bulkRows}
          onChange={(event) => setBulkRows(event.target.value)}
          rows={4}
          placeholder="target,user@email.com,password,Ash,Ketchum,1 Pallet Town,,Pallet,CA,90210,5551234567,1.2.3.4:8080:user:pass"
          className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={importBulkAccounts}
            disabled={!bulkRows.trim()}
            className="text-sm border border-red-700 text-red-400 hover:border-red-500 disabled:border-gray-800 disabled:text-gray-700 px-4 py-2 rounded uppercase tracking-wider font-bold"
          >
            Import Accounts
          </button>
          <span className="text-gray-600">{bulkStatus || 'Passwords are encrypted on save.'}</span>
        </div>
      </section>

      <section className="bg-[#111] border border-gray-800 rounded p-4 space-y-4 text-sm">
        <div>
          <h3 className="text-gray-400 uppercase tracking-widest mb-1.5">Bulk Create on Site</h3>
          <p className="text-gray-600">
            Bot registers each account on Target/Walmart. Same CSV format as bulk import.
          </p>
        </div>
        <textarea
          value={bulkCreateRows}
          onChange={(e) => setBulkCreateRows(e.target.value)}
          rows={4}
          placeholder="target,user@email.com,password,Ash,Ketchum,1 Pallet Town,,Pallet,CA,90210,5551234567"
          className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={bulkCreateOnSite}
            disabled={!bulkCreateRows.trim()}
            className="text-sm border border-red-700 text-red-400 hover:border-red-500 disabled:border-gray-800 disabled:text-gray-700 px-4 py-2 rounded uppercase tracking-wider font-bold"
          >
            Create Accounts on Site
          </button>
          <span className="text-gray-600">{bulkCreateStatus}</span>
        </div>
      </section>

      <div className="space-y-2">
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

function parseBulkRows(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseBulkRow(line, index))
    .filter(Boolean)
}

function parseBulkRow(line, index) {
  const [
    retailer = RETAILERS.TARGET,
    username = '',
    password = '',
    firstName = '',
    lastName = '',
    address1 = '',
    address2 = '',
    city = '',
    state = '',
    zip = '',
    phone = '',
    proxy = ''
  ] = splitCsvLine(line)

  if (!username || !password) return null
  const normalizedRetailer = SUPPORTED_ACCOUNT_RETAILERS.includes(retailer)
    ? retailer
    : RETAILERS.TARGET

  return {
    name: `${normalizedRetailer}-${username || index + 1}`,
    retailer: normalizedRetailer,
    username,
    password,
    proxy,
    shipping: {
      firstName,
      lastName,
      address1,
      address2,
      city,
      state: state.toUpperCase(),
      zip,
      phone
    }
  }
}

function splitCsvLine(line) {
  return line.split(',').map((part) => part.trim())
}

function getProxyCounts(accounts) {
  return accounts.reduce((counts, account) => {
    if (!account.proxy) return counts
    counts[account.proxy] = (counts[account.proxy] || 0) + 1
    return counts
  }, {})
}

function proxyLabel(proxy, counts) {
  const count = counts[proxy] || 0
  return `${proxyHost(proxy)} - ${count} account${count === 1 ? '' : 's'} tied`
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
