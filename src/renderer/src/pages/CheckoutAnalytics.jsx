/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/appStore'

const OUTCOME_STYLES = {
  confirmed: 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300',
  test_ready: 'border-sky-700/60 bg-sky-950/30 text-sky-300',
  manual_required: 'border-amber-700/60 bg-amber-950/30 text-amber-300',
  failed: 'border-red-800/60 bg-red-950/30 text-red-300',
  running: 'border-violet-700/60 bg-violet-950/30 text-violet-300'
}

const RETAILERS = [
  ['all', 'All retailers'],
  ['target', 'Target'],
  ['walmart', 'Walmart'],
  ['samsclub', "Sam's Club"],
  ['pokemon-center', 'Pokemon Center']
]

const OUTCOMES = [
  ['all', 'All outcomes'],
  ['confirmed', 'Confirmed'],
  ['failed', 'Failed'],
  ['manual_required', 'Manual required'],
  ['test_ready', 'Test ready'],
  ['running', 'Running']
]

export default function CheckoutAnalytics() {
  const {
    checkoutAnalytics,
    checkoutAnalyticsLoading,
    checkoutAnalyticsError,
    loadCheckoutAnalytics
  } = useAppStore()
  const [filters, setFilters] = useState({
    retailer: 'all',
    outcome: 'all',
    days: 30,
    limit: 100
  })
  const [expandedAttempt, setExpandedAttempt] = useState(null)

  useEffect(() => {
    loadCheckoutAnalytics(filters).catch(() => {})
  }, [filters, loadCheckoutAnalytics])

  const maxStageReached = useMemo(
    () =>
      Math.max(1, ...(checkoutAnalytics?.stages || []).map((stage) => stage.averageReachedMs || 0)),
    [checkoutAnalytics]
  )

  const updateFilter = (key, value) => {
    setExpandedAttempt(null)
    setFilters((current) => ({ ...current, [key]: value }))
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0f0f0f] p-4">
      <div className="mx-auto max-w-[1800px] space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-800 pb-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-red-400">Checkout telemetry</p>
            <h1 className="mt-1 text-xl font-semibold text-gray-100">Checkout Analytics</h1>
            <p className="mt-1 max-w-2xl text-xs text-gray-500">
              Local history view. Optional sanitized sharing is controlled in Settings; payment
              details, cookies, account identities, and product URLs are never included.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Retailer"
              value={filters.retailer}
              options={RETAILERS}
              onChange={(value) => updateFilter('retailer', value)}
            />
            <FilterSelect
              label="Outcome"
              value={filters.outcome}
              options={OUTCOMES}
              onChange={(value) => updateFilter('outcome', value)}
            />
            <FilterSelect
              label="Range"
              value={String(filters.days ?? 'all')}
              options={[
                ['7', '7 days'],
                ['30', '30 days'],
                ['90', '90 days'],
                ['all', 'All time']
              ]}
              onChange={(value) => updateFilter('days', value === 'all' ? null : Number(value))}
            />
            <button
              type="button"
              onClick={() => loadCheckoutAnalytics(filters).catch(() => {})}
              disabled={checkoutAnalyticsLoading}
              className="h-9 rounded border border-gray-700 bg-[#171717] px-3 text-xs uppercase tracking-wider text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50"
            >
              {checkoutAnalyticsLoading ? 'Loading' : 'Refresh'}
            </button>
          </div>
        </header>

        {checkoutAnalyticsError && (
          <div className="rounded border border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            {checkoutAnalyticsError}
          </div>
        )}

        {!checkoutAnalytics && checkoutAnalyticsLoading ? (
          <div className="flex h-64 items-center justify-center text-sm text-gray-600">
            Loading checkout history...
          </div>
        ) : (
          <>
            <SummaryCards summary={checkoutAnalytics?.summary} />

            <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
              <Panel title="Where checkout time goes" subtitle="Average time from drop detection">
                <StageTimingChart
                  stages={checkoutAnalytics?.stages || []}
                  maxReached={maxStageReached}
                />
              </Panel>
              <Panel title="Outcomes and failures" subtitle="What happened after each attempt">
                <p className="detail-label mb-3">Outcomes</p>
                <Breakdown
                  rows={checkoutAnalytics?.summary?.outcomes || []}
                  empty="No outcomes in this range."
                  tone="blue"
                />
                <div className="my-4 border-t border-gray-800" />
                <p className="detail-label mb-3">Failure reasons</p>
                <Breakdown
                  rows={checkoutAnalytics?.summary?.failures || []}
                  empty="No failures in this range."
                  tone="red"
                />
              </Panel>
            </div>

            <Panel
              title="Experiment comparison"
              subtitle="Use multiple attempts before drawing conclusions"
            >
              <ExperimentGrid experiments={checkoutAnalytics?.experiments || []} />
            </Panel>

            <Panel
              title="Recent attempts"
              subtitle={`${checkoutAnalytics?.attempts?.length || 0} local attempts`}
              flush
            >
              <AttemptList
                attempts={checkoutAnalytics?.attempts || []}
                expandedAttempt={expandedAttempt}
                onToggle={(id) => setExpandedAttempt((current) => (current === id ? null : id))}
              />
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}

function SummaryCards({ summary }) {
  const cards = [
    {
      label: 'Attempts',
      value: summary?.total ?? 0,
      detail: `${summary?.running || 0} currently running`,
      tone: 'text-gray-100'
    },
    {
      label: 'Confirmed',
      value: summary?.confirmed ?? 0,
      detail: `${formatPercent(summary?.successRate)} success rate`,
      tone: 'text-emerald-300'
    },
    {
      label: 'Average checkout',
      value: formatDuration(summary?.averageDurationMs),
      detail: `${summary?.completed || 0} completed attempts`,
      tone: 'text-sky-300'
    },
    {
      label: 'Monitor delivery',
      value: formatDuration(summary?.averageMonitorLatencyMs),
      detail: 'Pi observation to Electron',
      tone: 'text-violet-300'
    },
    {
      label: 'Most common outcome',
      value: labelize(summary?.outcomes?.[0]?.key || 'none'),
      detail: summary?.outcomes?.[0]
        ? `${summary.outcomes[0].count} attempts`
        : 'No checkout data yet',
      tone: 'text-amber-300'
    }
  ]

  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {cards.map((card) => (
        <div key={card.label} className="rounded border border-gray-800 bg-[#131313] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-600">{card.label}</p>
          <p className={`mt-2 truncate text-2xl font-semibold ${card.tone}`}>{card.value}</p>
          <p className="mt-1 text-xs text-gray-500">{card.detail}</p>
        </div>
      ))}
    </section>
  )
}

function StageTimingChart({ stages, maxReached }) {
  if (!stages.length) {
    return <EmptyState message="Stage timing will appear after the first checkout attempt." />
  }
  return (
    <div className="space-y-3">
      {stages.map((stage) => (
        <div key={stage.stage} className="grid grid-cols-[150px_1fr_86px] items-center gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs text-gray-300">{labelize(stage.stage)}</p>
            <p className="text-[10px] text-gray-600">{stage.attemptsReached} reached</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-900">
            <div
              className="h-full rounded-full bg-gradient-to-r from-red-500 to-amber-400"
              style={{
                width: `${Math.max(2, ((stage.averageReachedMs || 0) / maxReached) * 100)}%`
              }}
            />
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-300">{formatDuration(stage.averageReachedMs)}</p>
            {stage.averageDurationMs != null && (
              <p className="text-[10px] text-gray-600">
                +{formatDuration(stage.averageDurationMs)}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Breakdown({ rows, empty, tone = 'gray' }) {
  if (!rows.length) return <EmptyState message={empty} />
  const barColor = tone === 'red' ? 'bg-red-500' : 'bg-sky-500'
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.key}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-gray-300">{labelize(row.key)}</span>
            <span className="text-gray-500">
              {row.count} · {formatPercent(row.percent)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-900">
            <div
              className={`h-full rounded-full ${barColor}`}
              style={{ width: `${Math.max(2, row.percent)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function ExperimentGrid({ experiments }) {
  if (!experiments.length) {
    return <EmptyState message="Experiment flags will appear with checkout attempts." />
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {experiments.map((experiment) => (
        <div key={experiment.key} className="rounded border border-gray-800 bg-[#101010] p-3">
          <p className="mb-3 text-[11px] uppercase tracking-[0.16em] text-gray-500">
            {labelize(experiment.key)}
          </p>
          <div className="space-y-2">
            {experiment.values.slice(0, 4).map((value) => (
              <div
                key={value.value}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-xs"
              >
                <span className="truncate text-gray-300" title={value.value}>
                  {labelize(value.value)}
                </span>
                <span className="text-gray-600">{value.attempts} tries</span>
                <span className={value.confirmed > 0 ? 'text-emerald-400' : 'text-gray-500'}>
                  {formatPercent(value.successRate)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function AttemptList({ attempts, expandedAttempt, onToggle }) {
  if (!attempts.length) {
    return <EmptyState message="No checkout attempts match these filters." padded />
  }
  return (
    <div className="divide-y divide-gray-800">
      {attempts.map((attempt) => {
        const expanded = expandedAttempt === attempt.id
        return (
          <article key={attempt.id}>
            <button
              type="button"
              onClick={() => onToggle(attempt.id)}
              aria-expanded={expanded}
              className="grid w-full grid-cols-[minmax(220px,1fr)_120px_115px_100px_28px] items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.025]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-200">{attempt.productName}</p>
                <p className="mt-0.5 text-[11px] text-gray-600">
                  {formatTimestamp(attempt.startedAt)} · {labelize(attempt.retailer)}
                </p>
              </div>
              <span
                className={`w-fit rounded border px-2 py-1 text-[10px] uppercase tracking-wider ${
                  OUTCOME_STYLES[attempt.outcome] || OUTCOME_STYLES.running
                }`}
              >
                {labelize(attempt.outcome)}
              </span>
              <span className="text-xs text-gray-500">{labelize(attempt.finalStage)}</span>
              <span className="text-right text-xs text-gray-400">
                {formatDuration(attempt.durationMs)}
              </span>
              <span className="text-right text-gray-600">{expanded ? '−' : '+'}</span>
            </button>
            {expanded && <AttemptDetails attempt={attempt} />}
          </article>
        )
      })}
    </div>
  )
}

function AttemptDetails({ attempt }) {
  const experimentEntries = Object.entries(attempt.experiment || {})
  return (
    <div className="border-t border-gray-800/70 bg-[#0d0d0d] px-4 py-4">
      <div className="grid gap-5 xl:grid-cols-[240px_1fr]">
        <aside className="space-y-4">
          <div>
            <p className="detail-label">Failure</p>
            <p
              className={
                attempt.failureCode ? 'mt-1 text-xs text-red-300' : 'mt-1 text-xs text-gray-600'
              }
            >
              {attempt.failureCode
                ? `${labelize(attempt.failureCode)} at ${labelize(attempt.failureStage)}`
                : 'No classified failure'}
            </p>
            {attempt.errorSummary && (
              <p className="mt-2 break-words text-xs leading-relaxed text-gray-400">
                {attempt.errorSummary}
              </p>
            )}
          </div>
          <div>
            <p className="detail-label">Experiment</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {experimentEntries.map(([key, value]) => (
                <span
                  key={key}
                  className="rounded border border-gray-800 bg-[#151515] px-2 py-1 text-[10px] text-gray-400"
                >
                  {labelize(key)}: {labelize(String(value))}
                </span>
              ))}
              {!experimentEntries.length && <span className="text-xs text-gray-600">Unknown</span>}
            </div>
          </div>
          <div>
            <p className="detail-label">Local artifacts</p>
            <div className="mt-2 space-y-1.5">
              {attempt.artifacts.map((artifact) => (
                <div key={`${artifact.type}:${artifact.path}`} className="text-[10px]">
                  <span className="text-sky-400">{labelize(artifact.type)}</span>
                  <span className="ml-2 break-all text-gray-600">{artifact.path}</span>
                </div>
              ))}
              {!attempt.artifacts.length && (
                <span className="text-xs text-gray-600">No artifact recorded</span>
              )}
            </div>
          </div>
        </aside>
        <div>
          <p className="detail-label mb-3">Event timeline</p>
          <div className="space-y-0">
            {attempt.events.map((event, index) => (
              <div
                key={`${event.sequence}:${index}`}
                className="grid grid-cols-[82px_14px_150px_1fr] gap-2 text-xs"
              >
                <span className="py-2 text-right text-gray-600">
                  {formatDuration(event.elapsedMs)}
                </span>
                <div className="relative flex justify-center">
                  {index < attempt.events.length - 1 && (
                    <span className="absolute bottom-0 top-3 w-px bg-gray-800" />
                  )}
                  <span className="relative mt-2.5 h-2 w-2 rounded-full bg-red-500" />
                </div>
                <span className="py-2 text-gray-300">{labelize(event.stage)}</span>
                <span className="break-words py-2 text-gray-500">
                  {event.detail || 'Milestone recorded'}
                </span>
              </div>
            ))}
            {!attempt.events.length && <EmptyState message="No events were recorded." />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Panel({ title, subtitle, children, flush = false }) {
  return (
    <section className="overflow-hidden rounded border border-gray-800 bg-[#131313]">
      <div className="border-b border-gray-800 px-4 py-3">
        <h2 className="text-sm font-medium text-gray-200">{title}</h2>
        <p className="mt-0.5 text-[11px] text-gray-600">{subtitle}</p>
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  )
}

function FilterSelect({ label, value, options, onChange }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded border border-gray-700 bg-[#171717] px-3 text-xs text-gray-300 outline-none hover:border-gray-500 focus:border-red-500"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

function EmptyState({ message, padded = false }) {
  return (
    <div className={`text-xs text-gray-600 ${padded ? 'p-8 text-center' : 'py-5'}`}>{message}</div>
  )
}

function formatDuration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const milliseconds = Math.max(0, Number(value))
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000)
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0)}%`
}

function formatTimestamp(value) {
  if (!value) return 'Unknown time'
  return new Date(value).toLocaleString()
}

function labelize(value) {
  return String(value || 'unknown')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}
