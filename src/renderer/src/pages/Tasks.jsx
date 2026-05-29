import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILERS } from '../../../shared/constants'

export default function Tasks() {
  const { tasks, taskStatuses, accounts, startTask, stopTask, deleteTask, createTask } = useAppStore()
  const [showBuilder, setShowBuilder] = useState(false)
  const [form, setForm] = useState({
    retailer: 'walmart', productUrl: '', productName: '', maxPrice: '', accountIds: [], intervalMs: 4000
  })

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const toggleAccount = (id) => setF('accountIds', form.accountIds.includes(id)
    ? form.accountIds.filter(x => x !== id)
    : [...form.accountIds, id])

  const submit = async (e) => {
    e.preventDefault()
    await createTask({ ...form, maxPrice: form.maxPrice ? parseFloat(form.maxPrice) : null })
    setShowBuilder(false)
    setForm({ retailer: 'walmart', productUrl: '', productName: '', maxPrice: '', accountIds: [], intervalMs: 4000 })
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-gray-400">Tasks ({tasks.length})</h2>
        <button onClick={() => setShowBuilder(s => !s)}
          className="text-xs bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded uppercase tracking-wider font-bold">
          {showBuilder ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {showBuilder && (
        <form onSubmit={submit} className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Retailer</label>
              <select value={form.retailer} onChange={e => setF('retailer', e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200">
                {Object.values(RETAILERS).map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Max Price ($)</label>
              <input type="number" value={form.maxPrice} onChange={e => setF('maxPrice', e.target.value)}
                placeholder="No limit"
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
            </div>
          </div>
          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1">Product URL</label>
            <input required value={form.productUrl} onChange={e => setF('productUrl', e.target.value)}
              className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
          </div>
          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1">Product Name (optional)</label>
            <input value={form.productName} onChange={e => setF('productName', e.target.value)}
              className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
          </div>
          <div>
            <label className="text-gray-500 uppercase tracking-wider block mb-1">Accounts</label>
            <div className="flex flex-wrap gap-2">
              {accounts.map(acc => (
                <button type="button" key={acc.id} onClick={() => toggleAccount(acc.id)}
                  className={`px-2 py-1 rounded border text-xs transition-colors ${form.accountIds.includes(acc.id)
                    ? 'border-red-500 text-red-400 bg-red-900/20' : 'border-gray-700 text-gray-500 hover:border-gray-500'}`}>
                  {acc.name}
                </button>
              ))}
              {accounts.length === 0 && <span className="text-gray-600">No accounts — add one first</span>}
            </div>
          </div>
          <button type="submit"
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold">
            Create Task
          </button>
        </form>
      )}

      <div className="space-y-2">
        {tasks.map(t => {
          const status = taskStatuses[t.id] || t.status || 'idle'
          const accountCount = (() => { try { return JSON.parse(t.account_ids || '[]').length } catch { return 0 } })()
          return (
            <div key={t.id} className="bg-[#111] border border-gray-800 rounded px-4 py-3 flex items-center gap-4 text-xs">
              <span className={`w-2 h-2 rounded-full shrink-0 ${status === 'monitoring' ? 'bg-green-400' : status === 'error' ? 'bg-red-400' : 'bg-gray-600'}`} />
              <div className="flex-1 min-w-0">
                <div className="text-gray-200">{t.retailer} — {t.product_name || 'Product'}</div>
                <div className="text-gray-600 truncate">{t.product_url}</div>
              </div>
              <span className="text-gray-500 shrink-0">{accountCount} accts</span>
              <span className="text-gray-500 shrink-0">${t.max_price ?? '∞'}</span>
              <div className="flex gap-2">
                {status === 'idle' || status === 'error'
                  ? <button onClick={() => startTask(t.id)} className="text-green-500 hover:text-green-300">▶</button>
                  : <button onClick={() => stopTask(t.id)} className="text-yellow-500 hover:text-yellow-300">⏸</button>}
                <button onClick={() => deleteTask(t.id)} className="text-red-600 hover:text-red-400">✕</button>
              </div>
            </div>
          )
        })}
        {tasks.length === 0 && <div className="text-gray-600 text-xs">No tasks yet. Create one above.</div>}
      </div>
    </div>
  )
}
