import Link from 'next/link'
import { ArrowRight, Boxes, Clock3, Cpu, Radio, ShieldCheck, Users } from 'lucide-react'
import { loadDashboardState } from '../lib/dashboard-state.js'
import { freshnessState } from '../lib/dashboard.js'
import { formatPercent, formatWhen } from '../lib/formatters.js'
import { DashboardHeader } from './DashboardHeader.jsx'
import { MetricCard } from './MetricCard.jsx'
import { RecentDrops } from './RecentDrops.jsx'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const state = await loadDashboardState()
  const latestSnapshot = state.snapshots?.[0]
  const workersReporting = state.health?.length || 0
  const workersOnline = state.health?.filter((row) => freshnessState(row.updated_at) === 'fresh').length || 0
  const proxyState = state.proxyStatus?.state || 'unknown'
  const systemHealthy = !state.error && proxyState !== 'out' && workersOnline > 0

  return (
    <main className="shell">
      <DashboardHeader
        eyebrow="Mission control"
        title="Restocks at a glance."
        description="A quick read on restocks, monitoring coverage, and system health."
        lastUpdated={latestSnapshot?.captured_at}
      />

      <section className={`status-banner ${systemHealthy ? 'healthy' : 'warning'}`}>
        <div className="status-banner-icon">{systemHealthy ? <ShieldCheck size={22} /> : <Radio size={22} />}</div>
        <div>
          <strong>{systemHealthy ? 'All monitoring systems are operational' : 'Monitoring needs attention'}</strong>
          <span>{state.error || `${workersOnline}/${workersReporting} workers fresh · ${state.summary.proxyHealthy} proxies healthy · latest cycle ${formatWhen(latestSnapshot?.captured_at)}`}</span>
        </div>
        <Link href="/infrastructure">View system details <ArrowRight size={14} /></Link>
      </section>

      <section className="stats overview-stats">
        <MetricCard icon={Boxes} label="Tracked products" value={state.summary.products} detail="Across Walmart and Target" />
        <MetricCard icon={Users} label="Subscriptions" value={state.summary.activeSubscriptions} detail="Active user watchlists" />
        <MetricCard icon={Clock3} label="Drops in 24h" value={state.summary.drops24h} detail={`${state.drops.length} recent events loaded`} tone="accent" />
        <MetricCard icon={ShieldCheck} label="Healthy proxies" value={state.summary.proxyHealthy} detail={`${state.proxies.length} sessions tracked`} />
        <MetricCard icon={Radio} label="Blocked rate" value={formatPercent(state.summary.blockedRate)} detail={`${state.summary.checks} checks recorded`} />
        <MetricCard icon={Cpu} label="Worker CPU" value={state.summary.cpuPercent == null ? 'n/a' : `${Number(state.summary.cpuPercent).toFixed(1)}%`} detail={`${workersOnline} fresh / ${workersReporting} reporting`} />
      </section>

      <section className="overview-layout">
        <RecentDrops drops={state.drops} />
        <aside className="panel panel-roomy system-summary">
          <div className="panel-heading"><div><h2>System summary</h2><p className="section-note">Live operating signals.</p></div></div>
          <div className="summary-list">
            <div><span><i className={state.error ? 'bad' : 'good'} />Supabase</span><strong>{state.error ? 'Issue' : 'Connected'}</strong></div>
            <div><span><i className={latestSnapshot ? 'good' : 'warn'} />Monitor</span><strong>{latestSnapshot?.status || 'Waiting'}</strong></div>
            <div><span><i className={proxyState === 'out' ? 'bad' : proxyState === 'low' ? 'warn' : 'good'} />Proxy data</span><strong>{state.proxyStatus ? `${Number(state.proxyStatus.remaining_gb).toFixed(2)} GB left` : 'Unknown'}</strong></div>
            <div><span><i className={workersOnline ? 'good' : 'warn'} />Workers</span><strong>{workersOnline}/{workersReporting} fresh</strong></div>
          </div>
          <Link className="button summary-button" href="/infrastructure">Open infrastructure <ArrowRight size={15} /></Link>
        </aside>
      </section>

    </main>
  )
}
