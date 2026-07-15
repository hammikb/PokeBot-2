import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../../src/main/automation/flows/walmart.js', () => ({ runWalmartFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/target.js', () => ({ runTargetFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/pokemon-center.js', () => ({
  runPokemonCenterFlow: vi.fn()
}))
vi.mock('../../../src/main/automation/flows/costco.js', () => ({ runCostcoFlow: vi.fn() }))

import { TaskManager } from '../../../src/main/tasks/TaskManager.js'

function makeFakeSource() {
  const source = new EventEmitter()
  source.addProduct = vi.fn(async () => ({ subscribed: true, productId: 'prod-1' }))
  source.unsubscribe = vi.fn(async () => {})
  source.releaseChannel = vi.fn(async () => {})
  source.stop = vi.fn(async () => {})
  return source
}

const TARGET_TASK = {
  id: 'task-1',
  retailer: 'target',
  product_url: 'https://www.target.com/p/A-94336414',
  product_name: 'Pokemon ETB',
  max_price: 40,
  account_ids: '["account-1"]',
  interval_ms: 4000
}

function makeManager(monitorMode) {
  const source = makeFakeSource()
  const db = {
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(() => TARGET_TASK),
      all: vi.fn(() => [TARGET_TASK])
    }))
  }
  const manager = new TaskManager({
    accountManager: { getDecrypted: vi.fn() },
    notificationEngine: { fire: vi.fn() },
    browserPool: { launch: vi.fn(), close: vi.fn() },
    getDb: () => db,
    getSettings: () => ({ monitorMode }),
    encryptionKey: Buffer.alloc(32),
    createSupabaseSource: async () => source
  })
  return { manager, source }
}

describe('TaskManager monitor mode', () => {
  it('in supabase mode subscribes the product instead of polling', async () => {
    const { manager, source } = makeManager('supabase')
    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    expect(source.addProduct).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      productName: 'Pokemon ETB',
      maxPrice: 40
    })
  })

  it('routes a supabase drop into the checkout path (emits drop)', async () => {
    const { manager, source } = makeManager('supabase')
    const drops = []
    manager.on('drop', (e) => drops.push(e))
    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())

    source.emit('drop', {
      retailer: 'target',
      productName: 'Pokemon ETB',
      productUrl: 'https://www.target.com/p/A-94336414',
      price: 25,
      dropType: 'in_stock'
    })
    await vi.waitFor(() => expect(drops).toHaveLength(1))
  })

  it('stopTask unsubscribes centrally (explicit stop means stop watching)', async () => {
    const { manager, source } = makeManager('supabase')
    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())

    manager.stopTask('task-1')

    expect(source.unsubscribe).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414'
    })
  })

  it('stopAll({ unsubscribe: false }) releases channels but keeps subscriptions (app quit)', async () => {
    const { manager, source } = makeManager('supabase')
    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())

    manager.stopAll({ unsubscribe: false })

    expect(source.unsubscribe).not.toHaveBeenCalled()
    expect(source.releaseChannel).toHaveBeenCalledWith('https://www.target.com/p/A-94336414')
  })

  it('unsubscribeCentral removes the subscription for a task that is not running', async () => {
    const { manager, source } = makeManager('supabase')

    await manager.unsubscribeCentral(TARGET_TASK)

    expect(source.unsubscribe).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414'
    })
  })

  it('unsubscribeCentral is a no-op in local mode', async () => {
    const { manager, source } = makeManager('local')

    await manager.unsubscribeCentral(TARGET_TASK)

    expect(source.unsubscribe).not.toHaveBeenCalled()
  })

  it('setMonitorMode stops active tasks and restarts them under the new source', async () => {
    const { manager, source } = makeManager('local')
    manager.startTask(TARGET_TASK)
    expect(manager.getActiveTasks()).toContain('task-1')

    // getSettings is read fresh inside startTask; flip mode then restart.
    manager._getSettings = () => ({ monitorMode: 'supabase' })
    await manager.setMonitorMode('supabase')

    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    expect(manager.getActiveTasks()).toContain('task-1')
  })
})
