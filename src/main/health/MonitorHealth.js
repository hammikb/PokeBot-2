const DEFAULT_STALE_AFTER_MS = 150 * 1000
const DEFAULT_QUERY_TIMEOUT_MS = 8 * 1000
const HEALTHY_WORKER_STATES = new Set(['ok', 'healthy', 'ready', 'running'])
const SNAPSHOT_COLUMNS =
  'status,checks,bytes_used,total_products,active_contexts,blocked_rate,captured_at'

export class MonitorHealth {
  constructor({
    authSessionManager,
    taskManager,
    notificationEngine,
    now = () => Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS
  }) {
    this._auth = authSessionManager
    this._tasks = taskManager
    this._notifications = notificationEngine
    this._now = now
    this._staleAfterMs = staleAfterMs
    this._queryTimeoutMs = queryTimeoutMs
    this._lastWorkerSnapshot = null
  }

  async getSnapshot() {
    const checkedAtMs = this._now()
    const realtime = normalizeRealtime(this._tasks?.getMonitorHealthSnapshot?.())
    let notifications
    try {
      notifications = normalizeNotificationHealth(this._notifications?.getHealthSnapshot?.())
    } catch {
      notifications = normalizeNotificationHealth()
    }
    const base = {
      checkedAt: new Date(checkedAtMs).toISOString(),
      staleAfterMs: this._staleAfterMs,
      realtime,
      notifications
    }

    let authStatus
    try {
      authStatus = this._auth?.getStatus?.()
    } catch {
      return this._unavailable(base, 'Central monitor sign-in status is unavailable.')
    }
    if (!authStatus?.authenticated) {
      return this._unavailable(base, 'Sign in to view central monitor health.', 'signed_out')
    }

    try {
      const client = this._auth?.getClient?.()
      if (!client?.from) {
        return this._unavailable(base, 'Central monitor connection is unavailable.')
      }

      const query = client
        .from('monitor_snapshots')
        .select(SNAPSHOT_COLUMNS)
        .order('captured_at', { ascending: false })
        .limit(1)
      const { data, error } = await withTimeout(
        Promise.resolve(query),
        this._queryTimeoutMs,
        'Central monitor health request timed out.'
      )
      if (error) throw new Error('Central monitor telemetry could not be read.')

      const worker = normalizeWorkerSnapshot(data?.[0], checkedAtMs)
      if (!worker) {
        return this._unavailable(base, 'No central monitor heartbeat has been received yet.')
      }
      this._lastWorkerSnapshot = worker
      return classifyHealth({ ...base, worker, telemetryReachable: true })
    } catch {
      const worker = refreshWorkerAge(this._lastWorkerSnapshot, checkedAtMs)
      if (!worker) {
        return this._unavailable(base, 'Could not reach central monitor telemetry.')
      }
      return classifyHealth({
        ...base,
        worker,
        telemetryReachable: false,
        telemetryMessage: 'The last heartbeat is shown because the latest health check failed.'
      })
    }
  }

  _unavailable(base, message, reason = 'unreachable') {
    return {
      ...base,
      status: 'unavailable',
      reason,
      message,
      telemetryReachable: false,
      worker: null
    }
  }
}

function classifyHealth(snapshot) {
  const { worker, realtime, telemetryReachable } = snapshot
  const workerStateHealthy = HEALTHY_WORKER_STATES.has(worker.status.toLowerCase())
  const stale = worker.ageMs > snapshot.staleAfterMs
  const channelProblem =
    ['timeout', 'disconnected'].includes(realtime.heartbeat.status) ||
    realtime.channels.interrupted > 0 ||
    realtime.channels.catchUpErrors > 0 ||
    (realtime.activeTaskCount > 0 &&
      realtime.channels.subscribed === 0 &&
      realtime.sourceState !== 'connecting')
  const channelConnecting =
    realtime.sourceState === 'connecting' ||
    realtime.channels.connecting > 0 ||
    realtime.channels.catchingUp > 0

  if (stale) {
    return {
      ...snapshot,
      status: 'stale',
      reason: 'heartbeat_stale',
      message: `The central monitor heartbeat is ${formatAge(worker.ageMs)} old.`
    }
  }
  if (!telemetryReachable) {
    return {
      ...snapshot,
      status: 'degraded',
      reason: 'telemetry_unreachable',
      message: snapshot.telemetryMessage
    }
  }
  if (!workerStateHealthy) {
    return {
      ...snapshot,
      status: 'degraded',
      reason: 'worker_reported_issue',
      message: `The central monitor reported ${worker.status}.`
    }
  }
  if (channelProblem) {
    return {
      ...snapshot,
      status: 'degraded',
      reason: 'realtime_interrupted',
      message: 'The Pi is healthy, but one or more Electron monitor channels need attention.'
    }
  }
  if (channelConnecting) {
    return {
      ...snapshot,
      status: 'degraded',
      reason: 'realtime_connecting',
      message: 'The Pi is healthy while Electron finishes connecting monitor channels.'
    }
  }
  return {
    ...snapshot,
    status: 'ready',
    reason: 'healthy',
    message:
      realtime.activeTaskCount > 0
        ? 'Pi heartbeat and Electron monitor channels are healthy.'
        : 'Pi heartbeat is healthy. Electron has no active monitor tasks.'
  }
}

