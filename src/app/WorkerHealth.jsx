import { formatNumber, formatUptime, formatWhen } from '../lib/formatters.js'
import { freshnessState } from '../lib/dashboard.js'

const SAFE_DISCORD_STATUSES = new Set(['confirmed', 'disabled', 'pending', 'retrying'])

function evidenceNumber(value) {
  return value == null ? '—' : String(Math.max(0, Math.trunc(Number(value))))
}

function evidenceWhen(value) {
  return value ? formatWhen(value) : '—'
}

function discordStatus(value) {
  const status = String(value || '').toLowerCase()
  return SAFE_DISCORD_STATUSES.has(status) ? status : '—'
}

function discordMessageId(value) {
  const messageId = String(value || '')
  return /^\d{1,30}$/.test(messageId) ? messageId : '—'
}

function scheduleProfile(value) {
  const profile = String(value || '')
  return /^[a-z0-9:._-]{1,64}$/i.test(profile) ? profile : '—'
}

export function WorkerHealth({ health }) {
  return (
    <section className="panel panel-roomy">
      <div className="panel-heading"><div><h2>Worker health</h2><p className="section-note">Live Raspberry Pi telemetry.</p></div><span className="count">{health.length}</span></div>
      <div className="health-grid worker-grid">
        {health.length ? health.map((row) => (
          <article className="health-card" key={row.id || row.worker_name}>
            <div className="title">
              <strong>{row.worker_name}</strong>
              <span className={`badge ${freshnessState(row.updated_at) === 'fresh' ? 'good' : freshnessState(row.updated_at) === 'stale' ? 'warn' : 'bad'}`}>
                {freshnessState(row.updated_at) === 'fresh' ? 'Online' : freshnessState(row.updated_at) === 'stale' ? 'Stale' : 'Offline'}
              </span>
            </div>
            <div className="meta worker-updated">Updated {formatWhen(row.updated_at)}</div>
            <div className="health-metrics">
              <span>CPU <b>{formatNumber(row.cpu_percent, '%')}</b></span>
              <span>Temp <b>{formatNumber(row.temp_c, 'C')}</b></span>
              <span>Memory <b>{formatNumber(row.mem_percent, '%')}</b></span>
              <span>Disk <b>{formatNumber(row.disk_percent, '%')}</b></span>
              <span>Load <b>{formatNumber(row.load_1m)}</b></span>
              <span>Uptime <b>{formatUptime(row.uptime_seconds)}</b></span>
            </div>
            <div className="health-metrics">
              <span>Watchlist <b>{evidenceNumber(row.watchlist_product_count)}</b></span>
              <span>Watchlist sync <b>{evidenceWhen(row.watchlist_last_success_at)}</b></span>
              <span>Pending alerts <b>{evidenceNumber(row.alert_outbox_pending)}</b></span>
              <span>Cloud delivery <b>{evidenceWhen(row.last_drop_delivery_at)}</b></span>
              <span>Discord delivery <b>{evidenceWhen(row.last_discord_delivery_at)}</b></span>
              <span>Discord status <b>{discordStatus(row.last_discord_status)}</b></span>
              <span>Discord message <b>{discordMessageId(row.last_discord_message_id)}</b></span>
              <span>Schedule <b>{scheduleProfile(row.active_schedule_profile)}</b></span>
              <span>Next schedule change <b>{evidenceWhen(row.schedule_next_transition_at)}</b></span>
            </div>
            <div className="meta">{row.hostname || 'unknown host'} · {row.platform || 'unknown platform'}</div>
          </article>
        )) : <div className="empty">No Pi health rows yet.</div>}
      </div>
    </section>
  )
}
