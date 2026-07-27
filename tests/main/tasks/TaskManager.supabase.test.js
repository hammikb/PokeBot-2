import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, rmSync } from 'fs'

vi.mock('../../../src/main/automation/flows/walmart.js', () => ({ runWalmartFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/target.js', () => ({ runTargetFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/pokemon-center.js', () => ({
  runPokemonCenterFlow: vi.fn()
}))
vi.mock('../../../src/main/automation/flows/costco.js', () => ({ runCostcoFlow: vi.fn() }))

import { TaskManager } from '../../../src/main/tasks/TaskManager.js'
import { JsonDb } from '../../../src/main/db.js'

function makeFakeSource() {
  const source = new EventEmitter()
  source.addProduct = vi.fn(async () => ({ subscribed: true, productId: 'prod-1' }))
  source.unsubscribe = vi.fn(async () => {})
  source.releaseChannel = vi.fn(async () => {})
  source.stop = vi.fn(async () => {})
  return source
}

function makeStubDb() {
  return {
    prepare: vi.fn(() => ({
      run: vi.fn(() => ({ changes: 1 })),
      get: vi.fn(() => null),
      all: vi.fn(() => [])
    }))
  }
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

function makeManager() {
  const source = makeFakeSource()
  const db = {
    prepare: vi.fn((sql) => ({
      run: vi.fn(),
      get: vi.fn(() => (sql.includes('monitor_unsubscribe_outbox') ? null : TARGET_TASK)),
      all: vi.fn(() => (sql.includes('monitor_unsubscribe_outbox') ? [] : [TARGET_TASK]))
    }))
  }
  const manager = new TaskManager({
    accountManager: { getDecrypted: vi.fn() },
    notificationEngine: { fire: vi.fn() },
    browserPool: { launch: vi.fn(), close: vi.fn() },
    getDb: () => db,
    getSettings: () => ({}),
    encryptionKey: Buffer.alloc(32),
    createSupabaseSource: async () => source
  })
  return { manager, source }
}

describe('TaskManager central monitoring', () => {
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
      getDb: () => makeStubDb(),
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

  it('subscribes the product through Supabase instead of polling locally', async () => {
    const { manager, source } = makeManager()
    await manager.startTask(TARGET_TASK)
    expect(source.addProduct).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      productName: 'Pokemon ETB',
      maxPrice: 40
    })
  })

  it("always routes Sam's Club monitoring through the Pi while checkout remains local", async () => {
    const { manager, source } = makeManager()
    await manager.startTask(SAMSCLUB_TASK)
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
      getDb: () => makeStubDb(),
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
      getDb: () => makeStubDb(),
      getSettings: () => ({}),
      createSupabaseSource,
      pokemonCenterQueueJoiner: { start: vi.fn(), stop: vi.fn(async () => {}) }
    })

    expect(await manager.setPokemonCenterAutoJoin(true)).toMatchObject({ connected: false })
    expect(await manager.setPokemonCenterAutoJoin(true)).toEqual({ enabled: true, connected: true })
    expect(createSupabaseSource).toHaveBeenCalledTimes(2)
  })

  it('routes a supabase drop into the checkout path (emits drop)', async () => {
    const { manager, source } = makeManager()
    const drops = []
    manager.on('drop', (e) => drops.push(e))
    await manager.startTask(TARGET_TASK)

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
    const { manager, source } = makeManager()
    const statuses = []
    manager.on('taskStatus', (event) => statuses.push(event))

    await manager.startTask(TARGET_TASK)
    statuses.length = 0

    await manager.startTask(TARGET_TASK)

    expect(statuses).toEqual([{ taskId: 'task-1', status: 'monitoring' }])
    expect(source.addProduct).toHaveBeenCalledTimes(1)
  })

  it('stopTask unsubscribes centrally (explicit stop means stop watching)', async () => {
    const { manager, source } = makeManager()
    await manager.startTask(TARGET_TASK)

    await manager.stopTask('task-1')

    expect(source.unsubscribe).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414'
    })
  })

  it('stopAll({ unsubscribe: false }) releases channels but keeps subscriptions (app quit)', async () => {
    const { manager, source } = makeManager()
    await manager.startTask(TARGET_TASK)

    await manager.stopAll({ unsubscribe: false })

    expect(source.unsubscribe).not.toHaveBeenCalled()
    expect(source.releaseChannel).toHaveBeenCalledWith('https://www.target.com/p/A-94336414')
  })

  it('unsubscribeCentral removes the subscription for a task that is not running', async () => {
    const { manager, source } = makeManager()

    await manager.unsubscribeCentral(TARGET_TASK)

    expect(source.unsubscribe).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414'
    })
  })

  it('uses central monitoring even when an obsolete local setting remains in the database', async () => {
    const { manager, source } = makeManager()
    manager._getSettings = () => ({ monitorMode: 'local' })

    await manager.startTask(TARGET_TASK)

    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    expect(manager._tasks.get(TARGET_TASK.id).source).toBe('supabase')
  })

  it('removes a failed start from active state so Start can retry successfully', async () => {
    const { manager, source } = makeManager()
    source.addProduct
      .mockRejectedValueOnce(new Error('temporary subscription failure'))
      .mockResolvedValueOnce({ subscribed: true, productId: 'prod-1' })

    await expect(manager.startTask(TARGET_TASK)).rejects.toThrow('temporary subscription failure')
    expect(manager.getActiveTasks()).toEqual([])

    await expect(manager.startTask(TARGET_TASK)).resolves.toBe(true)
    expect(manager.getActiveTasks()).toEqual(['task-1'])
    expect(source.addProduct).toHaveBeenCalledTimes(2)
  })

  it('treats a non-subscribed source result as a retryable start failure', async () => {
    const { manager, source } = makeManager()
    source.addProduct.mockResolvedValueOnce({ subscribed: false })

    await expect(manager.startTask(TARGET_TASK)).rejects.toThrow(
      'central monitor did not create a product subscription'
    )
    expect(manager.getActiveTasks()).toEqual([])
  })

  it('rejects URL aliases for a product that already has an active task', async () => {
    const { manager, source } = makeManager()
    await manager.startTask(TARGET_TASK)

    await expect(
      manager.startTask({
        ...TARGET_TASK,
        id: 'task-alias',
        product_url:
          'https://www.target.com/p/different-slug/-/A-94336414?preselect=94336414#details'
      })
    ).rejects.toThrow('already monitored')
    expect(source.addProduct).toHaveBeenCalledTimes(1)
  })

  it('serializes a rapid Stop then Start before creating the replacement subscription', async () => {
    const { manager, source } = makeManager()
    await manager.startTask(TARGET_TASK)
    let releaseUnsubscribe
    source.unsubscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUnsubscribe = resolve
        })
    )

    const stopping = manager.stopTask(TARGET_TASK.id)
    await vi.waitFor(() => expect(source.unsubscribe).toHaveBeenCalledTimes(1))
    const restarting = manager.startTask(TARGET_TASK)
    await Promise.resolve()
    expect(source.addProduct).toHaveBeenCalledTimes(1)

    releaseUnsubscribe()
    await stopping
    await restarting

    expect(source.addProduct).toHaveBeenCalledTimes(2)
  })

  it('does not replay another user’s pending central monitor stops', async () => {
    const dbPath = join(tmpdir(), `pokebot-outbox-user-${Date.now()}-${Math.random()}.json`)
    const db = new JsonDb(dbPath)
    const source = makeFakeSource()
    const authSessionManager = {
      getStatus: vi.fn(() => ({ authenticated: true, user: { id: 'user-b' } }))
    }
    db.prepare(
      `INSERT INTO monitor_unsubscribe_outbox
        (id, user_id, retailer, product_url, product_key, created_at, attempts, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'user-a:target:94336414',
      'user-a',
      'target',
      TARGET_TASK.product_url,
      '94336414',
      Date.now(),
      0,
      null
    )
    const manager = new TaskManager({
      accountManager: { getDecrypted: vi.fn() },
      notificationEngine: { fire: vi.fn() },
      browserPool: {},
      getDb: () => db,
      getSettings: () => ({}),
      authSessionManager,
      createSupabaseSource: async () => source
    })

    await expect(manager.retryPendingUnsubscribes()).resolves.toEqual({
      pending: 0,
      cleared: 0
    })
    expect(source.unsubscribe).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM monitor_unsubscribe_outbox').all()).toHaveLength(1)

    db.close()
    for (const suffix of ['', '.bak', '.tmp']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`)
    }
  })

  it('closes the old monitor source and rebinds active tasks after the signed-in user changes', async () => {
    let authState = { authenticated: true, user: { id: 'user-a' } }
    const sourceA = makeFakeSource()
    const sourceB = makeFakeSource()
    const createSupabaseSource = vi
      .fn()
      .mockResolvedValueOnce(sourceA)
      .mockResolvedValueOnce(sourceB)
    const manager = new TaskManager({
      accountManager: { getDecrypted: vi.fn() },
      notificationEngine: { fire: vi.fn() },
      browserPool: {},
      getDb: () => makeStubDb(),
      getSettings: () => ({}),
      authSessionManager: { getStatus: vi.fn(() => authState) },
      createSupabaseSource
    })
    await manager.startTask(TARGET_TASK)

    authState = { authenticated: true, user: { id: 'user-b' } }
    await expect(manager.handleAuthChange(authState)).resolves.toMatchObject({
      authenticated: true,
      rebound: 1
    })

    expect(sourceA.stop).toHaveBeenCalledTimes(1)
    expect(sourceB.addProduct).toHaveBeenCalledWith(
      expect.objectContaining({ productUrl: TARGET_TASK.product_url })
    )
    expect(createSupabaseSource).toHaveBeenCalledTimes(2)
  })
})
