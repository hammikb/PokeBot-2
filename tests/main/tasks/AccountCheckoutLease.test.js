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
      expect.objectContaining({ ownerId: 'task-1:account-1' })
    )
    expect(telemetry.recordLease).toHaveBeenNthCalledWith(
      2,
      'attempt-1',
      'released',
      expect.objectContaining({ ownerId: 'task-1:account-1', heldMs: 125 })
    )
    expect(telemetry.recordLease.mock.invocationCallOrder[1]).toBeLessThan(
      telemetry.completeAttempt.mock.invocationCallOrder[0]
    )
    expect(manager.acquireAccountCheckout('account-1', { ownerId: 'task-2' }).acquired).toBe(true)
    nowSpy.mockRestore()
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
