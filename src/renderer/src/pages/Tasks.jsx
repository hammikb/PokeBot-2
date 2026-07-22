import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import MonitorBuilder from '../components/MonitorBuilder'
import { RETAILERS, RETAILER_BUY_LIMITS, TASK_MODES } from '../../../shared/constants'

const CHECKOUT_TEST_RETAILERS = new Set([
  RETAILERS.WALMART,
  RETAILERS.TARGET,
  RETAILERS.POKEMON_CENTER,
  RETAILERS.SAMS_CLUB
])
const SUPPORTED_TASK_RETAILERS = [
  RETAILERS.TARGET,
  RETAILERS.WALMART,
  RETAILERS.POKEMON_CENTER,
  RETAILERS.SAMS_CLUB
]
const DEFAULT_RETAILER = RETAILERS.TARGET
const SHOW_LEGACY_BUILDER = false

const MODE_OPTIONS = [
  {
    value: TASK_MODES.AUTO_CHECKOUT,
    icon: '🚀',
    title: 'Auto-checkout',
    subtitle: 'Buy the moment it restocks'
  },
  {
    value: TASK_MODES.ALERT_ONLY,
    icon: '🔔',
    title: 'Alert only',
    subtitle: 'Notify me, no purchase'
  }
]

const INPUT_CLASS =
  'w-full bg-[#0b0c0e] border border-white/10 rounded-lg px-3 py-2.5 text-gray-100 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 transition-colors'
const LABEL_CLASS = 'text-gray-400 text-sm font-medium block mb-1.5'

const makeDefaultForm = () => ({
  retailer: DEFAULT_RETAILER,
  productUrl: '',
  productName: '',
  productImageUrl: '',
  productKey: '',
  category: '',
  catalogMsrp: '',
  buyLimit: RETAILER_BUY_LIMITS[DEFAULT_RETAILER],
  ordersPerDrop: 1,
  maxPrice: '',
  accountIds: [],
  intervalMs: 4000,
  mode: TASK_MODES.AUTO_CHECKOUT
})

