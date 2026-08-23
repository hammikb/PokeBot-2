import { AlertTriangle, ScrollText, Server, ShieldAlert } from 'lucide-react'
import { loadDashboardState } from '../../lib/dashboard-state.js'
import { DashboardHeader } from '../DashboardHeader.jsx'
import { LogFilters } from '../LogFilters.jsx'
import { MetricCard } from '../MetricCard.jsx'

export const dynamic = 'force-dynamic'

export default async function LogsPage() {
  const state = await loadDashboardState()
  const errors = state.logs.filter((row) => String(row.level).toLowerCase() === 'error').length
  const warnings = state.logs.filter((row) => String(row.level).toLowerCase().includes('warn')).length
  const services = new Set(state.logs.map((row) => row.service)).size

  return (
    <main className="shell">
      <DashboardHeader eyebrow="Diagnostics" title="Logs" description="The latest service output from your monitors, watchdog, and Discord bot." lastUpdated={state.logs?.[0]?.created_at} />
      <section className="stats compact-stats logs-stats">
        <MetricCard icon={ScrollText} label="Loaded messages" value={state.logs.length} detail="Newest entries first" />
        <MetricCard icon={Server} label="Services" value={services} detail="Reporting in this window" />
        <MetricCard icon={AlertTriangle} label="Warnings" value={warnings} detail="Needs review" />
        <MetricCard icon={ShieldAlert} label="Errors" value={errors} detail={errors ? 'Needs attention' : 'No errors reported'} tone={errors ? 'danger' : ''} />
      </section>
      <LogFilters logs={state.logs} />
    </main>
  )
}
