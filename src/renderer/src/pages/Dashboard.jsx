import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'
import QueuePanel from '../components/QueuePanel'
import { formatAppTime } from '../utils/time'

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
const MONITOR_STATUS_STYLE = {
  ready: 'border-emerald-900/70 text-emerald-400 bg-emerald-950/20',
  degraded: 'border-amber-900/70 text-amber-400 bg-amber-950/20',
  stale: 'border-red-900/70 text-red-400 bg-red-950/20',
  unavailable: 'border-gray-800 text-gray-500 bg-gray-950/20'
}

function desktopAlertEvidence(notifications) {
  const failed = notifications?.lastFailed
  const shown = notifications?.lastShown
  if (failed && (!shown || failed.at >= shown.at)) {
    return `failed at ${formatAppTime(failed.at)}${failed.reason ? ` — ${failed.reason}` : ''}`
  }
  if (shown) return `shown at ${formatAppTime(shown.at)}`
  return 'no evidence yet'
}

export default function Dashboard() {
  const {
    feedEvents,
    tasks,
    taskStatuses,
    accounts,
    settings,
    saveSetting,
    startTask,
    stopTask,
    queueJobs,
    joinQueue,
    monitorHealth,
    monitorHealthLoading,
    monitorHealthError,
    loadMonitorHealth
  } = useAppStore()
  const [now, setNow] = useState(() => Date.now())
  const [queueToggleBusy, setQueueToggleBusy] = useState(false)
  const [queueToggleError, setQueueToggleError] = useState('')
  const [queueToggleNotice, setQueueToggleNotice] = useState('')

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    loadMonitorHealth()
    const timer = setInterval(loadMonitorHealth, 30000)
    return () => clearInterval(timer)
  }, [loadMonitorHealth])

  const last24h = feedEvents.filter((e) => now - e.timestamp < 86400000)
  const wins = last24h.filter((e) => e.productName?.includes('ORDER CONFIRMED'))
  const captchas = last24h.filter((e) => e.dropType === 'captcha')
  const alerts = feedEvents.filter((e) => e.productName?.includes('🔔 ALERT:'))
  const pokemonCenterAutoJoin = settings.pokemonCenterAutoJoin === true

  const togglePokemonCenterAutoJoin = async () => {
    setQueueToggleBusy(true)
    setQueueToggleError('')
    setQueueToggleNotice('')
    try {
      const next = !pokemonCenterAutoJoin
      const result = await saveSetting('pokemonCenterAutoJoin', next)
      if (next && result?.connected === false) {
        setQueueToggleNotice(
          'Armed locally. Electron will connect automatically when Supabase is available.'
        )
      }
    } catch (error) {
      setQueueToggleError(error.message || 'Could not change Pokemon Center auto-join')
    } finally {
      setQueueToggleBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full p-3 gap-3 overflow-hidden">
      <section
        className={`border rounded px-4 py-3 shrink-0 ${MONITOR_STATUS_STYLE[monitorHealth?.status] || MONITOR_STATUS_STYLE.unavailable}`}
        aria-live="polite"
      >
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-200 font-semibold">Central monitor health</span>
              <span className="text-xs uppercase tracking-wider">
                {monitorHealthLoading && !monitorHealth
                  ? 'checking'
                  : monitorHealth?.status || 'unavailable'}
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-gray-400">
              {monitorHealthError ||
                monitorHealth?.message ||
                (monitorHealthLoading
                  ? 'Checking the Pi and Electron channels...'
                  : 'No monitor health data yet.')}
            </div>
            <div className="mt-1 truncate text-xs text-gray-500">
              Desktop alert: {desktopAlertEvidence(monitorHealth?.notifications)}
            </div>
          </div>
          {monitorHealth?.worker && (
            <div className="flex shrink-0 flex-wrap justify-end gap-x-5 gap-y-1 text-xs">
              <HealthMetric
                label="heartbeat"
                value={formatHeartbeatAge(monitorHealth.worker.capturedAt, now)}
              />
              <HealthMetric
                label="products"
                value={formatCount(monitorHealth.worker.totalProducts)}
              />
              <HealthMetric label="checks" value={formatCount(monitorHealth.worker.checks)} />
              <HealthMetric label="data" value={formatBytes(monitorHealth.worker.bytesUsed)} />
              <HealthMetric label="blocked" value={formatRate(monitorHealth.worker.blockedRate)} />
              <HealthMetric
                label="channels"
                value={`${monitorHealth.realtime.channels.subscribed}/${monitorHealth.realtime.channels.total}`}
              />
            </div>
          )}
        </div>
      </section>

      <div className="bg-[#111] border border-gray-800 rounded p-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-200 font-semibold">Auto-join Pokémon Center queue</div>
          <div className="text-xs text-gray-500 mt-1">
            The Pi detects the waiting room and Electron opens one tab in your trusted default
            browser. No task is required.
          </div>
          {queueToggleError && <div className="text-xs text-red-400 mt-1">{queueToggleError}</div>}
          {queueToggleNotice && (
            <div className="text-xs text-amber-400 mt-1">{queueToggleNotice}</div>
          )}
        </div>
        <span
          className={`text-xs uppercase tracking-wider ${pokemonCenterAutoJoin ? 'text-emerald-400' : 'text-gray-600'}`}
        >
          {pokemonCenterAutoJoin ? 'armed' : 'off'}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={pokemonCenterAutoJoin}
          aria-label="Auto-join Pokémon Center queue"
          disabled={queueToggleBusy}
          onClick={togglePokemonCenterAutoJoin}
          className={`w-12 h-7 rounded-full p-1 transition-colors disabled:opacity-50 ${pokemonCenterAutoJoin ? 'bg-emerald-500' : 'bg-gray-700'}`}
        >
          <span
            className={`block w-5 h-5 rounded-full bg-white transition-transform ${pokemonCenterAutoJoin ? 'translate-x-5' : ''}`}
          />
        </button>
      </div>

      {/* Top: Live Feed + Active Tasks */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Live Feed */}
        <div className="flex-1 bg-[#111] border border-gray-800 rounded p-4 flex flex-col min-h-0">
          <div className="text-sm text-gray-500 uppercase tracking-widest mb-2">Live Feed</div>
          <div className="flex-1 overflow-y-auto space-y-2">
            {feedEvents.length === 0 && (
              <div className="text-gray-600 text-sm">Waiting for drops...</div>
            )}
            {feedEvents.map((e) => (
              <div key={e.id} className="text-sm flex gap-2 items-baseline">
                <span className="text-gray-600 shrink-0">{formatAppTime(e.timestamp)}</span>
                <span className={`shrink-0 ${TYPE_COLOR[e.dropType] || 'text-gray-300'}`}>
                  {e.retailer}
                </span>
                <span className="text-gray-200 break-words min-w-0">{e.productName}</span>
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
                  {t.retailer === 'walmart' &&
                    (queueJobs[t.id] ? (
                      <span className="text-yellow-400 shrink-0 text-xs uppercase tracking-wider">
                        in queue
                      </span>
                    ) : (
                      <button
                        onClick={() =>
                          joinQueue(t.id, t.product_url, t.product_name || t.product_url)
                        }
                        className="text-yellow-500 hover:text-yellow-300 shrink-0 text-xs uppercase tracking-wider"
                        title="Auto-join Walmart waiting room"
                      >
                        🎟️ queue
                      </button>
                    ))}
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

      {/* Walmart Queues */}
      <QueuePanel />

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
              <div
                key={e.id}
                className="text-sm flex gap-2 items-baseline bg-yellow-900/10 px-3 py-2 rounded"
              >
                <span className="text-gray-600 shrink-0">{formatAppTime(e.timestamp)}</span>
                <span className="text-yellow-400 shrink-0">{e.retailer}</span>
                <span className="text-gray-200 break-words min-w-0">{e.productName}</span>
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

// eslint-disable-next-line react/prop-types
function HealthMetric({ label, value }) {
  return (
    <span className="text-gray-500">
      {label}: <span className="text-gray-200">{value}</span>
    </span>
  )
}

function formatHeartbeatAge(capturedAt, now) {
  const ageMs = Math.max(0, now - Date.parse(capturedAt))
  if (!Number.isFinite(ageMs)) return 'unknown'
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`
  return `${Math.round(ageMs / 60_000)}m ago`
}

function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString() : 'n/a'
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'n/a'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function formatRate(value) {
  if (!Number.isFinite(value)) return 'n/a'
  const percent = value <= 1 ? value * 100 : value
  return `${percent.toFixed(1)}%`
}
