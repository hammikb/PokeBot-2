import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel, listener) => handlers.set(channel, listener)
  }
}))

import { registerIpcHandlers } from '../../src/main/ipc.js'
import { IPC, IPC_INVOKE_CHANNELS } from '../../src/shared/constants.js'

function register(monitorHealth) {
  registerIpcHandlers({
    getDb: () => ({ prepare: vi.fn() }),
    accountManager: {},
    paymentManager: {},
    shippingManager: {},
    thumbnailCache: {},
    taskManager: { on: vi.fn() },
    pokemonFinder: { on: vi.fn() },
    profileWarmup: {},
    getSettings: () => ({}),
    mainWindow: { webContents: { send: vi.fn() } },
    browserPool: {},
    notificationEngine: {},
    queueJoiner: { on: vi.fn() },
    pokemonCenterQueueJoiner: { on: vi.fn() },
    authSessionManager: {},
    checkoutTelemetry: {},
    monitorHealth
  })
}

describe('monitor health IPC', () => {
  beforeEach(() => handlers.clear())

  it('exposes the sanitized MonitorHealth snapshot on an allowlisted channel', async () => {
    const snapshot = {
      status: 'ready',
      worker: { checks: 100 },
      realtime: { activeTaskCount: 1 }
    }
    const monitorHealth = { getSnapshot: vi.fn(async () => snapshot) }
    register(monitorHealth)

    expect(IPC_INVOKE_CHANNELS).toContain(IPC.MONITOR_HEALTH_GET)
    await expect(handlers.get(IPC.MONITOR_HEALTH_GET)({})).resolves.toEqual(snapshot)
    expect(monitorHealth.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('rejects unexpected renderer arguments through the IPC schema', async () => {
    register({ getSnapshot: vi.fn() })

    await expect(
      handlers.get(IPC.MONITOR_HEALTH_GET)({}, { includeSecrets: true })
    ).rejects.toThrow()
  })
})
