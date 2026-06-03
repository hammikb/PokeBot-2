import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILERS, RETAILER_BUY_LIMITS } from '../../../shared/constants'

const CHECKOUT_TEST_RETAILERS = new Set([RETAILERS.WALMART])
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
    taskReadiness,
    accounts,
    startTask,
    testTask,
    stopTask,
    deleteTask,
    createTask,
    updateTask,
    catalogItems,
    saveTaskTestResult
  } = useAppStore()
  const [showBuilder, setShowBuilder] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState(null)
  const [form, setForm] = useState(makeDefaultForm)
  const [selectedCatalogId, setSelectedCatalogId] = useState('')
  const [builderMessage, setBuilderMessage] = useState('')
  const [taskActionMessage, setTaskActionMessage] = useState('')

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const supportsTestCheckout = CHECKOUT_TEST_RETAILERS.has(form.retailer)
  const matchingAccounts = accounts.filter((account) => account.retailer === form.retailer)

  const selectCatalogItem = (id) => {
    setSelectedCatalogId(id)
    const item = catalogItems.find((catalogItem) => catalogItem.id === id)
    if (!item) return

    setForm((f) => ({
      ...f,
      retailer: item.retailer,
      productUrl: item.product_url,
      productName: item.title,
      productImageUrl: item.image_url || '',
      accountIds: f.accountIds.filter((accountId) =>
        accounts.some((account) => account.id === accountId && account.retailer === item.retailer)
      ),
      buyLimit: RETAILER_BUY_LIMITS[item.retailer] || f.buyLimit,
      maxPrice:
        f.maxPrice ||
        (item.msrp != null
          ? item.msrp.toString()
          : item.current_price != null
            ? item.current_price.toString()
            : '')
    }))
  }

  const setRetailer = (retailer) =>
    setForm((f) => ({
      ...f,
      retailer,
      accountIds: f.accountIds.filter((accountId) =>
        accounts.some((account) => account.id === accountId && account.retailer === retailer)
      ),
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
    setSelectedCatalogId('')
    setBuilderMessage('')
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!/^https?:\/\//i.test(form.productUrl.trim())) {
      setBuilderMessage('Choose a saved catalog product before creating the task.')
      setSelectedCatalogId('')
      return
    }
    if (form.accountIds.length === 0) {
      setBuilderMessage(
        `Choose at least one ${form.retailer} account. Use Accounts > open browser first if it needs a saved login session.`
      )
      return
    }

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

    const matchingCatalogItem = catalogItems.find((item) => item.product_url === task.product_url)

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
    setSelectedCatalogId(matchingCatalogItem?.id || '')
    setBuilderMessage(
      matchingCatalogItem ? '' : 'This existing task is not linked to a current catalog item.'
    )
    setEditingTaskId(task.id)
    setShowBuilder(true)
  }

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
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-sm uppercase tracking-widest text-gray-400">
            Tasks ({tasks.length})
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            Build tasks from Catalog items. Target is monitor-only while checkout is rebuilt;
            Walmart can still run checkout tests.
          </p>
        </div>
        <button
          onClick={() => (showBuilder ? resetBuilder() : setShowBuilder(true))}
          className="text-sm bg-red-600 hover:bg-red-500 px-4 py-2 rounded uppercase tracking-wider font-bold"
        >
          {showBuilder ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {taskActionMessage && (
        <div className="bg-[#111] border border-gray-800 rounded px-4 py-3 text-sm text-gray-400">
          {taskActionMessage}
        </div>
      )}

      {showBuilder && (
        <form
          onSubmit={submit}
          className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-sm"
        >
          {editingTaskId && (
            <div className="text-yellow-400 uppercase tracking-wider">Editing task</div>
          )}

          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1.5">
              Product Catalog Item
            </label>
            <select
              autoFocus
              value={selectedCatalogId}
              onChange={(e) => selectCatalogItem(e.target.value)}
              className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
            >
              <option value="">Choose a saved product...</option>
              {catalogItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.retailer.toUpperCase()} - {item.title}
                </option>
              ))}
            </select>
            <div className="text-gray-600 mt-1">
              {builderMessage ||
                'Add products from the Catalog tab first, then choose accounts for this retailer.'}
            </div>
          </div>

          {(form.productUrl || form.productImageUrl) && (
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
                <div className="text-gray-500 mt-1">{form.retailer}</div>
                <div className="text-gray-500 mt-1 truncate">{form.productUrl}</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1.5">
                Retailer
              </label>
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
              <label className="text-gray-500 uppercase tracking-wider block mb-1.5">
                Buy Limit
              </label>
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
              <option value="monitor-and-buy">
                {supportsTestCheckout ? 'Monitor and buy' : 'Monitor only'}
              </option>
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
              {matchingAccounts.map((account) => (
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
              {matchingAccounts.length === 0 && (
                <span className="text-gray-600">
                  No {form.retailer} accounts. Add one in Accounts, then open its browser and log in
                  once.
                </span>
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
          const accountCount = getTaskAccountCount(task)
          return (
            <div
              key={task.id}
              className="bg-[#111] border border-gray-800 rounded px-4 py-4 text-sm space-y-3"
            >
              <div className="flex items-center gap-4">
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
                    className="text-orange-400 hover:text-orange-200 disabled:text-gray-700"
                  >
                    test
                  </button>
                  {status === 'idle' || status === 'error' ? (
                    <button
                      onClick={() => startTask(task.id)}
                      disabled={accountCount === 0}
                      title={
                        accountCount === 0
                          ? 'Edit task and select an account first'
                          : 'Start monitoring'
                      }
                      className="text-green-500 hover:text-green-300 disabled:text-gray-700"
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
              {renderReadinessBar(taskReadiness[task.id])}
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

function renderReadinessBar(readiness) {
  const checks = readiness?.checks || []
  if (checks.length === 0) {
    return <div className="text-gray-700 text-xs">Readiness check loading...</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {checks.map((check) => (
        <span
          key={check.label}
          title={check.message}
          className={`border rounded px-2 py-1 text-xs uppercase tracking-wider ${
            check.ok ? 'border-green-900 text-green-400' : 'border-yellow-900 text-yellow-400'
          }`}
        >
          {check.ok ? 'ok' : 'todo'} {check.label}
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
