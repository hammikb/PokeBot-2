import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILERS } from '../../../shared/constants'

export default function Accounts() {
  const { accounts, createAccount, deleteAccount } = useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', retailer: 'walmart', username: '', password: '', cvv: '', proxy: '' })
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e) => {
    e.preventDefault()
    await createAccount(form)
    setShowForm(false)
    setForm({ name: '', retailer: 'walmart', username: '', password: '', cvv: '', proxy: '' })
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-gray-400">Accounts ({accounts.length})</h2>
        <button onClick={() => setShowForm(s => !s)}
          className="text-xs bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded uppercase tracking-wider font-bold">
          {showForm ? 'Cancel' : '+ Add Account'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Account Name</label>
              <input required value={form.name} onChange={e => setF('name', e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
            </div>
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Retailer</label>
              <select value={form.retailer} onChange={e => setF('retailer', e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200">
                {Object.values(RETAILERS).map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Email / Username</label>
              <input required value={form.username} onChange={e => setF('username', e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
            </div>
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Password</label>
              <input required type="password" value={form.password} onChange={e => setF('password', e.target.value)}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">CVV</label>
              <input value={form.cvv} onChange={e => setF('cvv', e.target.value)} maxLength={4}
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
            </div>
            <div>
              <label className="text-gray-500 uppercase tracking-wider block mb-1">Proxy (host:port:user:pass)</label>
              <input value={form.proxy} onChange={e => setF('proxy', e.target.value)} placeholder="Optional"
                className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
            </div>
          </div>
          <button type="submit"
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold text-xs">
            Add Account
          </button>
        </form>
      )}

      <div className="space-y-2">
        {accounts.map(acc => (
          <div key={acc.id} className="bg-[#111] border border-gray-800 rounded px-4 py-3 flex items-center gap-4 text-xs">
            <div className="flex-1 min-w-0">
              <div className="text-gray-200">{acc.name}</div>
              <div className="text-gray-500">{acc.retailer} — {acc.username}</div>
              {acc.proxy && <div className="text-gray-600">proxy: {acc.proxy}</div>}
            </div>
            <button onClick={() => deleteAccount(acc.id)} className="text-red-600 hover:text-red-400 shrink-0">✕</button>
          </div>
        ))}
        {accounts.length === 0 && <div className="text-gray-600 text-xs">No accounts yet. Add one above.</div>}
      </div>
    </div>
  )
}
