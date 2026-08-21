/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/appStore'

const ODDS_STEPS = { unlikely: 1, possible: 3, likely: 4, 'very likely': 5 }

function Odds({ likelihood }) {
  const filled = ODDS_STEPS[String(likelihood || '').toLowerCase()] || 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[3px]">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`h-2 w-3 rounded-[2px] ${i < filled ? 'bg-gray-300' : 'bg-gray-800'}`}
          />
        ))}
      </div>
      <span className="text-xs text-gray-500">{likelihood || 'unknown'}</span>
    </div>
  )
}

function Countdown({ ticket, now }) {
  if (ticket.yourTurn) {
    return <div className="text-emerald-400 text-sm font-medium">READY TO BUY</div>
  }
  const ms = ticket.expectedTurnMs ? ticket.expectedTurnMs - now : null
  if (ms == null || ms <= 0) {
    return <div className="text-gray-600 text-[11px] tracking-wide">NO COUNTDOWN YET</div>
  }
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return (
    <div className="text-gray-400 text-[11px] tracking-wide">
      ~{mins}m {String(secs).padStart(2, '0')}s
    </div>
  )
}

function Stat({ label, value, tone = 'text-white' }) {
  return (
    <div className="text-center px-4">
      <div className={`text-2xl font-semibold ${tone}`}>{value}</div>
      <div className="text-[10px] tracking-widest text-gray-500 mt-0.5">{label}</div>
    </div>
  )
}

