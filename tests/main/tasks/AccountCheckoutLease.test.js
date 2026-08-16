import { describe, expect, it, vi } from 'vitest'
import { TaskManager } from '../../../src/main/tasks/TaskManager.js'

function makeManager({ checkoutTelemetry = null, browserPool = null } = {}) {
  const account = { id: 'account-1', name: 'Target Account', profile_path: 'profile', proxy: '' }
  return new TaskManager({
    accountManager: { getDecrypted: (id) => (id === account.id ? account : null) },
    notificationEngine: { fire: async () => {} },
    browserPool: browserPool || { launch: async () => ({ once: () => {} }) },
    checkoutTelemetry,
    getDb: () => ({ prepare: () => ({ run: () => {}, get: () => null, all: () => [] }) })
  })
}

function makeStatefulPinnedPool({ pinnedInitially = false } = {}) {
  let pinned = pinnedInitially
  let activeContext = null
  const contexts = []

  const createContext = () => {
    let closed = false
    const closeListeners = []
    const context = {
      get closed() {
        return closed
      },
      once: vi.fn((event, callback) => {
        if (event === 'close') closeListeners.push(callback)
      }),
      close: vi.fn(async () => {
        if (closed) return
        closed = true
        for (const listener of closeListeners) listener()
      })
    }
    contexts.push(context)
    return context
  }

  if (pinnedInitially) activeContext = createContext()

  const pool = {
    isPinned: vi.fn(() => pinned),
    launch: vi.fn(async () => {
      if (!activeContext || activeContext.closed) activeContext = createContext()
      return activeContext
    }),
    pin: vi.fn(async () => {
      pinned = true
      return pool.launch()
    }),
    close: vi.fn(async () => {
      if (!activeContext) return
      const closing = activeContext
      await closing.close()
      if (activeContext === closing) activeContext = null
    }),
    unpin: vi.fn(async (_accountId, { close = false } = {}) => {
      pinned = false
      if (close) await pool.close()
    })
  }

  return { pool, contexts, isPinned: () => pinned }
}

