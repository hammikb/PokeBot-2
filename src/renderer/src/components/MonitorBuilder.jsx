/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILER_BUY_LIMITS, TASK_MODES } from '../../../shared/constants'

const RETAILERS = ['target', 'walmart']

export default function MonitorBuilder({
  product,
  existingMonitor = null,
  onCancel,
  onSaved,
  isNewTask = false
}) {
  const { accounts, walmartMatches, loadWalmartMatches, saveMonitor } = useAppStore()
  const [mode, setMode] = useState(existingMonitor?.action_mode || TASK_MODES.AUTO_CHECKOUT)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadWalmartMatches().catch(() => {})
  }, [loadWalmartMatches])

  const defaultSource = (retailer) => ({
    retailer,
    enabled: false,
    productUrl: '',
    msrp: '',
    priceCeiling: '',
    buyLimit: RETAILER_BUY_LIMITS[retailer],
    accountIds: [],
    verificationStatus: 'unverified'
  })

  const initialSources = useMemo(() => {
    // Editing an existing monitor: prefill each retailer from its saved source
    // (price limit, buy limit, accounts, enabled state) instead of re-deriving
    // fresh defaults from the bare product — otherwise saving would silently
    // discard everything already configured.
    if (existingMonitor) {
      const byRetailer = Object.fromEntries(
        (existingMonitor.sources || []).map((source) => [source.retailer, source])
      )
      return {
        target: byRetailer.target
          ? {
              retailer: 'target',
              enabled: true,
              productUrl: byRetailer.target.product_url || '',
              msrp: byRetailer.target.msrp ?? '',
              priceCeiling: byRetailer.target.price_ceiling ?? '',
              buyLimit: byRetailer.target.buy_limit || RETAILER_BUY_LIMITS.target,
              accountIds: byRetailer.target.account_ids || [],
              verificationStatus: byRetailer.target.verification_status || 'unverified'
            }
          : defaultSource('target'),
        walmart: byRetailer.walmart
          ? {
              retailer: 'walmart',
              enabled: true,
              productUrl: byRetailer.walmart.product_url || '',
              msrp: byRetailer.walmart.msrp ?? '',
              priceCeiling: byRetailer.walmart.price_ceiling ?? '',
              buyLimit: byRetailer.walmart.buy_limit || RETAILER_BUY_LIMITS.walmart,
              accountIds: byRetailer.walmart.account_ids || [],
              verificationStatus: byRetailer.walmart.verification_status || 'unverified'
            }
          : defaultSource('walmart')
      }
    }

    const match = walmartMatches[product.productKey]
    const selectedRetailer = product.retailer || 'target'
    const catalogMsrp = product.catalogMsrp ?? product.msrp ?? product.currentPrice ?? ''
    return {
      target: {
        retailer: 'target',
        enabled: selectedRetailer === 'target',
        productUrl: selectedRetailer === 'target' ? product.productUrl : '',
        msrp: selectedRetailer === 'target' ? catalogMsrp : '',
        priceCeiling: '',
        buyLimit: RETAILER_BUY_LIMITS.target,
        accountIds: [],
        verificationStatus: selectedRetailer === 'target' ? 'catalog-matched' : 'unverified'
      },
      walmart: {
        retailer: 'walmart',
        enabled: selectedRetailer === 'walmart',
        productUrl: selectedRetailer === 'walmart' ? product.productUrl : match?.walmart_url || '',
        msrp: selectedRetailer === 'walmart' ? catalogMsrp : '',
        priceCeiling: '',
        buyLimit: RETAILER_BUY_LIMITS.walmart,
        accountIds: [],
        verificationStatus: match
          ? 'manually-verified'
          : selectedRetailer === 'walmart'
            ? 'custom-url'
            : 'unverified'
      }
    }
  }, [product, walmartMatches, existingMonitor])

  const [sources, setSources] = useState(initialSources)

  const updateSource = (retailer, patch) =>
    setSources((current) => ({
      ...current,
      [retailer]: { ...current[retailer], ...patch }
    }))

  const toggleAccount = (retailer, id) => {
    const selected = sources[retailer].accountIds
    updateSource(retailer, {
      accountIds: selected.includes(id)
        ? selected.filter((accountId) => accountId !== id)
        : [...selected, id]
    })
  }

  const submit = async (event) => {
    event.preventDefault()
    const enabled = RETAILERS.map((retailer) => sources[retailer]).filter(
      (source) => source.enabled
    )
    if (enabled.length === 0) return setMessage('Enable at least one retailer.')
    if (enabled.some((source) => !/^https?:\/\//i.test(source.productUrl))) {
      return setMessage('Every enabled retailer needs a valid product URL.')
    }
    if (enabled.some((source) => !(Number(source.priceCeiling) > 0))) {
      return setMessage('Enter a price limit for every enabled retailer.')
    }
    setSaving(true)
    setMessage('Saving monitor...')
    try {
      await saveMonitor({
        id: existingMonitor?.id,
        productKey: product.productKey || null,
        name: product.productName || 'Selected product',
        imageUrl: product.productImageUrl || null,
        category: product.category || null,
        catalogMsrp: product.catalogMsrp || null,
        actionMode: mode,
        sources: enabled.map((source) => ({ ...source, actionMode: mode }))
      })
      setMessage(existingMonitor ? 'Monitor saved.' : 'Monitor created.')
      onSaved?.()
    } catch (error) {
      setMessage(error.message || 'Could not save monitor')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-[#111318] border border-white/10 rounded-2xl p-6 space-y-6 text-sm"
    >
      <div className="flex items-center justify-between">
        <span className="text-gray-500">Configure product monitor</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label={isNewTask ? 'Cancel new task' : 'Close monitor editor'}
          title={isNewTask ? 'Cancel new task' : 'Close editor'}
          className="w-8 h-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 text-2xl leading-none transition-colors"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-4 bg-[#0b0c0e] border border-white/10 rounded-xl p-4">
        {product.productImageUrl && (
          <img
            src={product.productImageUrl}
            alt=""
            className="w-24 h-24 object-contain bg-white rounded-xl"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-red-400 uppercase tracking-widest">Catalog · sealed</div>
          <div className="text-xl text-gray-100 font-semibold mt-1 truncate">
            {product.productName}
          </div>
          <div className="text-gray-500 mt-1">MSRP {formatMoney(product.catalogMsrp)}</div>
        </div>
      </div>

      <div>
        <label className="text-gray-300 font-medium">When PokeBot finds a match</label>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {[
            [TASK_MODES.ALERT_ONLY, 'Notify me', 'Review before buying'],
            [TASK_MODES.AUTO_CHECKOUT, 'Auto-buy', 'Saved card · go']
          ].map(([value, title, subtitle]) => (
            <button
              type="button"
              key={value}
              onClick={() => setMode(value)}
              className={`text-left rounded-xl border p-4 ${mode === value ? 'border-red-500 bg-red-500/10' : 'border-white/10 bg-[#0b0c0e]'}`}
            >
              <div className="text-gray-100 font-medium">{title}</div>
              <div className="text-gray-500 text-xs mt-1">{subtitle}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="border border-white/10 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10 text-xs text-gray-400 uppercase tracking-widest">
          Where PokeBot will look
        </div>
        <div className="divide-y divide-white/10">
          {RETAILERS.map((retailer) => (
            <RetailerSource
              key={retailer}
              retailer={retailer}
              source={sources[retailer]}
              accounts={accounts.filter((account) => account.retailer === retailer)}
              update={(patch) => updateSource(retailer, patch)}
              toggleAccount={(id) => toggleAccount(retailer, id)}
            />
          ))}
        </div>
      </div>

      {message && <div className="text-amber-400 text-xs">{message}</div>}
      <button
        type="submit"
        disabled={saving}
        className="w-full bg-red-600 hover:bg-red-500 disabled:bg-gray-800 rounded-lg px-4 py-3 text-white font-medium"
      >
        {saving ? 'Saving...' : existingMonitor ? 'Save monitor' : 'Create monitor'}
      </button>
    </form>
  )
}

function RetailerSource({ retailer, source, accounts, update, toggleAccount }) {
  const max = RETAILER_BUY_LIMITS[retailer]
  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => update({ enabled: !source.enabled })}
          className={`w-10 h-6 rounded-full p-1 transition-colors ${source.enabled ? 'bg-red-500' : 'bg-gray-700'}`}
        >
          <span
            className={`block w-4 h-4 rounded-full bg-white transition-transform ${source.enabled ? 'translate-x-4' : ''}`}
          />
        </button>
        <div className="text-gray-100 font-semibold capitalize">{retailer}</div>
        <span
          className={`text-[10px] uppercase rounded-full px-2 py-1 ${source.verificationStatus === 'unverified' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}
        >
          {source.verificationStatus.replace('-', ' ')}
        </span>
      </div>
      <input
        value={source.productUrl}
        onChange={(event) =>
          update({ productUrl: event.target.value, verificationStatus: 'custom-url' })
        }
        placeholder={`${retailer} product URL`}
        className="w-full bg-[#0b0c0e] border border-white/10 rounded-lg px-3 py-2 text-gray-200"
      />
      <div className="grid grid-cols-3 gap-3">
        <MoneyField
          label="Retailer MSRP"
          value={source.msrp}
          onChange={(msrp) => update({ msrp })}
        />
        <MoneyField
          label="Price limit (required)"
          value={source.priceCeiling}
          onChange={(priceCeiling) => update({ priceCeiling })}
        />
        <label className="text-gray-500 text-xs">
          Buy up to
          <input
            type="number"
            min="1"
            max={max}
            value={source.buyLimit}
            onChange={(event) => update({ buyLimit: Number(event.target.value) })}
            className="mt-1 w-full bg-[#0b0c0e] border border-white/10 rounded-lg px-3 py-2 text-gray-200"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        {accounts.map((account) => (
          <button
            type="button"
            key={account.id}
            onClick={() => toggleAccount(account.id)}
            className={`rounded-full border px-3 py-1 text-xs ${source.accountIds.includes(account.id) ? 'border-red-500 text-white bg-red-500/10' : 'border-white/10 text-gray-500'}`}
          >
            {account.name}
          </button>
        ))}
        {accounts.length === 0 && (
          <span className="text-gray-600 text-xs">No {retailer} accounts configured.</span>
        )}
      </div>
    </div>
  )
}

function MoneyField({ label, value, onChange }) {
  return (
    <label className="text-gray-500 text-xs">
      {label}
      <div className="relative mt-1">
        <span className="absolute left-3 top-2 text-gray-500">$</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-[#0b0c0e] border border-white/10 rounded-lg pl-6 pr-3 py-2 text-gray-200"
        />
      </div>
    </label>
  )
}

function formatMoney(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? `$${number.toFixed(2)}` : 'not set'
}
