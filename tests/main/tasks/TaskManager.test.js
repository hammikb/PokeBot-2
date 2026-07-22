import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/automation/flows/walmart.js', () => ({
  runWalmartFlow: vi.fn(async () => ({
    success: true,
    testMode: true,
    requiresManualCheckout: true
  }))
}))

vi.mock('../../../src/main/automation/flows/target.js', () => ({
  runTargetFlow: vi.fn(async () => ({
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

import { TaskManager, isRetryableCheckoutError } from '../../../src/main/tasks/TaskManager.js'
import { runWalmartFlow } from '../../../src/main/automation/flows/walmart.js'
import { runTargetFlow } from '../../../src/main/automation/flows/target.js'

describe('Target checkout retry classification', () => {
  it('retries temporary Target states but not settled inventory failures', () => {
    expect(isRetryableCheckoutError('Target fulfillment is still loading')).toBe(true)
    expect(isRetryableCheckoutError('Target availability did not settle')).toBe(true)
    expect(isRetryableCheckoutError('Item is out of stock (Target availability settled)')).toBe(
      false
    )
  })

  it("retries temporary Sam's Club traffic and checkout failures", () => {
    expect(isRetryableCheckoutError("Sam's Club traffic gate did not clear")).toBe(true)
    expect(
      isRetryableCheckoutError("Sam's Club checkout request failed temporarily after 3 attempts")
    ).toBe(true)
    expect(isRetryableCheckoutError("Sam's Club item is unavailable (availability settled)")).toBe(
      false
    )
  })
})

function makeTaskManager(settings = {}, accountOverrides = {}) {
  const notify = { fire: vi.fn() }
  const account = {
    id: 'account-1',
    name: 'Target Account',
    profile_path: 'profile-1',
    proxy: '',
    cvv: '123',
    password: 'password',
    ...accountOverrides
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
  const paymentManager = {
    get: vi.fn((id) =>
      id === 'payment-1' ? { id, cardNumber: '4111111111111111', cvv: '456' } : null
    )
  }
  const manager = new TaskManager({
    accountManager,
    notificationEngine: notify,
    browserPool,
    getDb: () => db,
    getSettings: () => settings,
    paymentManager
  })

  return { manager, notify, accountManager, browserPool, browserContext, paymentManager }
}

describe('TaskManager test checkout', () => {
  it('runs two separate confirmed Target orders when the task requests two', async () => {
    const { manager } = makeTaskManager()
    runTargetFlow
      .mockResolvedValueOnce({
        success: true,
        testMode: false,
        requiresManualCheckout: false
      })
      .mockResolvedValueOnce({
        success: true,
        testMode: false,
        requiresManualCheckout: false
      })

    const result = await manager._runOrdersForAccount(
      runTargetFlow,
      {
        id: 'task-repeat',
        retailer: 'target',
        product_name: 'Pokemon ETB',
        product_url: 'https://www.target.com/p/example/A-123',
        account_ids: JSON.stringify(['account-1']),
        buy_limit: 2,
        orders_per_drop: 2,
        mode: 'auto-checkout'
      },
      {
        retailer: 'target',
        productName: 'Pokemon ETB',
        productUrl: 'https://www.target.com/p/example/A-123',
        dropType: 'in_stock'
      },
      'account-1'
    )

    expect(runTargetFlow).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ success: true, ordersRequested: 2, ordersCompleted: 2 })
  })

  it('runs the target checkout flow in test mode for selected accounts', async () => {
    const { manager, browserPool, browserContext } = makeTaskManager()

    const result = await manager.testTask({
      id: 'task-1',
      retailer: 'target',
      product_name: 'Pokemon ETB',
      product_url: 'https://www.target.com/p/example/A-123',
      account_ids: JSON.stringify(['account-1']),
      buy_limit: 1,
      mode: 'monitor-and-buy'
    })

    expect(result.success).toBe(true)
    expect(browserPool.launch).toHaveBeenCalledWith('account-1', {
      profilePath: 'profile-1',
      proxy: ''
    })
    expect(runTargetFlow).toHaveBeenCalledWith(
      browserContext,
      expect.objectContaining({
        productUrl: 'https://www.target.com/p/example/A-123',
        mode: 'test-checkout',
        useTargetCartApi: false,
        targetCheckoutLiteMode: false
      })
    )
    expect(browserPool.close).not.toHaveBeenCalled()
  })

  it('passes the experimental Target cart API setting into checkout', async () => {
    const { manager, browserContext } = makeTaskManager(
      {
        targetCartApiEnabled: true,
        targetCheckoutLiteMode: true
      },
      { payment_method_id: 'payment-1' }
    )

    await manager.testTask({
      id: 'task-api',
      retailer: 'target',
      product_name: 'Pokemon ETB',
      product_url: 'https://www.target.com/p/example/A-123',
      account_ids: JSON.stringify(['account-1']),
      buy_limit: 1,
      mode: 'monitor-and-buy'
    })

    expect(runTargetFlow).toHaveBeenCalledWith(
      browserContext,
      expect.objectContaining({
        useTargetCartApi: true,
        targetCheckoutLiteMode: true,
        cardNumber: '4111111111111111',
        cardLast4: '1111',
        cvv: '456'
      })
    )
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