describe('checkout account ownership', () => {
  it('allows one owner and rejects a competing owner with metadata', () => {
    const manager = makeManager()
    const first = manager.acquireAccountCheckout('account-1', {
      ownerId: 'task-1',
      productName: 'Product One',
      mode: 'test-checkout'
    })
    const second = manager.acquireAccountCheckout('account-1', {
      ownerId: 'task-2',
      productName: 'Product Two',
      mode: 'auto-checkout'
    })

    expect(first).toEqual({ acquired: true })
    expect(second).toMatchObject({
      acquired: false,
      reason: 'account-busy',
      owner: { ownerId: 'task-1', productName: 'Product One' }
    })
  })

  it('only the owner can release the checkout lease', () => {
    const manager = makeManager()
    manager.acquireAccountCheckout('account-1', { ownerId: 'task-1', mode: 'run-now' })

    expect(manager.releaseAccountCheckout('account-1', 'task-2')).toBe(false)
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'task-2' }).acquired).toBe(false)
    expect(manager.releaseAccountCheckout('account-1', 'task-1')).toBe(true)
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'task-2' }).acquired).toBe(true)
  })

  it('does not let an existing owner refresh or replace its lease', () => {
    const manager = makeManager()
    manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-1', taskId: 'task-1' })

    expect(
      manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-1', taskId: 'task-1' })
    ).toMatchObject({ acquired: false, reason: 'account-busy' })
  })

  it('records a terminal busy attempt when another task owns the account', async () => {
    const existingOwnerId = 'task-1'
    const telemetry = {
      beginAttempt: vi.fn(() => 'attempt-2'),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const manager = makeManager({ checkoutTelemetry: telemetry })
    manager.acquireAccountCheckout('account-1', {
      ownerId: existingOwnerId,
      productName: 'Existing'
    })
    const acquire = vi.spyOn(manager, 'acquireAccountCheckout')
    const result = await manager._runFlowForAccount(
      async () => ({ success: true }),
      { id: 'task-2', mode: 'auto-checkout', retailer: 'target' },
      { productUrl: 'https://www.target.com/p/example', productName: 'Competing' },
      'account-1'
    )

    expect(result).toMatchObject({ accountBusy: true, success: false })
    expect(telemetry.beginAttempt).toHaveBeenCalledOnce()
    expect(telemetry.beginAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      acquire.mock.invocationCallOrder[0]
    )
    expect(telemetry.recordLease).toHaveBeenCalledWith(
      'attempt-2',
      'busy',
      expect.objectContaining({ ownerId: existingOwnerId })
    )
    expect(telemetry.completeAttempt).toHaveBeenCalledWith(
      'attempt-2',
      expect.objectContaining({ error: expect.stringContaining('Account is busy') })
    )
    const metadata = JSON.stringify(telemetry.recordLease.mock.calls[0][2])
    expect(metadata).not.toContain('account-1')
    expect(metadata).not.toContain('Target Account')
  })

  it('records acquisition and bounded hold time before a normal release completes', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const telemetry = {
      beginAttempt: vi.fn(() => 'attempt-1'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const browserPool = {
      launch: vi.fn(async () => ({ once: vi.fn() })),
      close: vi.fn(async () => {})
    }
    const manager = makeManager({ checkoutTelemetry: telemetry, browserPool })

    const result = await manager._runFlowForAccount(
      async () => {
        now = 1_125
        return { success: true }
      },
      { id: 'task-1', mode: 'auto-checkout', retailer: 'target' },
      { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
      'account-1'
    )

    expect(result).toMatchObject({ success: true })
    expect(telemetry.recordLease).toHaveBeenNthCalledWith(
      1,
      'attempt-1',
      'acquired',
      expect.objectContaining({ ownerId: 'attempt-1' })
    )
    expect(telemetry.recordLease).toHaveBeenNthCalledWith(
      2,
      'attempt-1',
      'released',
      expect.objectContaining({ ownerId: 'attempt-1', heldMs: 125 })
    )
    expect(telemetry.recordLease.mock.invocationCallOrder[1]).toBeLessThan(
      telemetry.completeAttempt.mock.invocationCallOrder[0]
    )
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'task-2' }).acquired).toBe(true)
    nowSpy.mockRestore()
  })

  it('keeps a preserved lease busy for a later checkout from the same task', async () => {
    const telemetry = {
      beginAttempt: vi.fn().mockReturnValueOnce('attempt-1').mockReturnValueOnce('attempt-2'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const browserPool = {
      launch: vi.fn(async () => ({ once: vi.fn() })),
      close: vi.fn(async () => {})
    }
    const manager = makeManager({ checkoutTelemetry: telemetry, browserPool })
    const task = { id: 'task-1', mode: 'test-checkout', retailer: 'target' }
    const dropEvent = {
      productUrl: 'https://www.target.com/p/example',
      productName: 'Product'
    }

    await manager._runFlowForAccount(
      async () => ({ success: true, testMode: true }),
      task,
      dropEvent,
      'account-1'
    )
    const second = await manager._runFlowForAccount(
      async () => ({ success: true, testMode: true }),
      task,
      dropEvent,
      'account-1'
    )

    expect(second).toMatchObject({ success: false, accountBusy: true })
    expect(browserPool.launch).toHaveBeenCalledTimes(1)
    expect(telemetry.recordLease).toHaveBeenCalledWith(
      'attempt-1',
      'acquired',
      expect.objectContaining({ ownerId: 'attempt-1' })
    )
    expect(JSON.stringify(telemetry.recordLease.mock.calls)).not.toContain('task-1:account-1')
  })

  it('does not let a stale context close unpin a newer lease', async () => {
    let closeOldContext
    const telemetry = {
      beginAttempt: vi.fn(() => 'attempt-1'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const browserPool = {
      isPinned: vi.fn(() => false),
      pin: vi.fn(async () => ({})),
      launch: vi.fn(async () => ({
        once: vi.fn((_event, callback) => {
          closeOldContext = callback
        })
      })),
      close: vi.fn(async () => {}),
      unpin: vi.fn(async () => {})
    }
    const manager = makeManager({ checkoutTelemetry: telemetry, browserPool })

    await manager._runFlowForAccount(
      async () => ({ success: true, testMode: true }),
      { id: 'task-1', mode: 'test-checkout', retailer: 'target' },
      { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
      'account-1'
    )
    expect(manager.releaseAccountCheckout('account-1', 'attempt-1')).toBe(true)
    expect(
      manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2', taskId: 'task-1' })
        .acquired
    ).toBe(true)

    closeOldContext()

    expect(browserPool.unpin).not.toHaveBeenCalled()
    expect(
      manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-3', taskId: 'task-2' })
        .acquired
    ).toBe(false)
  })

  it('releases a preserved lease when its context closed before preservation was known', async () => {
    let closeContext
    const telemetry = {
      beginAttempt: vi.fn(() => 'attempt-1'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const browserPool = {
      isPinned: vi.fn(() => false),
      pin: vi.fn(async () => ({})),
      launch: vi.fn(async () => ({
        once: vi.fn((_event, callback) => {
          closeContext = callback
        })
      })),
      close: vi.fn(async () => {}),
      unpin: vi.fn(async () => {})
    }
    const manager = makeManager({ checkoutTelemetry: telemetry, browserPool })

    await manager._runFlowForAccount(
      async () => {
        closeContext()
        return { success: true, testMode: true }
      },
      { id: 'task-1', mode: 'test-checkout', retailer: 'target' },
      { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
      'account-1'
    )

    expect(browserPool.unpin).toHaveBeenCalledWith('account-1', { close: false })
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2' }).acquired).toBe(
      true
    )
  })

  it('does not release an active checkout lease when its task stops', async () => {
    let resolveFlow
    let flowStarted
    const started = new Promise((resolve) => {
      flowStarted = resolve
    })
    const flowResult = new Promise((resolve) => {
      resolveFlow = resolve
    })
    const browserPool = {
      launch: vi.fn(async () => ({ once: vi.fn() })),
      close: vi.fn(async () => {})
    }
    const manager = makeManager({ browserPool })
    const task = {
      id: 'task-1',
      mode: 'auto-checkout',
      retailer: 'target',
      product_url: 'https://www.target.com/p/example'
    }
    manager._tasks.set(task.id, task)

    const checkout = manager._runFlowForAccount(
      async () => {
        flowStarted()
        return flowResult
      },
      task,
      { productUrl: task.product_url, productName: 'Product' },
      'account-1'
    )
    await started

    await manager.stopTask(task.id, { unsubscribe: false })

    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2' }).acquired).toBe(
      false
    )

    resolveFlow({ success: true })
    await checkout
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2' }).acquired).toBe(
      true
    )
  })

  it('keeps a stopped preserved checkout leased until its context closes', async () => {
    let onClose
    let finishClose
    const closeAllowed = new Promise((resolve) => {
      finishClose = resolve
    })
    let pinned = true
    const browserPool = {
      isPinned: vi.fn(() => pinned),
      launch: vi.fn(async () => ({
        once: vi.fn((event, callback) => {
          if (event === 'close') onClose = callback
        })
      })),
      close: vi.fn(async () => {}),
      unpin: vi.fn(async (_accountId, { close }) => {
        pinned = false
        if (close) {
          await closeAllowed
          onClose()
        }
      })
    }
    const manager = makeManager({ browserPool })
    const task = {
      id: 'task-1',
      mode: 'test-checkout',
      retailer: 'target',
      product_url: 'https://www.target.com/p/example'
    }
    manager._tasks.set(task.id, task)
    manager._warmAccountsByTask.set(task.id, ['account-1'])
    manager._warmAccountRefs.set('account-1', 1)

    await manager._runFlowForAccount(
      async () => ({ success: true, testMode: true }),
      task,
      { productUrl: task.product_url, productName: 'Product' },
      'account-1'
    )

    await manager.stopTask(task.id, { unsubscribe: false })

    expect(browserPool.unpin).toHaveBeenCalledWith('account-1', { close: true })
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2' }).acquired).toBe(
      false
    )

    finishClose()
    await vi.waitFor(() => expect(onClose).toBeTypeOf('function'))
    await vi.waitFor(() =>
      expect(manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2' }).acquired).toBe(
        true
      )
    )
  })

  it('does not unpin shared warm ownership or release its lease when one task stops', async () => {
    const browserPool = { unpin: vi.fn(async () => {}) }
    const manager = makeManager({ browserPool })
    manager._tasks.set('task-1', { id: 'task-1' })
    manager._warmAccountsByTask.set('task-1', ['account-1'])
    manager._warmAccountsByTask.set('task-2', ['account-1'])
    manager._warmAccountRefs.set('account-1', 2)
    manager.acquireAccountCheckout('account-1', {
      ownerId: 'attempt-1',
      taskId: 'task-1'
    })

    await manager.stopTask('task-1', { unsubscribe: false })

    expect(browserPool.unpin).not.toHaveBeenCalled()
    expect(manager._warmAccountRefs.get('account-1')).toBe(1)
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'attempt-2' }).acquired).toBe(
      false
    )
  })

  it('holds one lease across both configured orders and the inter-order delay', async () => {
    vi.useFakeTimers()
    try {
      let gapStarted
      const inGap = new Promise((resolve) => {
        gapStarted = resolve
      })
      const browserPool = {
        launch: vi.fn(async () => ({ once: vi.fn() })),
        close: vi.fn(async () => {})
      }
      const manager = makeManager({ browserPool })
      const emitCheckoutStep = vi
        .spyOn(manager, '_emitCheckoutStep')
        .mockImplementation((_dropEvent, _account, message) => {
          if (message.includes('starting separate order 2')) gapStarted()
        })
      const flow = vi.fn(async () => ({ success: true }))
      const task = {
        id: 'task-1',
        mode: 'auto-checkout',
        retailer: 'target',
        orders_per_drop: 2
      }

      const checkout = manager._runOrdersForAccountUnlocked(
        flow,
        task,
        { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
        'account-1'
      )
      await inGap

      const competing = manager.acquireAccountCheckout('account-1', {
        ownerId: 'competing-attempt',
        taskId: 'task-2'
      })
      if (competing.acquired) {
        manager.releaseAccountCheckout('account-1', 'competing-attempt')
      }
      await vi.advanceTimersByTimeAsync(750)
      const result = await checkout

      expect(competing).toMatchObject({ acquired: false, reason: 'account-busy' })
      expect(flow).toHaveBeenCalledTimes(2)
      expect(result).toMatchObject({ success: true, ordersRequested: 2, ordersCompleted: 2 })
      expect(emitCheckoutStep).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a checkout-owned pinned context for retry and normal cleanup', async () => {
    vi.useFakeTimers()
    try {
      let firstAttemptStarted
      const firstAttempt = new Promise((resolve) => {
        firstAttemptStarted = resolve
      })
      const { pool, contexts, isPinned } = makeStatefulPinnedPool()
      const manager = makeManager({ browserPool: pool })
      const flow = vi.fn(async () => {
        if (flow.mock.calls.length === 1) {
          firstAttemptStarted()
          throw new Error('network failure')
        }
        return { success: true }
      })

      const checkout = manager._runFlowForAccount(
        flow,
        { id: 'task-1', mode: 'auto-checkout', retailer: 'target' },
        { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
        'account-1'
      )
      await firstAttempt
      await vi.advanceTimersByTimeAsync(2000)
      await expect(checkout).resolves.toMatchObject({ success: true })

      expect(flow).toHaveBeenCalledTimes(2)
      expect(contexts).toHaveLength(2)
      expect(contexts.every((context) => context.closed)).toBe(true)
      expect(pool.close).toHaveBeenCalledTimes(2)
      expect(pool.unpin).toHaveBeenCalledWith('account-1', { close: false })
      expect(isPinned()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a pre-existing shared pin and context after normal checkout cleanup', async () => {
    const { pool, contexts, isPinned } = makeStatefulPinnedPool({ pinnedInitially: true })
    const manager = makeManager({ browserPool: pool })

    await manager._runFlowForAccount(
      async () => ({ success: true }),
      { id: 'task-1', mode: 'auto-checkout', retailer: 'target' },
      { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
      'account-1'
    )

    expect(pool.pin).not.toHaveBeenCalled()
    expect(pool.close).not.toHaveBeenCalled()
    expect(pool.unpin).not.toHaveBeenCalled()
    expect(contexts).toHaveLength(1)
    expect(contexts[0].closed).toBe(false)
    expect(isPinned()).toBe(true)
  })

  it.each([
    ['test checkout', { success: true, testMode: true }],
    ['manual checkout', { success: false, requiresManualCheckout: true }]
  ])('does not record release for a preserved %s context', async (_label, flowResult) => {
    let onClose
    const telemetry = {
      beginAttempt: vi.fn(() => 'attempt-1'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const browserPool = {
      launch: vi.fn(async () => ({
        once: vi.fn((event, callback) => {
          if (event === 'close') onClose = callback
        })
      })),
      close: vi.fn(async () => {})
    }
    const manager = makeManager({ checkoutTelemetry: telemetry, browserPool })

    await manager._runFlowForAccount(
      async () => flowResult,
      { id: 'task-1', mode: 'test-checkout', retailer: 'target' },
      { productUrl: 'https://www.target.com/p/example', productName: 'Product' },
      'account-1'
    )

    expect(telemetry.completeAttempt).toHaveBeenCalledOnce()
    expect(telemetry.recordLease).not.toHaveBeenCalledWith(
      'attempt-1',
      'released',
      expect.anything()
    )
    onClose()
    expect(telemetry.recordLease).not.toHaveBeenCalledWith(
      'attempt-1',
      'released',
      expect.anything()
    )
  })
})
