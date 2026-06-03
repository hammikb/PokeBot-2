import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'

const TYPE_COLOR = {
  in_stock: 'text-green-400',
  queue_open: 'text-yellow-400',
  price_drop: 'text-blue-400',
  captcha: 'text-red-400',
  checkout_step: 'text-orange-400'
}

const STATUS_ICON = { monitoring: '▶', idle: '⏸', running: '⚡', error: '✕' }
const STATUS_COLOR = {
  monitoring: 'text-green-400',
  idle: 'text-gray-500',
  running: 'text-yellow-400',
  error: 'text-red-400'
}

export default function Dashboard() {
  const { feedEvents, tasks, taskStatuses, accounts, startTask, stopTask } = useAppStore()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  const last24h = feedEvents.filter((e) => now - e.timestamp < 86400000)
  const wins = last24h.filter((e) => e.productName?.includes('ORDER CONFIRMED'))
  const captchas = last24h.filter((e) => e.dropType === 'captcha')
  const alerts = feedEvents.filter((e) => e.productName?.includes('🔔 ALERT:'))

  return (
    <div className="flex flex-col h-full p-3 gap-3 overflow-hidden">
      {/* Top: Live Feed + Active Tasks */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Live Feed */}
        <div className="w-80 bg-[#111] border border-gray-800 rounded p-4 flex flex-col min-h-0">
          <div className="text-sm text-gray-500 uppercase tracking-widest mb-2">Live Feed</div>
          <div className="flex-1 overflow-y-auto space-y-2">
            {feedEvents.length === 0 && (
              <div className="text-gray-600 text-sm">Waiting for drops...</div>
            )}
            {feedEvents.map((e) => (
              <div key={e.id} className="text-sm flex gap-2 items-baseline">
                <span className="text-gray-600 shrink-0">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className={`shrink-0 ${TYPE_COLOR[e.dropType] || 'text-gray-300'}`}>
                  {e.retailer}
                </span>
                <span className="text-gray-200 truncate">{e.productName}</span>
                {e.price != null && <span className="text-gray-400 shrink-0">${e.price}</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Active Tasks */}
        <div className="flex-1 bg-[#111] border border-gray-800 rounded p-4 flex flex-col min-h-0">
          <div className="text-sm text-gray-500 uppercase tracking-widest mb-2">Active Tasks</div>
          <div className="flex-1 overflow-y-auto space-y-2">
            {tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-700 text-sm gap-1 pt-8">
                <span className="text-2xl">⏸</span>
                <span>No tasks — go to Tasks to create one</span>
              </div>
            )}
            {tasks.map((t) => {
              const status = taskStatuses[t.id] || t.status || 'idle'
              const accountCount = (() => {
                try {
                  return JSON.parse(t.account_ids || '[]').length
                } catch {
                  return 0
                }
              })()
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-3 bg-[#1a1a1a] px-3 py-2 rounded text-sm"
                >
                  <span className={STATUS_COLOR[status]}>{STATUS_ICON[status] || '○'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-200 truncate">
                      {t.retailer} — {t.product_name || t.product_url}
                    </div>
                  </div>
                  <span className="text-gray-500 shrink-0">{accountCount} accs</span>
                  {status === 'idle' || status === 'error' ? (
                    <button
                      onClick={() => startTask(t.id)}
                      className="text-green-500 hover:text-green-300 px-1"
                    >
                      ▶
                    </button>
                  ) : (
                    <button
                      onClick={() => stopTask(t.id)}
                      className="text-yellow-500 hover:text-yellow-300 px-1"
                    >
                      ⏸
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Account Status */}
      <div className="bg-[#111] border border-gray-800 rounded p-4">
        <div className="text-sm text-gray-500 uppercase tracking-widest mb-2">Account Status</div>
        <div className="flex flex-wrap gap-2">
          {accounts.map((acc) => (
            <div
              key={acc.id}
              className="flex items-center gap-2 bg-[#1a1a1a] px-3 py-2 rounded text-sm"
            >
              <span className="text-gray-200">{acc.name}</span>
              <span className="text-gray-500">{acc.retailer}</span>
              {acc.proxy && <span className="text-gray-600">proxy: {acc.proxy.split(':')[0]}</span>}
              <span className="text-green-400">READY</span>
            </div>
          ))}
          {accounts.length === 0 && (
            <span className="text-gray-600 text-sm">No accounts configured</span>
          )}
        </div>
      </div>

      {/* Recent Alerts */}
      {alerts.length > 0 && (
        <div className="bg-[#111] border border-yellow-800 rounded p-4">
          <div className="text-sm text-yellow-400 uppercase tracking-widest mb-2 flex items-center gap-2">
            <span>🔔</span>
            <span>Recent Alerts ({alerts.length})</span>
          </div>
          <div className="space-y-2 max-h-32 overflow-y-auto">
            {alerts.slice(0, 10).map((e) => (
              <div key={e.id} className="text-sm flex gap-2 items-baseline bg-yellow-900/10 px-3 py-2 rounded">
                <span className="text-gray-600 shrink-0">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-yellow-400 shrink-0">{e.retailer}</span>
                <span className="text-gray-200 truncate">{e.productName}</span>
                {e.price != null && <span className="text-gray-400 shrink-0">${e.price}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Drop History */}
      <div className="bg-[#111] border border-gray-800 rounded px-4 py-3 flex gap-6 text-sm text-gray-400">
        <span>
          last 24h: <span className="text-white">{last24h.length}</span> drops
        </span>
        <span className="text-green-400">{wins.length} wins</span>
        <span className="text-yellow-400">{captchas.length} captchas</span>
        <span className="text-yellow-400">{alerts.length} alerts</span>
      </div>
    </div>
  )
}