export default function Tasks() {
  const {
    tasks,
    monitors,
    taskStatuses,
    taskReadiness,
    accounts,
    startTask,
    testTask,
    stopTask,
    deleteTask,
    createTask,
    updateTask,
    addCatalogUrl,
    supabaseCatalog,
    loadSupabaseCatalog,
    saveTaskTestResult
  } = useAppStore()
  const [showBuilder, setShowBuilder] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState(null)
  const [editingMonitor, setEditingMonitor] = useState(null)
  const [creatingTaskId, setCreatingTaskId] = useState(null)
  const [form, setForm] = useState(makeDefaultForm)
  const [taskActionMessage, setTaskActionMessage] = useState('')
  const [handledEditTaskId, setHandledEditTaskId] = useState(null)
  const [handledChooseProduct, setHandledChooseProduct] = useState(null)
  const [catalogFilter, setCatalogFilter] = useState('')
  const [productUrl, setProductUrl] = useState('')
  const [productEntryMessage, setProductEntryMessage] = useState('')
  const [productBusy, setProductBusy] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const supportsTestCheckout = CHECKOUT_TEST_RETAILERS.has(form.retailer)
  const matchingAccounts = accounts.filter((account) => account.retailer === form.retailer)
  const buyLimitMax = RETAILER_BUY_LIMITS[form.retailer] || 1

  useEffect(() => {
    loadSupabaseCatalog().catch(() => {})
  }, [loadSupabaseCatalog])

  const filteredCentralCatalog = supabaseCatalog
    .filter((item) =>
      (item.name || item.product_key || '').toLowerCase().includes(catalogFilter.toLowerCase())
    )
    .slice(0, 12)

  const chooseProduct = (item) => {
    setForm((f) => ({
      ...f,
      retailer: item.retailer || 'target',
      productUrl: item.product_url,
      productName: item.name || item.title || '',
      productImageUrl: item.image || item.image_url || '',
      productKey: item.product_key || item.retailer_item_id || '',
      category: item.category || '',
      catalogMsrp: item.regular_price ?? item.msrp ?? '',
      accountIds: f.accountIds.filter((accountId) =>
        accounts.some(
          (account) => account.id === accountId && account.retailer === (item.retailer || 'target')
        )
      ),
      buyLimit: RETAILER_BUY_LIMITS[item.retailer || 'target'] || 1,
      ordersPerDrop: 1,
      maxPrice: f.maxPrice || ''
    }))
    setShowBuilder(true)
    setProductEntryMessage('Product selected. Choose accounts and create the monitor below.')
  }

  const addLinkedProduct = async (event) => {
    event.preventDefault()
    const url = productUrl.trim()
    if (!url) return
    setProductBusy(true)
    setProductEntryMessage('Reading product link...')
    try {
      if (/^https?:\/\/(?:www\.)?pokemoncenter\.com(?:\/|$)/i.test(url)) {
        chooseProduct({
          retailer: RETAILERS.POKEMON_CENTER,
          product_url: url,
          name: 'Pokemon Center Queue'
        })
        setProductUrl('')
        setProductEntryMessage(
          'Pokemon Center queue monitor selected. Choose a Pokemon Center profile below.'
        )
        return
      }
      if (/^https?:\/\/(?:www\.)?samsclub\.com\/ip\//i.test(url)) {
        chooseProduct({
          retailer: RETAILERS.SAMS_CLUB,
          product_url: url,
          name: "Sam's Club product"
        })
        setProductUrl('')
        setProductEntryMessage("Sam's Club link loaded. Select a Plus account and use Test first.")
        return
      }
      const item = await addCatalogUrl(url)
      chooseProduct({ ...item, product_url: item.product_url || url })
      setProductUrl('')
    } catch (err) {
      setProductEntryMessage(err.message || 'Could not add that product link')
    } finally {
      setProductBusy(false)
    }
  }

  const setRetailer = (retailer) =>
    setForm((f) => ({
      ...f,
      retailer,
      accountIds: f.accountIds.filter((accountId) =>
        accounts.some((account) => account.id === accountId && account.retailer === retailer)
      ),
      buyLimit: RETAILER_BUY_LIMITS[retailer],
      ordersPerDrop: 1,
      mode: CHECKOUT_TEST_RETAILERS.has(retailer) ? f.mode : 'monitor-and-buy'
    }))

  const stepBuyLimit = (delta) =>
    setF('buyLimit', Math.min(buyLimitMax, Math.max(1, Number(form.buyLimit || 1) + delta)))

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
    setEditingMonitor(null)
    setCreatingTaskId(null)
    setForm(makeDefaultForm())
  }

  const cancelBuilder = async () => {
    // Catalog creates a draft row before opening this editor. Cancelling that
    // flow should remove the draft instead of leaving an unconfigured task.
    if (creatingTaskId) {
      try {
        await deleteTask(creatingTaskId)
      } catch (error) {
        setTaskActionMessage(error.message || 'Could not cancel the new task')
        return
      }
    }
    resetBuilder()
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!/^https?:\/\//i.test(form.productUrl.trim())) {
      setTaskActionMessage(
        'Choose a product from the search or paste a link above before creating the task.'
      )
      return
    }
    if (form.accountIds.length === 0) {
      setTaskActionMessage(
        `Choose at least one ${form.retailer} account. Use Accounts > open browser first if it needs a saved login session.`
      )
      return
    }

    const payload = {
      ...form,
      buyLimit: parseInt(form.buyLimit, 10),
      ordersPerDrop: form.retailer === 'target' ? Number(form.ordersPerDrop) || 1 : 1,
      mode: supportsTestCheckout ? form.mode : 'monitor-and-buy',
      maxPrice: form.maxPrice ? parseFloat(form.maxPrice) : null
    }

    if (editingTaskId) await updateTask(editingTaskId, payload)
    else await createTask(payload)
    resetBuilder()
  }

  const editTask = (task, { isNew = false } = {}) => {
    let accountIds = []
    try {
      accountIds = JSON.parse(task.account_ids || '[]')
    } catch {
      accountIds = []
    }

    // Tasks are one row per retailer; the monitor that owns this task carries the
    // richer product fields (name/image/category/productKey) plus every enabled
    // retailer's saved price limit, buy limit, and accounts. Without finding it,
    // MonitorBuilder has no id to save against and silently creates a new monitor
    // (and a new task) instead of updating this one.
    const monitor =
      monitors.find((m) => (m.sources || []).some((s) => s.task_id === task.id)) || null

    setForm({
      retailer: task.retailer || DEFAULT_RETAILER,
      productUrl: task.product_url || '',
      productName: monitor?.name || task.product_name || '',
      productImageUrl: monitor?.image_url || task.product_image_url || '',
      productKey: monitor?.product_key || '',
      category: monitor?.category || '',
      catalogMsrp: monitor?.catalog_msrp ?? '',
      buyLimit: task.buy_limit || RETAILER_BUY_LIMITS[task.retailer] || 1,
      ordersPerDrop: task.retailer === 'target' ? task.orders_per_drop || 1 : 1,
      maxPrice: task.max_price == null ? '' : task.max_price.toString(),
      accountIds,
      intervalMs: task.interval_ms || 4000,
      mode: task.mode || 'monitor-and-buy'
    })
    setEditingTaskId(task.id)
    setEditingMonitor(monitor)
    setCreatingTaskId(isNew ? task.id : null)
    setShowBuilder(true)
  }

  // Arriving from Catalog's "create task" — jump straight into editing the
  // task that was just created so accounts can be hooked up immediately.
  // Adjust state during render (React's documented pattern for reacting to a
  // changed prop) instead of an Effect, since editTask() itself sets state.
  const pendingEditTaskId = location.state?.editTaskId ?? null
  if (pendingEditTaskId && pendingEditTaskId !== handledEditTaskId) {
    setHandledEditTaskId(pendingEditTaskId)
    const task = tasks.find((t) => t.id === pendingEditTaskId)
    if (task) editTask(task, { isNew: Boolean(location.state?.newTask) })
  }

  // Arriving from Catalog with a product to create a task from. This opens the
  // builder in create mode via the same chooseProduct() path as the inline central-
  // catalog search below — no task/monitor exists yet until the user actually submits,
  // unlike the old flow that pre-created a bare task row Catalog-side.
  const pendingChooseProduct = location.state?.chooseProduct ?? null
  if (pendingChooseProduct && pendingChooseProduct !== handledChooseProduct) {
    setHandledChooseProduct(pendingChooseProduct)
    chooseProduct(pendingChooseProduct)
  }

  // Clearing router state is a real side effect (history mutation), so it
  // stays in an Effect — but it never touches this component's own state.
  useEffect(() => {
    if (location.state?.editTaskId || location.state?.chooseProduct) {
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location.state, location.pathname, navigate])

  const runCheckoutTest = async (task) => {
    if (!CHECKOUT_TEST_RETAILERS.has(task.retailer)) {
      setTaskActionMessage(
        `${task.retailer} checkout automation is reset. This task can monitor only for now.`
      )
      return
    }
    const accountCount = getTaskAccountCount(task)
    if (accountCount === 0) {
      setTaskActionMessage('Edit this task and select at least one account before running a test.')
      return
    }
    setTaskActionMessage(`Running checkout test for ${task.product_name || 'task'}...`)
    try {
      const result = await testTask(task.id)
      await saveTaskTestResult(task.id, result)
      if (result.success) {
        setTaskActionMessage(
          'Checkout test reached the stop point. Browser stays open at Place order.'
        )
      } else {
        const error = result.results?.find((entry) => entry.error)?.error || 'Checkout test failed'
        setTaskActionMessage(error)
      }
    } catch (err) {
      setTaskActionMessage(err.message || 'Checkout test failed')
    }
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <section className="max-w-5xl mx-auto pt-3 pb-2">
        <div className="text-center mb-5">
          <p className="text-red-400 text-xs uppercase tracking-[0.25em] mb-2">New monitor</p>
          <h1 className="text-2xl text-gray-100 font-semibold">What do you want to watch?</h1>
          <p className="text-gray-500 text-sm mt-2">
            Search the central catalog or paste a Target, Walmart, or Pokemon Center link.
          </p>
        </div>

        <div className="bg-[#111318] border border-white/10 rounded-2xl p-3 shadow-xl">
          <div className="flex items-center gap-3 px-3 py-2 border border-white/10 rounded-xl bg-[#0b0c0e]">
            <span className="text-gray-500 text-xl">⌕</span>
            <input
              value={catalogFilter}
              onChange={(event) => setCatalogFilter(event.target.value)}
              placeholder="Search sealed product, set, or expansion..."
              className="flex-1 bg-transparent text-gray-100 placeholder:text-gray-600 focus:outline-none"
            />
            <kbd className="hidden sm:inline-flex text-xs text-gray-500 border border-white/10 rounded px-2 py-1">
              Ctrl K
            </kbd>
          </div>

          {catalogFilter && (
            <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
              {filteredCentralCatalog.map((item) => (
                <button
                  type="button"
                  key={item.id || item.product_key}
                  onClick={() => chooseProduct(item)}
                  className="w-full flex items-center gap-3 text-left px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
                >
                  {item.image ? (
                    <img
                      src={item.image}
                      alt=""
                      className="w-9 h-9 object-contain bg-white rounded"
                    />
                  ) : (
                    <span className="w-9 h-9 rounded bg-white/10" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-gray-200">
                    {item.name || item.product_key}
                  </span>
                  <span className="text-xs text-gray-600 uppercase">Target</span>
                </button>
              ))}
              {filteredCentralCatalog.length === 0 && (
                <div className="px-3 py-3 text-sm text-gray-600">No central catalog matches.</div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 my-3 text-xs text-gray-600 uppercase tracking-widest">
            <span className="h-px bg-white/10 flex-1" />
            or
            <span className="h-px bg-white/10 flex-1" />
          </div>

          <form
            onSubmit={addLinkedProduct}
            className="flex items-center gap-3 px-3 py-2 border border-white/10 rounded-xl bg-[#0b0c0e]"
          >
            <span className="text-gray-500 text-lg">▱</span>
            <input
              value={productUrl}
              onChange={(event) => setProductUrl(event.target.value)}
              placeholder="Paste a Target, Walmart, or Pokemon Center link"
              className="flex-1 bg-transparent text-gray-100 placeholder:text-gray-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!productUrl.trim() || productBusy}
              className="text-red-400 hover:text-red-300 disabled:text-gray-700 text-xs uppercase tracking-wider"
            >
              {productBusy ? 'Reading...' : 'Use link'}
            </button>
          </form>
          <div className="px-3 pt-2 text-xs text-gray-600">
            {productEntryMessage || 'Instant restock monitor — watches that exact product.'}
          </div>
        </div>
      </section>

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-gray-100 text-lg font-semibold">Tasks</h2>
          <p className="text-gray-500 text-sm mt-1">
            Build tasks from Catalog items. Target is monitor-only while checkout is rebuilt;
            Walmart can still run checkout tests.
          </p>
        </div>
      </div>

      {taskActionMessage && (
        <div className="bg-[#111318] border border-white/10 rounded-xl px-4 py-3 text-sm text-gray-400">
          {taskActionMessage}
        </div>
      )}

      {showBuilder && SHOW_LEGACY_BUILDER && (
        <form
          onSubmit={submit}
          className="bg-[#111318] border border-white/10 rounded-2xl p-6 space-y-6 text-sm"
        >
          <div className="flex items-center justify-between">
            {editingTaskId ? (
              <div className="inline-flex items-center gap-1.5 text-amber-400 text-xs font-medium bg-amber-400/10 border border-amber-400/20 rounded-full px-2.5 py-1">
                Editing task
              </div>
            ) : (
              <span className="text-gray-500 text-sm">Configure monitor</span>
            )}
            <button
              type="button"
              onClick={resetBuilder}
              aria-label="Cancel task"
              title="Cancel"
              className="w-7 h-7 rounded-md text-gray-500 hover:text-gray-100 hover:bg-white/10 text-lg leading-none transition-colors"
            >
              ×
            </button>
          </div>

          {/* duplicate selected-product summary removed; source is the entry panel above */}
          {/*
                    {form.retailer} · {form.productUrl}
          */}
          {(form.productUrl || form.productImageUrl) && (
            <div className="flex gap-4 bg-[#0b0c0e] border border-white/10 rounded-xl p-4">
              {form.productImageUrl ? (
                <img
                  src={form.productImageUrl}
                  alt={form.productName || 'Product'}
                  className="w-24 h-24 object-contain bg-white rounded-lg shrink-0"
                />
              ) : (
                <div className="w-24 h-24 bg-white/10 rounded-lg shrink-0" />
              )}
              <div className="min-w-0 flex-1 self-center">
                <div className="text-gray-100 font-medium truncate">
                  {form.productName || 'Selected product'}
                </div>
                <div className="text-gray-500 text-xs mt-1 capitalize">{form.retailer}</div>
                <div className="text-gray-600 text-xs mt-1 truncate">{form.productUrl}</div>
              </div>
            </div>
          )}
          <div>
            <label className={LABEL_CLASS}>Retailer</label>
            <div className="grid grid-cols-2 gap-2">
              {SUPPORTED_TASK_RETAILERS.map((retailer) => (
                <button
                  type="button"
                  key={retailer}
                  onClick={() => setRetailer(retailer)}
                  className={`rounded-lg border px-3 py-2.5 text-sm font-medium capitalize transition-colors ${
                    form.retailer === retailer
                      ? 'border-red-500/60 bg-red-500/10 text-gray-100'
                      : 'border-white/10 bg-[#0b0c0e] text-gray-400 hover:border-white/20'
                  }`}
                >
                  {retailer}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-gray-400 text-sm font-medium">Buy up to</label>
                <span className="text-gray-600 text-xs">Max {buyLimitMax}</span>
              </div>
              <div className="flex items-center justify-between bg-[#0b0c0e] border border-white/10 rounded-lg px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => stepBuyLimit(-1)}
                  className="w-8 h-8 rounded-md text-gray-400 hover:bg-white/5 hover:text-gray-100 transition-colors"
                >
                  −
                </button>
                <span className="text-gray-100 font-semibold">{form.buyLimit}</span>
                <button
                  type="button"
                  onClick={() => stepBuyLimit(1)}
                  className="w-8 h-8 rounded-md text-gray-400 hover:bg-white/5 hover:text-gray-100 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Price limit</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  type="number"
                  value={form.maxPrice}
                  onChange={(e) => setF('maxPrice', e.target.value)}
                  placeholder="No limit"
                  className={INPUT_CLASS + ' pl-6'}
                />
              </div>
            </div>
          </div>
          {form.retailer === 'target' && (
            <div>
              <label className={LABEL_CLASS}>Separate orders per drop</label>
              <div className="grid grid-cols-2 gap-2">
                {[1, 2].map((count) => (
                  <button
                    type="button"
                    key={count}
                    onClick={() => setF('ordersPerDrop', count)}
                    className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                      Number(form.ordersPerDrop) === count
                        ? 'border-red-500/60 bg-red-500/10 text-gray-100'
                        : 'border-white/10 bg-[#0b0c0e] text-gray-400'
                    }`}
                  >
                    {count} {count === 1 ? 'order' : 'orders'}
                  </button>
                ))}
              </div>
              <p className="text-gray-600 text-xs mt-1.5">
                Each Target order is capped at {form.buyLimit} and the second starts only after the
                first is confirmed.
              </p>
            </div>
          )}

          <div>
            <label className={LABEL_CLASS}>When it finds a match</label>
            <div className="grid grid-cols-2 gap-2">
              {MODE_OPTIONS.map((option) => {
                const selected = form.mode === option.value
                return (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => setF('mode', option.value)}
                    className={`relative text-left rounded-lg border px-3 py-3 transition-colors ${
                      selected
                        ? 'border-red-500/60 bg-red-500/10'
                        : 'border-white/10 bg-[#0b0c0e] hover:border-white/20'
                    }`}
                  >
                    {selected && (
                      <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center">
                        ✓
                      </span>
                    )}
                    <div className="text-lg leading-none mb-1.5">{option.icon}</div>
                    <div className="text-gray-100 font-medium text-sm">{option.title}</div>
                    <div className="text-gray-500 text-xs mt-0.5">{option.subtitle}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS}>Product name (optional)</label>
            <input
              value={form.productName}
              onChange={(e) => setF('productName', e.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label className={LABEL_CLASS}>Accounts</label>
            <div className="flex flex-wrap gap-2">
              {matchingAccounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  onClick={() => toggleAccount(account.id)}
                  className={`px-3 py-1.5 rounded-full border text-sm transition-colors ${
                    form.accountIds.includes(account.id)
                      ? 'border-red-500/60 text-gray-100 bg-red-500/10'
                      : 'border-white/10 text-gray-500 hover:border-white/20'
                  }`}
                >
                  {account.name}
                </button>
              ))}
              {matchingAccounts.length === 0 && (
                <span className="text-gray-500 text-sm">
                  No {form.retailer} accounts. Add one in Accounts, then open its browser and log in
                  once.
                </span>
              )}
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-2.5 font-medium transition-colors"
          >
            {editingTaskId ? 'Save task' : 'Create task'}
          </button>
        </form>
      )}

      {showBuilder && (
        <MonitorBuilder
          key={editingMonitor?.id || `${form.productKey}:${form.productUrl}`}
          product={form}
          existingMonitor={editingMonitor}
          onCancel={cancelBuilder}
          onSaved={resetBuilder}
          isNewTask={Boolean(creatingTaskId)}
        />
      )}

      <div className="space-y-2.5">
        {tasks.map((task) => {
          const status = taskStatuses[task.id] || task.status || 'idle'
          const accountCount = getTaskAccountCount(task)
          return (
            <div
              key={task.id}
              className="bg-[#111318] border border-white/10 rounded-xl px-4 py-4 text-sm space-y-3"
            >
              <div className="flex items-center gap-4">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${status === 'monitoring' ? 'bg-emerald-400' : status === 'error' ? 'bg-red-400' : 'bg-gray-600'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-gray-100 capitalize">
                    {task.retailer} · {task.product_name || 'Product'}
                  </div>
                  <div className="text-gray-600 truncate">{task.product_url}</div>
                </div>
                {task.product_image_url && (
                  <img
                    src={task.product_image_url}
                    alt={task.product_name || 'Product'}
                    className="w-10 h-10 object-contain bg-white rounded-lg shrink-0"
                  />
                )}
                <span className="text-gray-500 text-xs shrink-0 border border-white/10 rounded-full px-2 py-0.5">
                  {accountCount} accts
                </span>
                {task.mode === 'test-checkout' && (
                  <span className="text-amber-400 text-xs shrink-0 border border-amber-400/20 bg-amber-400/10 rounded-full px-2 py-0.5">
                    test
                  </span>
                )}
                <span className="text-gray-500 text-xs shrink-0 border border-white/10 rounded-full px-2 py-0.5">
                  limit {task.buy_limit || 1}
                </span>
                {task.retailer === 'target' && (task.orders_per_drop || 1) > 1 && (
                  <span className="text-red-300 text-xs shrink-0 border border-red-400/20 bg-red-400/10 rounded-full px-2 py-0.5">
                    {task.orders_per_drop} orders
                  </span>
                )}
                <span className="text-gray-500 text-xs shrink-0 border border-white/10 rounded-full px-2 py-0.5">
                  ${task.max_price ?? 'inf'}
                </span>
                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={() => editTask(task)}
                    className="text-gray-400 hover:text-gray-100 transition-colors"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => runCheckoutTest(task)}
                    disabled={accountCount === 0 || !CHECKOUT_TEST_RETAILERS.has(task.retailer)}
                    title={
                      accountCount === 0
                        ? 'Edit task and select an account first'
                        : CHECKOUT_TEST_RETAILERS.has(task.retailer)
                          ? 'Run safe checkout test'
                          : 'Checkout automation is reset for this retailer'
                    }
                    className="text-amber-400 hover:text-amber-300 disabled:text-gray-700 transition-colors"
                  >
                    test
                  </button>
                  {status === 'idle' || status === 'error' ? (
                    <button
                      onClick={() => startTask(task.id)}
                      disabled={accountCount === 0 && task.retailer !== RETAILERS.POKEMON_CENTER}
                      title={
                        accountCount === 0 && task.retailer !== RETAILERS.POKEMON_CENTER
                          ? 'Edit task and select an account first'
                          : task.retailer === RETAILERS.POKEMON_CENTER && accountCount === 0
                            ? 'Start queue monitoring with a persistent guest browser'
                            : 'Start monitoring'
                      }
                      className="text-emerald-400 hover:text-emerald-300 disabled:text-gray-700 transition-colors"
                    >
                      start
                    </button>
                  ) : (
                    <button
                      onClick={() => stopTask(task.id)}
                      className="text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      stop
                    </button>
                  )}
                  <button
                    onClick={() => deleteTask(task.id)}
                    className="text-gray-500 hover:text-red-400 transition-colors"
                  >
                    delete
                  </button>
                </div>
              </div>
              {renderReadinessBar(taskReadiness[task.id])}
            </div>
          )
        })}
        {tasks.length === 0 && (
          <div className="text-gray-500 text-sm">No tasks yet. Create one above.</div>
        )}
      </div>
    </div>
  )
}

function renderReadinessBar(readiness) {
  const checks = readiness?.checks || []
  if (checks.length === 0) {
    return <div className="text-gray-600 text-xs">Readiness check loading...</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {checks.map((check) => (
        <span
          key={check.label}
          title={check.message}
          className={`border rounded-full px-2.5 py-1 text-xs ${
            check.ok ? 'border-emerald-900 text-emerald-400' : 'border-amber-900 text-amber-400'
          }`}
        >
          {check.ok ? 'OK' : 'Todo'} · {check.label}
        </span>
      ))}
    </div>
  )
}

function getTaskAccountCount(task) {
  try {
    return JSON.parse(task.account_ids || '[]').length
  } catch {
    return 0
  }
}
