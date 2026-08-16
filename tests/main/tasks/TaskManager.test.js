import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

import {
  TaskManager,
  isRetryableCheckoutError,
  isRetryableCheckoutResult
} from '../../../src/main/tasks/TaskManager.js'
import { runWalmartFlow } from '../../../src/main/automation/flows/walmart.js'
import { runTargetFlow } from '../../../src/main/automation/flows/target.js'
import { JsonDb } from '../../../src/main/db.js'

describe('Target checkout retry classification', () => {
  it('retries temporary Target states but not settled inventory failures', () => {
    expect(isRetryableCheckoutError('Target fulfillment is still loading')).toBe(true)
    expect(isRetryableCheckoutError('Target availability did not settle')).toBe(true)
    expect(isRetryableCheckoutError('Item is out of stock (Target availability settled)')).toBe(
      false
    )
    expect(isRetryableCheckoutError('Target security challenge did not clear')).toBe(false)
    expect(isRetryableCheckoutError('HTTP 403')).toBe(false)
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

  it('never retries an uncertain result after an order submission attempt', () => {
    expect(
      isRetryableCheckoutResult({
        success: false,
        error: 'Network timeout waiting for confirmation',
        orderSubmissionAttempted: true,
        submissionUncertain: true,
        requiresManualCheckout: true
      })
    ).toBe(false)
    expect(
      isRetryableCheckoutResult({
        success: false,
        error: 'Network timeout before checkout'
      })
    ).toBe(true)
  })
})

function makeTaskManager(settings = {}, accountOverrides = {}, managerOverrides = {}) {
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
    getDecrypted: vi.fn((id) => (id === account.id ? account : null)),
    setStatus: vi.fn()
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
    paymentManager,
    ...managerOverrides
  })

  return { manager, notify, accountManager, browserPool, browserContext, paymentManager }
}

