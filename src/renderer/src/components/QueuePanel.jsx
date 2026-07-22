import { useAppStore } from '../store/appStore'

const PHASE = {
  joining: { label: 'Joining', color: 'text-blue-400', dot: 'bg-blue-400' },
  watching: { label: 'Watching', color: 'text-blue-400', dot: 'bg-blue-400 animate-pulse' },
  'in-queue': { label: 'In queue', color: 'text-yellow-400', dot: 'bg-yellow-400' },
  'no-queue': { label: 'No queue', color: 'text-gray-400', dot: 'bg-gray-500' },
  'external-open': { label: 'Opened', color: 'text-green-400', dot: 'bg-green-400' },
  turn: { label: 'YOUR TURN', color: 'text-green-400', dot: 'bg-green-400' },
  timeout: { label: 'Timed out', color: 'text-gray-400', dot: 'bg-gray-500' },
  error: { label: 'Error', color: 'text-red-400', dot: 'bg-red-400' }
}

function eta(sec) {
  if (sec == null) return null
  const m = Math.round(sec / 60)
  return m >= 1 ? `~${m}m` : '<1m'
}

export default function QueuePanel() {
  const { queueJobs, stopQueue } = useAppStore()
  const jobs = Object.values(queueJobs)
  if (jobs.length === 0) return null

  return (
    <div className="bg-[#111] border border-gray-800 rounded p-4">
      <div className="text-sm text-gray-500 uppercase tracking-widest mb-3 flex items-center gap-2">
        <span>🎟️</span>
        <span>Retail queues ({jobs.length})</span>
        <span className="text-gray-700 normal-case tracking-normal">
          · persistent browser sessions
        </span>
      </div>
      <div className="space-y-3">
        {jobs.map((j) => {
          const ph = PHASE[j.phase] || PHASE.joining
          const pct = j.phase === 'turn' ? 100 : j.phase === 'in-queue' ? (j.percent ?? 2) : 0
          const odds = j.admissionLikelihood
          return (
            <div key={j.id} className="bg-[#1a1a1a] rounded p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2 h-2 rounded-full ${ph.dot}`} />
                <span className={`text-sm font-semibold uppercase tracking-wider ${ph.color}`}>
                  {ph.label}
                </span>
                {j.ticket != null && (
                  <span className="text-gray-500 text-sm">ticket {j.ticket}</span>
                )}
                {j.retailer && <span className="text-gray-500 text-sm">{j.retailer}</span>}
                {odds && (
                  <span
                    className={`text-sm ${odds === 'unlikely' ? 'text-red-400' : 'text-gray-400'}`}
                  >
                    odds: {odds}
                  </span>
                )}
                <button
                  onClick={() => stopQueue(j.id)}
                  className="ml-auto text-gray-600 hover:text-red-400 px-1"
                  title="Leave queue"
                >
                  ✕
                </button>
              </div>

              <div className="text-gray-200 text-sm truncate mb-2">{j.itemName || j.label}</div>

              {/* progress bar */}
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    j.phase === 'turn' ? 'bg-green-400' : 'bg-yellow-400'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex justify-between items-baseline mt-1 text-sm">
                <span className="text-gray-500">{j.message || ''}</span>
                <span className="text-gray-300">
                  {eta(j.etaSec) ? `${eta(j.etaSec)} wait` : ''} {pct ? `· ${pct}%` : ''}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
