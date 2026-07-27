import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/automation/flows/walmart.js', () => ({ runWalmartFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/target.js', () => ({ runTargetFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/pokemon-center.js', () => ({
  runPokemonCenterFlow: vi.fn()
}))
vi.mock('../../../src/main/automation/flows/costco.js', () => ({ runCostcoFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/samsclub.js', () => ({ runSamsClubFlow: vi.fn() }))

import { TaskManager } from '../../../src/main/tasks/TaskManager.js'

describe('TaskManager monitor health snapshot', () => {
  it('summarizes active tasks, realtime channel states, catch-up failures, and open circuits', () => {
    const source = new EventEmitter()
    source.getHealth = vi.fn(() => ({
      'https://example.com/one': { status: 'SUBSCRIBED', catchingUp: false },
      'https://example.com/two': {
        status: 'CHANNEL_ERROR',
        catchingUp: false,
        catchUpError: 'network failed'
      },
      'https://example.com/three': { status: 'CONNECTING', catchingUp: true }
    }))
    const retailerCircuit = {
      snapshot: vi.fn(() => ({ target: { failures: 3, openedAt: 123 } }))
    }
    const manager = new TaskManager({
      accountManager: {},
      notificationEngine: {},
      browserPool: {},
      getDb: () => ({}),
      retailerCircuit
    })
    manager._tasks.set('task-1', {})
    manager._tasks.set('task-2', {})
    manager._supabaseSource = source

    expect(manager.getMonitorHealthSnapshot()).toEqual({
      activeTaskCount: 2,
      sourceState: 'connected',
      channels: {
        total: 3,
        subscribed: 1,
        connecting: 1,
        interrupted: 1,
        catchingUp: 1,
        catchUpErrors: 1
      },
      openCircuits: 1
    })
  })

  it('returns a safe idle snapshot before any Supabase source exists', () => {
    const manager = new TaskManager({
      accountManager: {},
      notificationEngine: {},
      browserPool: {},
      getDb: () => ({})
    })

    expect(manager.getMonitorHealthSnapshot()).toEqual({
      activeTaskCount: 0,
      sourceState: 'idle',
      channels: {
        total: 0,
        subscribed: 0,
        connecting: 0,
        interrupted: 0,
        catchingUp: 0,
        catchUpErrors: 0
      },
      openCircuits: 0
    })
  })

  it('does not report ordinary sub-threshold failures as an open circuit', () => {
    const manager = new TaskManager({
      accountManager: {},
      notificationEngine: {},
      browserPool: {},
      getDb: () => ({}),
      retailerCircuit: {
        snapshot: () => ({
          target: { failures: 2, openedAt: null, open: false, remainingMs: 0 }
        })
      }
    })

    expect(manager.getMonitorHealthSnapshot().openCircuits).toBe(0)
  })
})
