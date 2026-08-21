import { describe, expect, it, vi } from 'vitest'
import { MonitorHealth } from '../../../src/main/health/MonitorHealth.js'

const NOW = Date.parse('2026-07-27T03:00:00.000Z')

function makeTaskManager(overrides = {}) {
  return {
    getMonitorHealthSnapshot: vi.fn(() => ({
      activeTaskCount: 2,
      sourceState: 'connected',
      heartbeat: { status: 'ok', lastAt: NOW - 5000 },
      channels: {
        total: 2,
        subscribed: 2,
        connecting: 0,
        interrupted: 0,
        catchingUp: 0,
        catchUpErrors: 0
      },
      openCircuits: 0,
      ...overrides
    }))
  }
}

function makeAuth(results, authenticated = true) {
  const queuedResults = Array.isArray(results) ? [...results] : [results]
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve(queuedResults.shift()))
  }
  const client = { from: vi.fn(() => query) }
  return {
    manager: {
      getStatus: vi.fn(() => ({ authenticated })),
      getClient: vi.fn(() => client)
    },
    client,
    query
  }
}

function healthyRow(capturedAt = '2026-07-27T02:59:30.000Z') {
  return {
    status: 'ok',
    checks: 1837,
    bytes_used: 16465001,
    total_products: 14,
    active_contexts: 2,
    blocked_rate: 0.0245,
    captured_at: capturedAt
  }
}

describe('MonitorHealth', () => {
  it('combines a fresh Pi heartbeat with subscribed Electron channels', async () => {
    const auth = makeAuth({ data: [healthyRow()], error: null })
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager: makeTaskManager(),
      notificationEngine: {
        getHealthSnapshot: () => ({
          lastAttempt: { notificationId: 'drop-1', at: NOW - 2000 },
          lastShown: { notificationId: 'drop-1', at: NOW - 1000 },
          lastFailed: null,
          lastClicked: null,
          activeCount: 1
        })
      },
      now: () => NOW
    })

    const result = await service.getSnapshot()

    expect(auth.client.from).toHaveBeenCalledWith('monitor_snapshots')
    expect(auth.query.select).toHaveBeenCalledWith(
      'status,checks,bytes_used,total_products,active_contexts,blocked_rate,captured_at'
    )
    expect(auth.query.order).toHaveBeenCalledWith('captured_at', { ascending: false })
    expect(auth.query.limit).toHaveBeenCalledWith(1)
    expect(result).toMatchObject({
      status: 'ready',
      reason: 'healthy',
      telemetryReachable: true,
      worker: {
        status: 'ok',
        ageMs: 30_000,
        checks: 1837,
        bytesUsed: 16465001,
        totalProducts: 14,
        activeContexts: 2,
        blockedRate: 0.0245
      },
      realtime: {
        activeTaskCount: 2,
        sourceState: 'connected',
        channels: { total: 2, subscribed: 2 }
      },
      notifications: {
        lastShown: { notificationId: 'drop-1', at: NOW - 1000 },
        activeCount: 1
      }
    })
  })

  it('marks a heartbeat older than 150 seconds as stale', async () => {
    const auth = makeAuth({
      data: [healthyRow('2026-07-27T02:57:00.000Z')],
      error: null
    })
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager: makeTaskManager(),
      now: () => NOW
    })

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'stale',
      reason: 'heartbeat_stale',
      worker: { ageMs: 180_000 }
    })
  })

  it('reports healthy Pi telemetry as degraded when a realtime channel is interrupted', async () => {
    const auth = makeAuth({ data: [healthyRow()], error: null })
    const taskManager = makeTaskManager({
      channels: {
        total: 2,
        subscribed: 1,
        connecting: 0,
        interrupted: 1,
        catchingUp: 0,
        catchUpErrors: 0
      }
    })
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager,
      now: () => NOW
    })

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'degraded',
      reason: 'realtime_interrupted'
    })
  })

  it('reports healthy Pi telemetry as degraded when the realtime heartbeat disconnects', async () => {
    const auth = makeAuth({ data: [healthyRow()], error: null })
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager: makeTaskManager({
        heartbeat: { status: 'disconnected', lastAt: NOW - 5000 }
      }),
      now: () => NOW
    })

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'degraded',
      reason: 'realtime_interrupted'
    })
  })

  it('does not query Supabase while signed out', async () => {
    const auth = makeAuth({ data: [healthyRow()], error: null }, false)
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager: makeTaskManager(),
      now: () => NOW
    })

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'signed_out',
      worker: null
    })
    expect(auth.manager.getClient).not.toHaveBeenCalled()
  })

  it('keeps the last safe heartbeat when a later network read fails', async () => {
    const auth = makeAuth([
      { data: [healthyRow()], error: null },
      { data: null, error: { message: 'https://secret-project.invalid failed' } }
    ])
    let now = NOW
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager: makeTaskManager(),
      now: () => now
    })

    await expect(service.getSnapshot()).resolves.toMatchObject({ status: 'ready' })
    now += 20_000
    const result = await service.getSnapshot()

    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'telemetry_unreachable',
      telemetryReachable: false,
      worker: { ageMs: 50_000 }
    })
    expect(JSON.stringify(result)).not.toContain('secret-project')
  })

  it('handles an empty telemetry table without exposing internal errors', async () => {
    const auth = makeAuth({ data: [], error: null })
    const service = new MonitorHealth({
      authSessionManager: auth.manager,
      taskManager: makeTaskManager(),
      now: () => NOW
    })

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'unreachable',
      message: 'No central monitor heartbeat has been received yet.'
    })
  })
})
