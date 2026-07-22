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

const SAMSCLUB_TASK = {
  ...TARGET_TASK,
  id: 'task-samsclub',
  retailer: 'samsclub',
  product_url:
    'https://www.samsclub.com/ip/sv8-5-prismatic-evolutions-super-premium-collection/19170800669',
  product_name: 'Prismatic Evolutions Super Premium Collection'
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
  it('auto-joins the Pokemon Center queue without creating a task', async () => {
    const source = makeFakeSource()
    const pokemonCenterQueueJoiner = {
      start: vi.fn(),
      stop: vi.fn(async () => {})
    }
    const manager = new TaskManager({
      accountManager: { getAll: vi.fn(() => []), getDecrypted: vi.fn() },
      notificationEngine: { fire: vi.fn() },
      browserPool: {},
      getDb: () => ({ prepare: vi.fn() }),
      getSettings: () => ({}),
      createSupabaseSource: async () => source,
      pokemonCenterQueueJoiner
    })

    await manager.setPokemonCenterAutoJoin(true)
    expect(source.addProduct).toHaveBeenCalledWith({
      productUrl: 'https://www.pokemoncenter.com/',
      retailer: 'pokemon-center',
      productKey: 'site-queue',
      productName: 'Pokemon Center Queue',
      maxPrice: null
    })

    source.emit('drop', {
      retailer: 'pokemon-center',
      productName: 'Pokemon Center Queue',
      productUrl: 'https://www.pokemoncenter.com/',
      dropType: 'queue_open'
    })
    await vi.waitFor(() => expect(pokemonCenterQueueJoiner.start).toHaveBeenCalled())
    expect(pokemonCenterQueueJoiner.start).toHaveBeenCalledWith('pokemon-center-auto-join', {
      productUrl: 'https://www.pokemoncenter.com/',
      label: 'Pokemon Center Queue',
      account: null,
      browserMode: 'managed'
    })

    source.emit('drop', {
      retailer: 'pokemon-center',
      productName: 'Pokemon Center Queue',
      productUrl: 'https://www.pokemoncenter.com/',
      dropType: 'queue_open'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pokemonCenterQueueJoiner.start).toHaveBeenCalledTimes(1)

    await manager.setPokemonCenterAutoJoin(false)
    expect(pokemonCenterQueueJoiner.stop).toHaveBeenCalledWith('pokemon-center-auto-join')
    expect(source.unsubscribe).toHaveBeenCalledWith({
      productUrl: 'https://www.pokemoncenter.com/',
      retailer: 'pokemon-center',
      productKey: 'site-queue'
    })
  })

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

  it("always routes Sam's Club monitoring through the Pi while checkout remains local", async () => {
    const { manager, source } = makeManager('local')
    manager.startTask(SAMSCLUB_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    expect(source.addProduct).toHaveBeenCalledWith({
      productUrl: SAMSCLUB_TASK.product_url,
      retailer: 'samsclub',
      productKey: '19170800669',
      productName: SAMSCLUB_TASK.product_name,
      maxPrice: 40
    })
    expect(manager._tasks.get(SAMSCLUB_TASK.id).source).toBe('supabase')
  })

  it('keeps Pokemon Center auto-join armed while authentication is still restoring', async () => {
    const source = makeFakeSource()
    const manager = new TaskManager({
      accountManager: { getAll: vi.fn(() => []), getDecrypted: vi.fn() },
      notificationEngine: { fire: vi.fn() },
      browserPool: {},
      getDb: () => ({ prepare: vi.fn() }),
      getSettings: () => ({}),
      authSessionManager: { getStatus: vi.fn(() => ({ authenticated: false })) },
      createSupabaseSource: vi.fn(async () => source),
      pokemonCenterQueueJoiner: { start: vi.fn(), stop: vi.fn(async () => {}) }
    })

    await expect(manager.setPokemonCenterAutoJoin(true)).resolves.toEqual({
      enabled: true,
      connected: false,
      reason: 'auth-pending'
    })
    expect(manager.isPokemonCenterAutoJoinEnabled()).toBe(true)
    expect(source.addProduct).not.toHaveBeenCalled()
  })

  it('retries Supabase source creation after an early connection failure', async () => {
    const source = makeFakeSource()
    const createSupabaseSource = vi
      .fn()
      .mockRejectedValueOnce(new Error('Not signed in to Supabase yet'))
      .mockResolvedValueOnce(source)
    const manager = new TaskManager({
      accountManager: { getAll: vi.fn(() => []), getDecrypted: vi.fn() },
      notificationEngine: { fire: vi.fn() },
      browserPool: {},
      getDb: () => ({ prepare: vi.fn() }),
      getSettings: () => ({}),
      createSupabaseSource,
      pokemonCenterQueueJoiner: { start: vi.fn(), stop: vi.fn(async () => {}) }
    })

    expect(await manager.setPokemonCenterAutoJoin(true)).toMatchObject({ connected: false })
    expect(await manager.setPokemonCenterAutoJoin(true)).toEqual({ enabled: true, connected: true })
    expect(createSupabaseSource).toHaveBeenCalledTimes(2)
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

  it('re-emits monitoring when Start is clicked for an already resumed task', async () => {
    const { manager, source } = makeManager('supabase')
    const statuses = []
    manager.on('taskStatus', (event) => statuses.push(event))

    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    statuses.length = 0

    manager.startTask(TARGET_TASK)

    expect(statuses).toEqual([{ taskId: 'task-1', status: 'monitoring' }])
    expect(source.addProduct).toHaveBeenCalledTimes(1)
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