function normalizeWorkerSnapshot(row, checkedAtMs) {
  if (!row?.captured_at) return null
  const capturedAtMs = Date.parse(row.captured_at)
  if (!Number.isFinite(capturedAtMs)) return null
  return {
    status: String(row.status || 'unknown'),
    capturedAt: new Date(capturedAtMs).toISOString(),
    ageMs: Math.max(0, checkedAtMs - capturedAtMs),
    checks: finiteNumber(row.checks),
    bytesUsed: finiteNumber(row.bytes_used),
    totalProducts: finiteNumber(row.total_products),
    activeContexts: finiteNumber(row.active_contexts),
    blockedRate: finiteNumber(row.blocked_rate)
  }
}

function refreshWorkerAge(worker, checkedAtMs) {
  if (!worker?.capturedAt) return null
  return {
    ...worker,
    ageMs: Math.max(0, checkedAtMs - Date.parse(worker.capturedAt))
  }
}

function normalizeRealtime(value = {}) {
  const channels = value?.channels || {}
  return {
    activeTaskCount: nonNegativeInteger(value?.activeTaskCount),
    sourceState: ['connected', 'connecting', 'idle'].includes(value?.sourceState)
      ? value.sourceState
      : 'idle',
    heartbeat: {
      status: ['ok', 'timeout', 'disconnected', 'unknown'].includes(value?.heartbeat?.status)
        ? value.heartbeat.status
        : 'unknown',
      lastAt: Number.isFinite(value?.heartbeat?.lastAt) ? value.heartbeat.lastAt : null
    },
    channels: {
      total: nonNegativeInteger(channels.total),
      subscribed: nonNegativeInteger(channels.subscribed),
      connecting: nonNegativeInteger(channels.connecting),
      interrupted: nonNegativeInteger(channels.interrupted),
      catchingUp: nonNegativeInteger(channels.catchingUp),
      catchUpErrors: nonNegativeInteger(channels.catchUpErrors)
    },
    delivery: {
      realtime: nonNegativeInteger(value?.delivery?.realtime),
      catchUp: nonNegativeInteger(value?.delivery?.catchUp),
      duplicates: nonNegativeInteger(value?.delivery?.duplicates),
      catchUpErrors: nonNegativeInteger(value?.delivery?.catchUpErrors),
      lastCatchUpAt: typeof value?.delivery?.lastCatchUpAt === 'string'
        ? value.delivery.lastCatchUpAt
        : null
    },
    openCircuits: nonNegativeInteger(value?.openCircuits)
  }
}

function normalizeNotificationHealth(value = {}) {
  const evidence = (item, includeReason = false) => {
    if (!item || !Number.isFinite(Number(item.at))) return null
    const normalized = {
      notificationId: item.notificationId ? String(item.notificationId).slice(0, 100) : null,
      at: Number(item.at)
    }
    if (includeReason && item.reason) normalized.reason = String(item.reason).slice(0, 500)
    if ('accepted' in item) normalized.accepted = item.accepted === true
    if ('supported' in item) normalized.supported = item.supported === true
    return normalized
  }
  return {
    lastAttempt: evidence(value?.lastAttempt),
    lastShown: evidence(value?.lastShown),
    lastFailed: evidence(value?.lastFailed, true),
    lastClicked: evidence(value?.lastClicked),
    activeCount: nonNegativeInteger(value?.activeCount)
  }
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function formatAge(ageMs) {
  if (ageMs < 60 * 1000) return `${Math.max(1, Math.round(ageMs / 1000))} seconds`
  return `${Math.round(ageMs / 60_000)} minutes`
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}