export default function QueueHost() {
  const {
    queueTickets,
    queueStats,
    queueSession,
    setQueueAutoCheckout,
    removeQueueTicket,
    refreshQueueTickets,
    refreshQueueSession,
    scanAndJoinQueues,
    queueScanResult
  } = useAppStore()
  const tickets = useMemo(() => queueTickets || [], [queueTickets])
  const stats = queueStats || {}
  // One clock for the whole page. Kept in state so render stays pure -- the
  // impure Date.now() call happens in the interval, not during render.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const secondsAgo = stats.lastPollAt
    ? Math.max(0, Math.round((now - stats.lastPollAt) / 1000))
    : null
  const pollSecs = stats.pollMs ? Math.round(stats.pollMs / 1000) : null

  return (
    <div className="min-h-full bg-[#0a0a0a] text-gray-200">
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-900 text-sm">
        <div className="flex items-center gap-2 text-gray-500">
          <span className="text-gray-400">Live</span>
          <span>/</span>
          <span className="text-white font-medium">Walmart · queue host</span>
          <span>·</span>
          <span>{stats.tickets || 0} tickets held</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 rounded-full border border-gray-800 px-3 py-1 text-xs text-gray-400">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            Polling tickets
            {secondsAgo != null && <span className="text-gray-600">· {secondsAgo}s ago</span>}
          </span>
          <button
            onClick={() => refreshQueueSession()}
            className="rounded border border-gray-800 px-3 py-1 text-xs text-gray-300 hover:border-gray-600"
            title="Read cookies from your signed-in Walmart browser profile"
          >
            {queueSession?.hasSession ? 'Session loaded' : 'Load Walmart session'}
          </button>
          <button
            onClick={() => scanAndJoinQueues()}
            className="rounded border border-emerald-800 px-3 py-1 text-xs text-emerald-400 hover:border-emerald-600"
            title="Ask Walmart which of your items have a queue open right now, and take a spot in each"
          >
            Scan &amp; join open queues
          </button>
          <button
            onClick={refreshQueueTickets}
            className="rounded border border-gray-800 px-3 py-1 text-xs text-gray-300 hover:border-gray-600"
          >
            Poll now
          </button>
          <span className="rounded bg-red-600/90 px-2 py-1 text-[11px] font-semibold tracking-wide">
            LIVE
          </span>
        </div>
      </div>

      <div className="px-6 pt-6 pb-4 flex items-start justify-between">
        <div>
          <div className="text-[10px] tracking-widest text-gray-500">
            ACTIVE HUNT · SINGLE REQUEST
          </div>
          <h1 className="text-3xl font-semibold text-white mt-1">
            Holding {stats.tickets || 0} ticket{stats.tickets === 1 ? '' : 's'} at Walmart
          </h1>
          <p className="text-sm text-gray-500 mt-2 max-w-xl">
            All tickets refresh in <span className="text-gray-300">one request</span>
            {pollSecs ? ` every ${pollSecs}s` : ''} — Walmart&apos;s own cadence. Holding 14 queues
            costs the same as holding 1.
          </p>
        </div>
        <div className="flex items-center">
          <Stat label="TICKETS" value={stats.tickets || 0} />
          <Stat label="IN QUEUE" value={stats.inQueue || 0} />
          <Stat label="PENDING" value={stats.pending || 0} />
          <Stat
            label="READY"
            value={stats.ready || 0}
            tone={stats.ready ? 'text-emerald-400' : 'text-white'}
          />
          <Stat
            label="ERRORS"
            value={stats.errors || 0}
            tone={stats.errors ? 'text-red-400' : 'text-white'}
          />
        </div>
      </div>

      <div className="px-6 pb-10 space-y-3">
        {queueScanResult && (
          <div className="rounded-lg border border-gray-900 bg-[#0d0d0d] px-4 py-3 text-sm text-gray-400">
            Scanned {queueScanResult.scanned} item(s):{' '}
            <span className="text-emerald-400">{queueScanResult.joined?.length || 0} joined</span>,{' '}
            {queueScanResult.noQueue?.length || 0} with no queue open,{' '}
            <span className={queueScanResult.failed?.length ? 'text-red-400' : ''}>
              {queueScanResult.failed?.length || 0} failed
            </span>
            {queueScanResult.failed?.length > 0 && (
              <div className="mt-1 text-xs text-red-400">{queueScanResult.failed[0].error}</div>
            )}
          </div>
        )}

        {queueSession?.error && (
          <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
            {queueSession.error}. Open the Walmart account session, sign in, then press &ldquo;Load
            Walmart session&rdquo;.
          </div>
        )}

        {tickets.length === 0 && (
          <div className="rounded-lg border border-gray-900 bg-[#0d0d0d] p-10 text-center text-gray-600">
            No tickets held. Queues join automatically when the monitor detects a Walmart drop.
          </div>
        )}

        {tickets.map((t) => (
          <div
            key={t.queueId}
            className="relative flex items-center gap-4 rounded-lg border border-gray-900 bg-[#0d0d0d] px-4 py-4 hover:border-gray-800"
          >
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded bg-gray-900">
              {t.imageUrl ? (
                <img src={t.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-white">
                {t.itemName || t.itemId || t.queueId}
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                <span>SKU {t.sku || t.itemId || '—'}</span>
                <span>·</span>
                <span>
                  ticket <span className="text-gray-300">{t.ticket ?? '—'}</span>
                </span>
                {t.price && (
                  <>
                    <span>·</span>
                    <span>{t.price}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex w-64 shrink-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-full bg-gray-900 px-2.5 py-1 text-[11px] text-gray-300">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      t.yourTurn ? 'bg-emerald-400' : 'bg-sky-400'
                    }`}
                  />
                  {t.yourTurn ? 'Your turn' : t.state === 'pending' ? 'In queue' : 'Joining'}
                </span>
                <span
                  className={`rounded border px-2 py-1 text-[11px] ${
                    t.autoCheckout
                      ? 'border-emerald-700 text-emerald-400'
                      : 'border-gray-800 text-gray-500'
                  }`}
                >
                  {t.autoCheckout ? 'Auto checkout when through' : 'Manual checkout when through'}
                </span>
              </div>
              <Odds likelihood={t.admissionLikelihood} />
              {t.error && <div className="text-[11px] text-red-400">{t.error}</div>}
            </div>

            <div className="w-40 shrink-0 text-right">
              <div className="text-lg font-semibold text-white">
                {t.yourTurn ? 'Ready' : 'In line'}
              </div>
              <Countdown ticket={t} now={now} />
              {!t.autoCheckout && (
                <button
                  onClick={() => setQueueAutoCheckout(t.queueId, true)}
                  className="mt-2 rounded border border-gray-800 px-3 py-1 text-[11px] text-gray-300 hover:border-emerald-700 hover:text-emerald-400"
                >
                  Enable auto buy
                </button>
              )}
            </div>

            <button
              onClick={() => removeQueueTicket(t.queueId)}
              title="Give up this spot"
              className="absolute right-3 top-3 h-5 w-5 rounded-full text-gray-600 hover:bg-gray-900 hover:text-gray-300"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
