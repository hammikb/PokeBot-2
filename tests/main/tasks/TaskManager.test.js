import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/automation/flows/walmart.js', () => ({
  runWalmartFlow: vi.fn(async () => ({
    success: true,
    testMode: true,
    requiresManualCheckout: true
  }))
}))

vi.mock('../../../src/main/automation/flows/pokemon-center.js', () => ({
  runPokemonCenterFlow: vi.fn()
}))

vi.mock('../../../src/main/automation/flows/costco.js', () => ({
  runCostcoFlow: vi.fn()
}))

import { TaskManager } from '../../../src/main/tasks/TaskManager.js'
import { runWalmartFlow } from '../../../src/main/automation/flows/walmart.js'

function makeTaskManager() {
  const notify = { fire: vi.fn() }
  const account = {
    id: 'account-1',
    name: 'Target Account',
    profile_path: 'profile-1',
    proxy: '',
    cvv: '123',
    password: 'password'
  }
  const accountManager = {
    getDecrypted: vi.fn((id) => (id === account.id ? account : null))
  }
  const browserContext = { id: 'context-1' }
  const browserPool = {
    launch: vi.fn(async () => browserContext),
    close: vi.fn()
  }
  const db = {
    prepare: vi.fn(() => ({
      run: vi.fn()
    }))
  }
  const manager = new TaskManager({
    accountManager,
    notificationEngine: notify,
    browserPool,
    getDb: () => db
  })

  return { manager, notify, accountManager, browserPool, browserContext }
}

describe('TaskManager test checkout', () => {
  it('returns a clear error because Target checkout automation has been reset', async () => {
    const { manager } = makeTaskManager()

    const result = await manager.testTask({
      id: 'task-1',
      retailer: 'target',
      product_name: 'Pokemon ETB',
      product_url: 'https://www.target.com/p/example/A-123',
      account_ids: JSON.stringify(['account-1']),
      mode: 'test-checkout'
    })

    expect(result).toMatchObject({
      success: false,
      results: [{ success: false, error: 'Test checkout is not supported for target' }]
    })
  })

  it('returns a clear error when a task has no selected accounts', async () => {
    const { manager, notify } = makeTaskManager()

    const result = await manager.testTask({
      id: 'task-1',
      retailer: 'walmart',
      product_name: 'Pokemon ETB',
      product_url: 'https://www.walmart.com/ip/example/123',
      account_ids: '[]',
      mode: 'test-checkout'
    })

    expect(result).toMatchObject({
      success: false,
      results: [{ success: false, error: 'No accounts selected for this task' }]
    })
    expect(notify.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        productName: 'ERROR: No accounts selected for this task'
      })
    )
  })

  it('runs the checkout flow immediately in test mode for selected accounts', async () => {
    const { manager, browserPool, browserContext } = makeTaskManager()

    const result = await manager.testTask({
      id: 'task-1',
      retailer: 'walmart',
      product_name: 'Pokemon ETB',
      product_url: 'https://www.walmart.com/ip/example/123',
      account_ids: JSON.stringify(['account-1']),
      buy_limit: 5,
      mode: 'monitor-and-buy'
    })

    expect(result.success).toBe(true)
    expect(browserPool.launch).toHaveBeenCalledWith('account-1', {
      profilePath: 'profile-1',
      proxy: ''
    })
    expect(runWalmartFlow).toHaveBeenCalledWith(
      browserContext,
      expect.objectContaining({
        productUrl: 'https://www.walmart.com/ip/example/123',
        mode: 'test-checkout',
        buyLimit: 5
      })
    )
    expect(browserPool.close).not.toHaveBeenCalled()
  })
})
