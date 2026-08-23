import { formatWhen } from '../lib/formatters.js'

export function ConsoleLog({ logs }) {
  return (
    <section className="panel panel-roomy logs-panel">
      <div className="panel-heading"><div><h2>Service console</h2><p className="section-note">Latest messages from monitor and bot services.</p></div><span className="count">{logs.length}</span></div>
      <div className="console logs-console">
        {logs.length ? logs.map((row) => (
          <div className="console-line" key={row.id}>
            <span>{formatWhen(row.created_at)}</span>
            <b>{row.service || 'unknown'}</b>
            <span className={`log-level ${String(row.level).toLowerCase()}`}>{row.level}</span>
            <span className="log-worker">{row.worker_name || 'unknown worker'}</span>
            <code>{row.message}</code>
          </div>
        )) : <div className="empty">Waiting for Pi service logs.</div>}
      </div>
    </section>
  )
}
