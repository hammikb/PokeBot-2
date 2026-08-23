'use client'

import { RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { filterLogs } from '../lib/logs.js'
import { formatWhen } from '../lib/formatters.js'
import { ConsoleLog } from './ConsoleLog.jsx'

export function LogFilters({ logs }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [service, setService] = useState('')
  const [level, setLevel] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const services = useMemo(() => [...new Set(logs.map((row) => row.service).filter(Boolean))].sort(), [logs])
  const levels = useMemo(() => [...new Set(logs.map((row) => String(row.level || '').toLowerCase()).filter(Boolean))].sort(), [logs])
  const visibleLogs = useMemo(() => filterLogs(logs, { query, service, level }), [logs, query, service, level])

  function refresh() {
    setRefreshing(true)
    router.refresh()
    window.setTimeout(() => setRefreshing(false), 700)
  }

  useEffect(() => {
    if (!autoRefresh) return undefined
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [autoRefresh])

  const warningCount = visibleLogs.filter((row) => String(row.level).toLowerCase().includes('warn')).length
  const errorCount = visibleLogs.filter((row) => String(row.level).toLowerCase() === 'error').length

  return (
    <>
      <section className="panel log-toolbar-panel">
        <div className="log-toolbar-heading">
          <div>
            <h2>Monitor stream</h2>
            <p className="section-note">Search the latest operational events from the Pi and connected services.</p>
          </div>
          <button className="button ghost" type="button" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="log-filters">
          <label className="log-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages, workers, services" aria-label="Search logs" /></label>
          <select value={service} onChange={(event) => setService(event.target.value)} aria-label="Filter logs by service">
            <option value="">All services</option>
            {services.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
          <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Filter logs by level">
            <option value="">All levels</option>
            {levels.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
          <label className="log-auto-refresh"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> Auto-refresh</label>
        </div>
        <div className="log-toolbar-summary">
          <span>{visibleLogs.length} of {logs.length} messages</span>
          <span className={warningCount ? 'warn' : ''}>{warningCount} warnings</span>
          <span className={errorCount ? 'bad' : ''}>{errorCount} errors</span>
          <span>Latest {formatWhen(logs[0]?.created_at)}</span>
        </div>
      </section>
      <ConsoleLog logs={visibleLogs} />
    </>
  )
}