describe('TaskManager test checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not retry or close the browser after an uncertain order submission', async () => {
    const { manager, browserPool, accountManager } = makeTaskManager()
    runWalmartFlow.mockResolvedValueOnce({
      success: false,
      error: 'Walmart order submission status is uncertain. Do not retry.',
      cause: 'Network timeout waiting for confirmation',
      terminal: true,
      orderSubmissionAttempted: true,
      submissionUncertain: true,
      requiresManualCheckout: true
    })

    const result = await manager._runFlowForAccount(
      runWalmartFlow,
      {
        id: 'walmart-task',
        retailer: 'walmart',
        product_name: 'Pokemon Cards',
        product_url: 'https://www.walmart.com/ip/example/123456',
        buy_limit: 1,
        orders_per_drop: 1,
        mode: 'monitor-and-buy'
      },
      {
        retailer: 'walmart',
        productName: 'Pokemon Cards',
        productUrl: 'https://www.walmart.com/ip/example/123456',
        dropType: 'in_stock'
      },
      'account-1'
    )

    expect(runWalmartFlow).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      success: false,
      submissionUncertain: true,
      requiresManualCheckout: true
    })
    expect(browserPool.launch).toHaveBeenCalledTimes(1)
    expect(browserPool.close).not.toHaveBeenCalled()
    expect(accountManager.setStatus).toHaveBeenCalledWith('account-1', 'manual_review')
  })

  it('blocks an account until the user clears a prior uncertain-order hold', async () => {
    const { manager, browserPool } = makeTaskManager({}, { status: 'manual_review' })

    const result = await manager._runOrdersForAccount(
      runTargetFlow,
      {
        id: 'task-held',
        retailer: 'target',
        product_url: 'https://www.target.com/p/example/A-123',
        mode: 'auto-checkout'
      },
      {
        retailer: 'target',
        productName: 'Pokemon Cards',
        productUrl: 'https://www.target.com/p/example/A-123',
        dropType: 'in_stock'
      },
      'account-1'
    )

    expect(result).toMatchObject({
      success: false,
      manualReviewRequired: true,
      requiresManualCheckout: true
    })
    expect(browserPool.launch).not.toHaveBeenCalled()
  })

  it('flushes an uncertain-order account hold before returning', () => {
    const dbPath = join(tmpdir(), `pokebot-account-hold-${Date.now()}-${Math.random()}.json`)
    const db = new JsonDb(dbPath)
    db.prepare('INSERT INTO accounts (id, name, retailer, status) VALUES (?, ?, ?, ?)').run(
      'account-hold',
      'Held Account',
      'target',
      'verified'
    )
    const manager = new TaskManager({
      accountManager: {
        setStatus: (id, status) =>
          db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id)
      },
      notificationEngine: {},
      browserPool: {},
      getDb: () => db
    })

    manager._holdAccountForManualReview(
      { id: 'account-hold', retailer: 'target' },
      'confirmation timed out'
    )
    const reloaded = new JsonDb(dbPath)

    expect(reloaded.prepare('SELECT * FROM accounts WHERE id = ?').get('account-hold').status).toBe(
      'manual_review'
    )
    db.close()
    reloaded.close()
    for (const path of [dbPath, `${dbPath}.bak`, `${dbPath}.tmp`]) {
      if (existsSync(path)) rmSync(path)
    }
  })

  it('recovers a durable account hold after a crash at the submission boundary', () => {
    const dbPath = join(tmpdir(), `pokebot-account-recovery-${Date.now()}-${Math.random()}.json`)
    const db = new JsonDb(dbPath)
    db.prepare('INSERT INTO accounts (id, name, retailer, status) VALUES (?, ?, ?, ?)').run(
      'account-recovery',
      'Recovery Account',
      'target',
      'verified'
    )
    db.prepare(
      `INSERT INTO drop_event_receipts
       (id, task_id, status, claimed_at, completed_at, account_id, order_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'receipt-recovery',
      'task-recovery',
      'submission_started',
      1000,
      1100,
      'account-recovery',
      1
    )
    const accountManager = {
      setStatus: (id, status) =>
        db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id)
    }

    new TaskManager({
      accountManager,
      notificationEngine: {},
      browserPool: {},
      getDb: () => db
    })
    const reloaded = new JsonDb(dbPath)

    expect(
      reloaded.prepare('SELECT * FROM accounts WHERE id = ?').get('account-recovery').status
    ).toBe('manual_review')
    db.close()
    reloaded.close()
    for (const path of [dbPath, `${dbPath}.bak`, `${dbPath}.tmp`]) {
      if (existsSync(path)) rmSync(path)
    }
  })

  it('keeps the Walmart checkout context open when a queue deadline follows submission', async () => {
    const notify = { fire: vi.fn() }
    const browserPool = { launch: vi.fn(), close: vi.fn() }
    const queueJoiner = { on: vi.fn(), stop: vi.fn(async () => {}) }
    const telemetry = {
      beginAttempt: vi.fn(() => 'attempt-1'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const dropEventLedger = {
      claim: vi.fn(() => ({ claimed: true, receiptId: 'queue-receipt' })),
      markSubmissionStarted: vi.fn(),
      complete: vi.fn()
    }
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => null),
        run: vi.fn()
      }))
    }
    const account = {
      id: 'account-1',
      name: 'Walmart Account',
      cvv: '123'
    }
    const manager = new TaskManager({
      accountManager: { getDecrypted: vi.fn(() => account) },
      notificationEngine: notify,
      browserPool,
      queueJoiner,
      checkoutTelemetry: telemetry,
      dropEventLedger,
      getDb: () => db,
      getSettings: () => ({}),
      queueCheckoutTimeoutMs: 5
    })
    manager._tasks.set('queue-task', {
      id: 'queue-task',
      retailer: 'walmart',
      product_url: 'https://www.walmart.com/ip/example/123456',
      product_name: 'Pokemon Cards',
      account_ids: JSON.stringify(['account-1']),
      mode: 'monitor-and-buy',
      buy_limit: 1
    })
    runWalmartFlow.mockImplementationOnce(async (_context, options) => {
      await options.onBeforeSubmit()
      return new Promise(() => {})
    })

    await manager._onQueueTurn({
      id: 'queue-task',
      label: 'Pokemon Cards',
      status: { itemName: 'Pokemon Cards', queueCycleId: 'walmart-queue:ticket-123' },
      context: {}
    })

    expect(dropEventLedger.claim).toHaveBeenCalledWith({
      taskId: 'queue-task',
      dropCycleId: 'walmart-queue:ticket-123',
      retailer: 'walmart'
    })
    expect(browserPool.close).not.toHaveBeenCalled()
    expect(dropEventLedger.markSubmissionStarted).toHaveBeenCalledWith('queue-receipt', {
      accountId: 'account-1',
      orderSequence: 1
    })
    expect(telemetry.completeAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        terminal: true,
        submissionUncertain: true,
        requiresManualCheckout: true
      })
    )
    expect(notify.fire).toHaveBeenLastCalledWith(
      expect.objectContaining({
        productName: expect.stringContaining('ORDER STATUS UNCERTAIN - MANUAL REVIEW')
      })
    )
  })

  it('prevents a detached Walmart queue flow from submitting after its deadline', async () => {
    const notify = { fire: vi.fn() }
    const queueJoiner = { on: vi.fn(), stop: vi.fn(async () => {}) }
    const dropEventLedger = {
      claim: vi.fn(() => ({ claimed: true, receiptId: 'queue-receipt' })),
      markSubmissionStarted: vi.fn(),
      complete: vi.fn()
    }
    const manager = new TaskManager({
      accountManager: {
        getDecrypted: vi.fn(() => ({
          id: 'account-1',
          name: 'Walmart Account',
          status: 'verified'
        }))
      },
      notificationEngine: notify,
      browserPool: { close: vi.fn() },
      queueJoiner,
      dropEventLedger,
      getDb: () => ({
        prepare: vi.fn(() => ({
          get: vi.fn(() => null),
          all: vi.fn(() => []),
          run: vi.fn()
        }))
      }),
      queueCheckoutTimeoutMs: 5
    })
    manager._tasks.set('queue-task', {
      id: 'queue-task',
      retailer: 'walmart',
      product_url: 'https://www.walmart.com/ip/example/123456',
      product_name: 'Pokemon Cards',
      account_ids: JSON.stringify(['account-1']),
      mode: 'monitor-and-buy'
    })
    runWalmartFlow.mockImplementationOnce(async (_context, options) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await options.onBeforeSubmit()
      return { success: true }
    })

    await manager._onQueueTurn({
      id: 'queue-task',
      status: { queueCycleId: 'walmart-queue:late-ticket' },
      context: {}
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(dropEventLedger.markSubmissionStarted).not.toHaveBeenCalled()
    expect(dropEventLedger.complete).toHaveBeenCalledWith(
      'queue-receipt',
      expect.objectContaining({ status: 'failed' })
    )
    expect(queueJoiner.stop).toHaveBeenCalledWith('queue-task')
  })

  it('does not run two products through the same account context concurrently', async () => {
    const { manager } = makeTaskManager()
    let finishFirst
    runTargetFlow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () =>
            resolve({ success: true, testMode: true, requiresManualCheckout: true })
        })
    )
    const task = {
      id: 'task-a',
      retailer: 'target',
      product_name: 'Product A',
      product_url: 'https://www.target.com/p/example/A-111',
      account_ids: JSON.stringify(['account-1']),
      buy_limit: 1,
      orders_per_drop: 1,
      mode: 'test-checkout'
    }
    const first = manager._runOrdersForAccount(
      runTargetFlow,
      task,
      {
        retailer: 'target',
        productName: 'Product A',
        productUrl: task.product_url,
        dropType: 'in_stock'
      },
      'account-1'
    )
    await vi.waitFor(() => expect(runTargetFlow).toHaveBeenCalledTimes(1))

    const second = await manager._runOrdersForAccount(
      runTargetFlow,
      { ...task, id: 'task-b', product_url: 'https://www.target.com/p/example/A-222' },
      {
        retailer: 'target',
        productName: 'Product B',
        productUrl: 'https://www.target.com/p/example/A-222',
        dropType: 'in_stock'
      },
      'account-1'
    )

    expect(second).toMatchObject({
      success: false,
      accountBusy: true,
      error: expect.stringContaining('Account is busy')
    })
    expect(runTargetFlow).toHaveBeenCalledTimes(1)
    finishFirst()
    await first
  })

  it('records production-path contention before _runFlowsForTask returns busy', async () => {
    const telemetry = {
      beginAttempt: vi.fn().mockReturnValueOnce('attempt-1').mockReturnValueOnce('attempt-2'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const { manager } = makeTaskManager({}, {}, { checkoutTelemetry: telemetry })
    let finishFirst
    runTargetFlow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () =>
            resolve({ success: true, testMode: true, requiresManualCheckout: true })
        })
    )
    const task = {
      id: 'task-a',
      retailer: 'target',
      product_name: 'Product A',
      product_url: 'https://www.target.com/p/example/A-111',
      account_ids: JSON.stringify(['account-1']),
      orders_per_drop: 1,
      mode: 'test-checkout'
    }
    const first = manager._runFlowsForTask(task, {
      retailer: 'target',
      productName: 'Product A',
      productUrl: task.product_url,
      dropType: 'in_stock'
    })
    await vi.waitFor(() => expect(runTargetFlow).toHaveBeenCalledTimes(1))

    const second = await manager._runFlowsForTask(
      { ...task, id: 'task-b' },
      {
        retailer: 'target',
        productName: 'Product B',
        productUrl: 'https://www.target.com/p/example/A-222',
        dropType: 'in_stock'
      }
    )

    expect(second.results[0]).toMatchObject({ success: false, accountBusy: true })
    expect(telemetry.beginAttempt).toHaveBeenCalledTimes(2)
    expect(telemetry.recordLease).toHaveBeenCalledWith(
      'attempt-2',
      'busy',
      expect.objectContaining({ ownerId: 'attempt-1' })
    )
    expect(telemetry.completeAttempt).toHaveBeenCalledWith(
      'attempt-2',
      expect.objectContaining({ accountBusy: true })
    )
    finishFirst()
    await first
  })

  it('rejects a standard Walmart checkout while a queue checkout owns the account', async () => {
    const telemetry = {
      beginAttempt: vi
        .fn()
        .mockReturnValueOnce('queue-attempt')
        .mockReturnValueOnce('standard-attempt'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const queueJoiner = { on: vi.fn(), stop: vi.fn(async () => {}) }
    const dropEventLedger = {
      claim: vi.fn(() => ({ claimed: true, receiptId: 'queue-receipt' })),
      markSubmissionStarted: vi.fn(),
      complete: vi.fn()
    }
    const { manager } = makeTaskManager(
      {},
      { name: 'Walmart Account' },
      { checkoutTelemetry: telemetry, queueJoiner, dropEventLedger }
    )
    const queueTask = {
      id: 'queue-task',
      retailer: 'walmart',
      product_name: 'Queue Product',
      product_url: 'https://www.walmart.com/ip/queue-product/111',
      account_ids: JSON.stringify(['account-1']),
      buy_limit: 1,
      mode: 'monitor-and-buy'
    }
    manager._tasks.set(queueTask.id, queueTask)
    let finishQueue
    runWalmartFlow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQueue = () => resolve({ success: true })
        })
    )

    const queueCheckout = manager._onQueueTurn({
      id: queueTask.id,
      status: { itemName: 'Queue Product', queueCycleId: 'walmart-queue:queue-111' },
      context: {}
    })
    await vi.waitFor(() => expect(runWalmartFlow).toHaveBeenCalledTimes(1))

    const standard = await manager._runFlowsForTask(
      {
        ...queueTask,
        id: 'standard-task',
        product_name: 'Standard Product',
        product_url: 'https://www.walmart.com/ip/standard-product/222'
      },
      {
        retailer: 'walmart',
        productName: 'Standard Product',
        productUrl: 'https://www.walmart.com/ip/standard-product/222',
        dropType: 'in_stock'
      }
    )

    expect(standard.results[0]).toMatchObject({ success: false, accountBusy: true })
    expect(runWalmartFlow).toHaveBeenCalledTimes(1)
    expect(telemetry.recordLease).toHaveBeenCalledWith(
      'standard-attempt',
      'busy',
      expect.objectContaining({ ownerId: 'queue-attempt' })
    )
    finishQueue()
    await queueCheckout
  })

  it('does not start a Walmart queue checkout while a standard checkout owns the account', async () => {
    const telemetry = {
      beginAttempt: vi.fn(() => 'standard-attempt'),
      record: vi.fn(),
      recordLease: vi.fn(),
      completeAttempt: vi.fn()
    }
    const queueJoiner = { on: vi.fn(), stop: vi.fn(async () => {}) }
    const dropEventLedger = {
      claim: vi.fn(() => ({ claimed: true, receiptId: 'queue-receipt' })),
      markSubmissionStarted: vi.fn(),
      complete: vi.fn()
    }
    const { manager, notify } = makeTaskManager(
      {},
      { name: 'Walmart Account' },
      { checkoutTelemetry: telemetry, queueJoiner, dropEventLedger }
    )
    let finishStandard
    runWalmartFlow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStandard = () =>
            resolve({ success: true, testMode: true, requiresManualCheckout: true })
        })
    )
    const standardTask = {
      id: 'standard-task',
      retailer: 'walmart',
      product_name: 'Standard Product',
      product_url: 'https://www.walmart.com/ip/standard-product/222',
      account_ids: JSON.stringify(['account-1']),
      buy_limit: 1,
      mode: 'test-checkout'
    }
    const standardCheckout = manager._runFlowsForTask(standardTask, {
      retailer: 'walmart',
      productName: 'Standard Product',
      productUrl: standardTask.product_url,
      dropType: 'in_stock'
    })
    await vi.waitFor(() => expect(runWalmartFlow).toHaveBeenCalledTimes(1))
    manager._tasks.set('queue-task', {
      ...standardTask,
      id: 'queue-task',
      product_name: 'Queue Product',
      product_url: 'https://www.walmart.com/ip/queue-product/111',
      mode: 'monitor-and-buy'
    })

    await manager._onQueueTurn({
      id: 'queue-task',
      status: { itemName: 'Queue Product', queueCycleId: 'walmart-queue:queue-111' },
      context: {}
    })

    expect(runWalmartFlow).toHaveBeenCalledTimes(1)
    expect(dropEventLedger.claim).not.toHaveBeenCalled()
    expect(notify.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        productName: expect.stringContaining('account is already checking out another item')
      })
    )
    finishStandard()
    await standardCheckout
  })

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
    expect(browserPool.launch).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({
        profilePath: 'profile-1',
        proxy: '',
        retailer: 'target',
        priority: 100
      })
    )
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
        targetCheckoutLiteMode: true,
        targetCommitNavigationEnabled: true
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
        targetCommitNavigationEnabled: true,
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
    expect(browserPool.launch).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({
        profilePath: 'profile-1',
        proxy: '',
        retailer: 'walmart',
        priority: 100
      })
    )
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
