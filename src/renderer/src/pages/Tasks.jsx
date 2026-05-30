import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILERS, RETAILER_BUY_LIMITS } from '../../../shared/constants'

const CHECKOUT_TEST_RETAILERS = new Set([RETAILERS.WALMART, RETAILERS.TARGET])
const SUPPORTED_TASK_RETAILERS = [RETAILERS.TARGET, RETAILERS.WALMART]
const DEFAULT_RETAILER = RETAILERS.TARGET

const makeDefaultForm = () => ({
  retailer: DEFAULT_RETAILER,
  productUrl: '',
  productName: '',
  productImageUrl: '',
  buyLimit: RETAILER_BUY_LIMITS[DEFAULT_RETAILER],
  maxPrice: '',
  accountIds: [],
  intervalMs: 4000,
  mode: 'monitor-and-buy'
})

export default function Tasks() {
  const {
    tasks,
    taskStatuses,
    accounts,
    startTask,
    stopTask,
    deleteTask,
    createTask,
    updateTask,
    lookupProduct
  } = useAppStore()
  const [showBuilder, setShowBuilder] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState(null)
  const [productLookup, setProductLookup] = useState({ loading: false, error: '', product: null })
  const [form, setForm] = useState(makeDefaultForm)

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const supportsTestCheckout = CHECKOUT_TEST_RETAILERS.has(form.retailer)

  const retailerFromUrl = (productUrl) => {
    try {
      const hostname = new URL(productUrl).hostname
      if (hostname.includes('target.com')) return RETAILERS.TARGET
      if (hostname.includes('walmart.com')) return RETAILERS.WALMART
    } catch {
      return null
    }
    return null
  }

  const setProductUrl = (productUrl) => {
    const retailer = retailerFromUrl(productUrl)
    setForm((f) => ({
      ...f,
      productUrl,
      retailer: retailer || f.retailer,
      buyLimit: retailer ? RETAILER_BUY_LIMITS[retailer] : f.buyLimit
    }))
  }

  const setRetailer = (retailer) =>
    setForm((f) => ({
      ...f,
      retailer,
      buyLimit: RETAILER_BUY_LIMITS[retailer],
      mode: CHECKOUT_TEST_RETAILERS.has(retailer) ? f.mode : 'monitor-and-buy'
    }))

  const toggleAccount = (id) =>
    setF(
      'accountIds',
      form.accountIds.includes(id)
        ? form.accountIds.filter((accountId) => accountId !== id)
        : [...form.accountIds, id]
    )

  const resetBuilder = () => {
    setShowBuilder(false)
    setEditingTaskId(null)
    setForm(makeDefaultForm())
    setProductLookup({ loading: false, error: '', product: null })
  }

  const applyProduct = (product) => {
    setForm((f) => ({
      ...f,
      retailer: product.retailer || f.retailer,
      productName: product.productName || f.productName,
      productImageUrl: product.imageUrl || f.productImageUrl,
      buyLimit: RETAILER_BUY_LIMITS[product.retailer] || f.buyLimit,
      maxPrice: f.maxPrice || (product.price != null ? product.price.toString() : '')
    }))
    setProductLookup({ loading: false, error: '', product })
  }

  const fetchProduct = async () => {
    const productUrl = form.productUrl.trim()
    if (!productUrl) return

    setProductLookup((state) => ({ ...state, loading: true, error: '' }))
    try {
      const product = await lookupProduct(productUrl)
      applyProduct(product)
    } catch (err) {
      setProductLookup({
        loading: false,
        error: err.message || 'Could not look up product',
        product: null
      })
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    const payload = {
      ...form,
      buyLimit: parseInt(form.buyLimit, 10),
      mode: supportsTestCheckout ? form.mode : 'monitor-and-buy',
      maxPrice: form.maxPrice ? parseFloat(form.maxPrice) : null
    }

    if (editingTaskId) await updateTask(editingTaskId, payload)
    else await createTask(payload)
    resetBuilder()
  }

  const editTask = (task) => {
    let accountIds = []
    try {
      accountIds = JSON.parse(task.account_ids || '[]')
    } catch {
      accountIds = []
    }

    setForm({
      retailer: task.retailer || DEFAULT_RETAILER,
      productUrl: task.product_url || '',
      productName: task.product_name || '',
      productImageUrl: task.product_image_url || '',
      buyLimit: task.buy_limit || RETAILER_BUY_LIMITS[task.retailer] || 1,
      maxPrice: task.max_price == null ? '' : task.max_price.toString(),
      accountIds,
      intervalMs: task.interval_ms || 4000,
      mode: task.mode || 'monitor-and-buy'
    })
    setProductLookup({ loading: false, error: '', product: null })
    setEditingTaskId(task.id)
    setShowBuilder(true)
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex justify-between items-center">
        <h2 className="text-sm uppercase tracking-widest text-gray-400">Tasks ({tasks.length})</h2>
        <button
          onClick={() => (showBuilder ? resetBuilder() : setShowBuilder(true))}
          className="text-sm bg-red-600 hover:bg-red-500 px-4 py-2 rounded uppercase tracking-wider font-bold"
        >
          {showBuilder ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {showBuilder && (
        <form
          onSubmit={submit}
          className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-sm"
        >
          {editingTaskId && (
            <div className="text-yellow-400 uppercase tracking-wider">Editing task</div>
          )}

          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1.5">Product URL</label>
            <input
              required
              autoFocus
              value={form.productUrl}
              onChange={(e) => setProductUrl(e.target.value)}
              onBlur={fetchProduct}
              placeholder="Paste a Target or Walmart product URL"
              className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
            />
            <div className="flex items-center justify-between mt-1 gap-3">
              <span className="text-gray-600">
                {productLookup.loading
                  ? 'Loading product...'
                  : productLookup.error || productLookup.product?.formattedPrice || ''}
              </span>
              <button
                type="button"
                onClick={fetchProduct}
                disabled={productLookup.loading || !form.productUrl.trim()}
                className="text-gray-400 hover:text-gray-200 disabled:text-gray-700 uppercase tracking-wider"
              >
                Fetch
              </button>
            </div>
          </div>

          {(productLookup.product || form.productImageUrl) && (
            <div className="flex gap-3 bg-[#0f0f0f] border border-gray-800 rounded p-3">
              {form.productImageUrl && (
                <img
                  src={form.productImageUrl}
                  alt={form.productName || 'Product'}
                  className="w-20 h-20 object-contain bg-white rounded"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-gray-200 font-bold truncate">
                  {form.productName || 'Product found'}
                </div>
                <div className="text-gray-500 mt-1">
                  {productLookup.product?.brand || form.retailer}
                  {productLookup.product?.category ? ` / ${productLookup.product.category}` : ''}
                </div>
                <div className="text-gray-500 mt-1">
                  {productLookup.product?.availability || 'Product info loaded'}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1.5">Retailer</label>
              <select
                value={form.retailer}
                onChange={(e) => setRetailer(e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
              >
                {SUPPORTED_TASK_RETAILERS.map((retailer) => (
                  <option key={retailer} value={retailer}>
                    {retailer}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1.5">Buy Limit</label>
              <input
                type="number"
                min="1"
                max={RETAILER_BUY_LIMITS[form.retailer]}
                value={form.buyLimit}
                onChange={(e) => setF('buyLimit', e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
              />
              <div className="text-gray-600 mt-1">
                Max for {form.retailer}: {RETAILER_BUY_LIMITS[form.retailer]}
              </div>
            </div>
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1.5">
                Max Price ($)
              </label>
              <input
                type="number"
                value={form.maxPrice}
                onChange={(e) => setF('maxPrice', e.target.value)}
                placeholder="No limit"
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
              />
            </div>
          </div>

          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1.5">Mode</label>
            <select
              value={supportsTestCheckout ? form.mode : 'monitor-and-buy'}
              onChange={(e) => setF('mode', e.target.value)}
              disabled={!supportsTestCheckout}
              className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200 disabled:text-gray-600 disabled:border-gray-800"
            >
              <option value="monitor-and-buy">Auto buy</option>
              <option value="test-checkout">Test checkout</option>
            </select>
          </div>

          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1.5">
              Product Name (optional)
            </label>
            <input
              value={form.productName}
              onChange={(e) => setF('productName', e.target.value)}
              className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
            />
          </div>

          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1.5">Accounts</label>
            <div className="flex flex-wrap gap-2">
              {accounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  onClick={() => toggleAccount(account.id)}
                  className={`px-2 py-1 rounded border text-sm transition-colors ${
                    form.accountIds.includes(account.id)
                      ? 'border-red-500 text-red-400 bg-red-900/20'
                      : 'border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}
                >
                  {account.name}
                </button>
              ))}
              {accounts.length === 0 && (
                <span className="text-gray-600">No accounts - add one first</span>
              )}
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold"
          >
            {editingTaskId ? 'Save Task' : 'Create Task'}
          </button>
        </form>
      )}

      <div className="space-y-3">
        {tasks.map((task) => {
          const status = taskStatuses[task.id] || task.status || 'idle'
          const accountCount = (() => {
            try {
              return JSON.parse(task.account_ids || '[]').length
            } catch {
              return 0
            }
          })()
          return (
            <div
              key={task.id}
              className="bg-[#111] border border-gray-800 rounded px-4 py-4 flex items-center gap-4 text-sm"
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${status === 'monitoring' ? 'bg-green-400' : status === 'error' ? 'bg-red-400' : 'bg-gray-600'}`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-gray-200">
                  {task.retailer} - {task.product_name || 'Product'}
                </div>
                <div className="text-gray-600 truncate">{task.product_url}</div>
              </div>
              {task.product_image_url && (
                <img
                  src={task.product_image_url}
                  alt={task.product_name || 'Product'}
                  className="w-10 h-10 object-contain bg-white rounded shrink-0"
                />
              )}
              <span className="text-gray-500 shrink-0">{accountCount} accts</span>
              {task.mode === 'test-checkout' && (
                <span className="text-yellow-400 shrink-0">test</span>
              )}
              <span className="text-gray-500 shrink-0">limit {task.buy_limit || 1}</span>
              <span className="text-gray-500 shrink-0">${task.max_price ?? 'inf'}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => editTask(task)}
                  className="text-blue-400 hover:text-blue-200"
                >
                  edit
                </button>
                {status === 'idle' || status === 'error' ? (
                  <button
                    onClick={() => startTask(task.id)}
                    className="text-green-500 hover:text-green-300"
                  >
                    start
                  </button>
                ) : (
                  <button
                    onClick={() => stopTask(task.id)}
                    className="text-yellow-500 hover:text-yellow-300"
                  >
                    stop
                  </button>
                )}
                <button
                  onClick={() => deleteTask(task.id)}
                  className="text-red-600 hover:text-red-400"
                >
                  delete
                </button>
              </div>
            </div>
          )
        })}
        {tasks.length === 0 && (
          <div className="text-gray-600 text-sm">No tasks yet. Create one above.</div>
        )}
      </div>
    </div>
  )
}
