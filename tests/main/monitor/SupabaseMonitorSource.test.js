import { afterEach, describe, expect, it, vi } from 'vitest'
import { SupabaseMonitorSource } from '../../../src/main/monitor/SupabaseMonitorSource.js'

// Fake supabase client. Captures upserts/inserts, channel creation, and lets the test
// fire a broadcast into the registered handler.
function makeFakeClient({
  product,
  productById = null,
  refetchResult = product,
  userId = 'user-1',
  userError = null,
  subscriptionError = null,
  productLookupError = null,
  deleteError = null,
  insertResult = { data: { id: 'prod-new' }, error: null },
  dropRows = [],
  dropQueryError = null,
  inventoryRows = [],
  inventoryQueryError = null,
  closeOnRemove = false
}) {
  const calls = {
    upserts: [],
    insertCalls: [],
    deletes: [],
    channels: [],
    dropQueries: [],
    removed: 0,
    inventoryQueries: []
  }
  let selectCallCount = 0
  const client = {
    from: (table) => {
      if (table === 'products') {
        const productSelection = () => ({
          match: () => ({
            maybeSingle: async () => {
              selectCallCount += 1
              // First lookup returns `product`; a second lookup (the race-recovery
              // re-fetch after a 23505) returns `refetchResult`.
              return {
                data: selectCallCount === 1 ? product : refetchResult,
                error: productLookupError
              }
            }
          }),
          eq: () => ({
            maybeSingle: async () => ({
              data: productById,
              error: productLookupError
            })
          })
        })
        return {
          select: productSelection,
          insert: (row) => {
            calls.insertCalls.push({ row })
            return { select: () => ({ single: async () => insertResult }) }
          }
        }
      }
      if (table === 'drops') {
        return {
          select: (columns) => {
            const filters = {}
            const orders = []
            const query = {
              eq: (column, value) => {
                filters[column] = value
                return query
              },
              gte: (column, value) => {
                filters[`${column}_gte`] = value
                return query
              },
              order: (column, options) => {
                orders.push({ column, options })
                return query
              },
              limit: async (limit) => {
                calls.dropQueries.push({ columns, filters, orders, limit })
                const rows = dropRows
                  .filter(
                    (row) =>
                      (!filters.product_id || row.product_id === filters.product_id) &&
                      (!filters.retailer || row.retailer === filters.retailer) &&
                      (!filters.drop_type || row.drop_type === filters.drop_type) &&
                      (!filters.created_at_gte || row.created_at >= filters.created_at_gte)
                  )
                  .slice(0, limit)
                return { data: rows, error: dropQueryError }
              }
            }
            return query
          }
        }
      }
      if (table === 'target_inventory_observations') {
        return {
          select: (columns) => {
            const filters = {}
            const orders = []
            const query = {
              eq: (column, value) => {
                filters[column] = value
                return query
              },
              order: (column, options) => {
                orders.push({ column, options })
                return query
              },
              limit: async (limit) => {
                calls.inventoryQueries.push({ columns, filters, orders, limit })
                const rows = inventoryRows
                  .filter((row) => !filters.tcin || row.tcin === filters.tcin)
                  .sort((left, right) => String(right.observed_at).localeCompare(String(left.observed_at)))
                  .slice(0, limit)
                return { data: rows, error: inventoryQueryError }
              }
            }
            return query
          }
        }
      }
      return {
        upsert: async (row, opts) => {
          calls.upserts.push({ table, row, opts })
          return { error: subscriptionError }
        },
        delete: () => ({
          eq: async (column, value) => {
            calls.deletes.push({ table, column, value })
            return { error: deleteError }
          }
        })
      }
    },
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userError
      })
    },
    channel: (name, opts) => {
      const ch = {
        name,
        opts,
        handlers: new Map(),
        on: (type, filter, cb) => {
          if (type === 'broadcast') ch.handlers.set(filter.event, cb)
          return ch
        },
        subscribe: (callback) => {
          ch.statusCallback = callback
          callback?.('SUBSCRIBED')
          return ch
        }
      }
      calls.channels.push(ch)
      return ch
    },
    removeChannel: async (channel) => {
      calls.removed += 1
      if (closeOnRemove) channel?.statusCallback?.('CLOSED')
    }
  }
  return {
    client,
    calls,
    fireDrop: (payload, index = calls.channels.length - 1) =>
      calls.channels[index]?.handlers.get('drop')?.({ payload }),
    broadcast: (event, payload, index = calls.channels.length - 1) =>
      calls.channels[index]?.handlers.get(event)?.({ payload }),
    emitStatus: (status, error, index = calls.channels.length - 1) =>
      calls.channels[index]?.statusCallback?.(status, error)
  }
}

const SEED = { id: 'prod-1' }
const TARGET_PRODUCT = {
  productUrl: 'https://www.target.com/p/A-94336414',
  retailer: 'target',
  productKey: '94336414',
  maxPrice: null
}

describe('SupabaseMonitorSource', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('resolves the product, subscribes the private topic, and ensures a subscription', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })

    const result = await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })

    expect(result).toEqual({ subscribed: true, productId: 'prod-1' })
    expect(calls.upserts[0]).toMatchObject({
      table: 'subscriptions',
      row: { user_id: 'user-1', product_id: 'prod-1' }
    })
    expect(calls.channels[0].name).toBe('drops:product:prod-1')
    expect(calls.channels[0].opts).toEqual({ config: { private: true } })
  })

  it('subscribes to the private Walmart queue feed, hydrates products, and deduplicates alerts', async () => {
    const productById = {
      product_url: 'https://www.walmart.com/ip/19965460207',
      product_key: '19965460207',
      name: 'Destined Rivals Elite Trainer Box'
    }
    const { client, calls, fireDrop } = makeFakeClient({
      product: SEED,
      productById
    })
    const source = new SupabaseMonitorSource({ client })
    const drops = []
    source.on('drop', (event) => drops.push(event))

    await expect(source.subscribeWalmartQueueFeed()).resolves.toEqual({
      subscribed: true,
      topic: 'drops:retailer:walmart:queues'
    })
    expect(calls.channels[0].name).toBe('drops:retailer:walmart:queues')
    expect(calls.channels[0].opts).toEqual({ config: { private: true } })

    const payload = {
      id: 'queue-drop-1',
      product_id: 'prod-walmart-1',
      retailer: 'walmart',
      name: 'Destined Rivals Elite Trainer Box',
      price: 65,
      drop_type: 'queue_open',
      created_at: '2026-07-30T01:19:31.119Z'
    }
    fireDrop(payload)
    fireDrop(payload)

    await vi.waitFor(() => expect(drops).toHaveLength(1))
    expect(drops[0]).toMatchObject({
      retailer: 'walmart',
      productName: 'Destined Rivals Elite Trainer Box',
      productUrl: 'https://www.walmart.com/ip/19965460207',
      productKey: '19965460207',
      dropType: 'queue_open',
      productId: 'prod-walmart-1',
      eventId: 'queue-drop-1'
    })

    await source.unsubscribeWalmartQueueFeed()
    expect(calls.removed).toBe(1)
  })

  it('fails startup when the authenticated subscription cannot be proven', async () => {
    const identityFailure = makeFakeClient({
      product: SEED,
      userId: null,
      userError: { message: 'session expired' }
    })
    const subscriptionFailure = makeFakeClient({
      product: SEED,
      subscriptionError: { message: 'permission denied' }
    })

    await expect(
      new SupabaseMonitorSource({ client: identityFailure.client }).addProduct({
        productUrl: 'https://www.target.com/p/A-94336414',
        retailer: 'target',
        productKey: '94336414'
      })
    ).rejects.toThrow('subscription identity is unavailable')
    await expect(
      new SupabaseMonitorSource({ client: subscriptionFailure.client }).addProduct({
        productUrl: 'https://www.target.com/p/A-94336414',
        retailer: 'target',
        productKey: '94336414'
      })
    ).rejects.toThrow('Supabase subscription failed: permission denied')
    expect(identityFailure.calls.channels).toHaveLength(0)
    expect(subscriptionFailure.calls.channels).toHaveLength(0)
  })

  it('emits a drop event (mapped to the local productUrl) when a broadcast arrives', async () => {
    const { client, fireDrop } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    const drops = []
    source.on('drop', (e) => drops.push(e))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    fireDrop({
      id: 'drop-live-1',
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock',
      created_at: '2026-07-27T02:00:00.000Z'
    })

    expect(drops).toEqual([
      {
        retailer: 'target',
        productName: 'Pokemon ETB',
        productUrl: 'https://www.target.com/p/A-94336414',
        price: 49.99,
        dropType: 'in_stock',
        productId: 'prod-1',
        eventId: 'drop-live-1',
        dropCycleId: 'drop-live-1',
        observedAt: '2026-07-27T02:00:00.000Z'
      }
    ])
  })

  it('drops the event when price exceeds the task max_price', async () => {
    const { client, fireDrop } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    const drops = []
    source.on('drop', (e) => drops.push(e))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: 40
    })
    fireDrop({
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock'
    })

    expect(drops).toEqual([])
  })

  it('replays recent durable drops oldest-first when the channel subscribes', async () => {
    const now = Date.parse('2026-07-27T02:05:00.000Z')
    const dropRows = [
      {
        id: 'drop-2',
        product_id: 'prod-1',
        retailer: 'target',
        name: 'Pokemon ETB',
        price: 49.99,
        drop_type: 'restock',
        created_at: '2026-07-27T02:04:00.000Z'
      },
      {
        id: 'drop-1',
        product_id: 'prod-1',
        retailer: 'target',
        name: 'Pokemon ETB',
        price: 49.99,
        drop_type: 'in_stock',
        created_at: '2026-07-27T02:02:00.000Z'
      },
      {
        id: 'other-product',
        product_id: 'prod-2',
        retailer: 'target',
        name: 'Other item',
        price: 10,
        drop_type: 'in_stock',
        created_at: '2026-07-27T02:03:00.000Z'
      }
    ]
    const { client, calls } = makeFakeClient({ product: SEED, dropRows })
    const source = new SupabaseMonitorSource({ client, now: () => now })
    const drops = []
    source.on('drop', (event) => drops.push(event))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })

    await vi.waitFor(() => expect(drops).toHaveLength(2))
    expect(drops.map((event) => event.eventId)).toEqual(['drop-1', 'drop-2'])
    expect(drops.map((event) => event.dropCycleId)).toEqual(['drop-1', 'drop-2'])
    expect(calls.dropQueries[0]).toMatchObject({
      filters: {
        product_id: 'prod-1',
        created_at_gte: '2026-07-27T02:00:00.000Z'
      },
      limit: 501
    })
    await vi.waitFor(() => {
      expect(source.getHealth()['https://www.target.com/p/A-94336414'].catchingUp).toBe(false)
    })
    expect(source.getHealth()['https://www.target.com/p/A-94336414']).toMatchObject({
      status: 'SUBSCRIBED',
      catchingUp: false,
      lastEventId: 'drop-2',
      lastObservedAt: '2026-07-27T02:04:00.000Z',
      lastDelivery: 'catch_up',
      lastCatchUpRecovered: 2,
      catchUpError: null
    })
  })

  it('deduplicates a durable drop delivered by both catch-up and Realtime', async () => {
    const row = {
      id: 'drop-shared',
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock',
      created_at: '2026-07-27T02:04:00.000Z'
    }
    const { client, fireDrop } = makeFakeClient({ product: SEED, dropRows: [row] })
    const source = new SupabaseMonitorSource({
      client,
      now: () => Date.parse('2026-07-27T02:05:00.000Z')
    })
    const drops = []
    source.on('drop', (event) => drops.push(event))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    fireDrop(row)
    fireDrop(row)

    await vi.waitFor(() => {
      expect(source.getHealth()['https://www.target.com/p/A-94336414'].catchingUp).toBe(false)
    })
    expect(drops).toHaveLength(1)
    expect(drops[0].eventId).toBe('drop-shared')
  })

  it('reports catch-up query failures without interrupting the live channel', async () => {
    const { client } = makeFakeClient({
      product: SEED,
      dropQueryError: { message: 'temporary database outage' }
    })
    const source = new SupabaseMonitorSource({ client })
    const healthEvents = []
    source.on('health', (health) => healthEvents.push(health))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })

    await vi.waitFor(() => {
      expect(source.getHealth()['https://www.target.com/p/A-94336414'].catchingUp).toBe(false)
    })
    expect(source.getHealth()['https://www.target.com/p/A-94336414']).toMatchObject({
      status: 'SUBSCRIBED',
      catchUpError: 'Supabase drop catch-up failed: temporary database outage'
    })
    expect(healthEvents).toContainEqual(
      expect.objectContaining({
        status: 'CATCH_UP_ERROR',
        channelStatus: 'SUBSCRIBED',
        catchUpError: 'Supabase drop catch-up failed: temporary database outage'
      })
    )
  })

  it('self-registers the product in Supabase when not already tracked centrally, then subscribes', async () => {
    const { client, calls } = makeFakeClient({ product: null })
    const source = new SupabaseMonitorSource({ client })

    const result = await source.addProduct({
      productUrl: 'https://www.target.com/p/A-99999999',
      retailer: 'target',
      productKey: '99999999',
      productName: 'Some New Item',
      maxPrice: null
    })

    expect(result).toEqual({ subscribed: true, productId: 'prod-new' })
    expect(calls.insertCalls[0]).toMatchObject({
      row: {
        retailer: 'target',
        product_key: '99999999',
        product_url: 'https://www.target.com/p/A-99999999',
        name: 'Some New Item',
        active: false
      }
    })
    expect(calls.channels[0].name).toBe('drops:product:prod-new')
  })

  it('re-fetches and subscribes when another caller registers the product first (race)', async () => {
    const { client, calls } = makeFakeClient({
      product: null,
      refetchResult: { id: 'prod-raced' },
      insertResult: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' }
      }
    })
    const source = new SupabaseMonitorSource({ client })

    const result = await source.addProduct({
      productUrl: 'https://www.target.com/p/A-99999999',
      retailer: 'target',
      productKey: '99999999',
      maxPrice: null
    })

    expect(result).toEqual({ subscribed: true, productId: 'prod-raced' })
    expect(calls.channels[0].name).toBe('drops:product:prod-raced')
  })

  it('emits a notice and does not subscribe when self-registration fails', async () => {
    const { client, calls } = makeFakeClient({
      product: null,
      insertResult: { data: null, error: { message: 'permission denied' } }
    })
    const source = new SupabaseMonitorSource({ client })
    const notices = []
    source.on('notice', (n) => notices.push(n))

    const result = await source.addProduct({
      productUrl: 'https://www.target.com/p/A-99999999',
      retailer: 'target',
      productKey: '99999999',
      maxPrice: null
    })

    expect(result).toEqual({ subscribed: false })
    expect(calls.channels).toHaveLength(0)
    expect(notices[0]).toMatchObject({
      productUrl: 'https://www.target.com/p/A-99999999',
      message: 'Could not register this product centrally: permission denied'
    })
  })

  it('unsubscribe deletes the subscription row and tears down the channel', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    await source.unsubscribe({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414'
    })
    expect(calls.deletes).toEqual([
      { table: 'subscriptions', column: 'product_id', value: 'prod-1' }
    ])
    expect(calls.removed).toBe(1)
  })

  it('unsubscribe works without an active channel by looking the product up by key', async () => {
    // A task deleted while not running never called addProduct this session,
    // so there is no channel entry — the subscription row must still go away
    // or the Pi keeps monitoring a product nobody is watching.
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })

    await source.unsubscribe({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414'
    })

    expect(calls.deletes).toEqual([
      { table: 'subscriptions', column: 'product_id', value: 'prod-1' }
    ])
    expect(calls.removed).toBe(0)
  })

  it('surfaces subscription delete failures instead of reporting a false stop', async () => {
    const { client } = makeFakeClient({
      product: SEED,
      deleteError: { message: 'network unavailable' }
    })
    const source = new SupabaseMonitorSource({ client })

    await expect(
      source.unsubscribe({
        productUrl: 'https://www.target.com/p/A-94336414',
        retailer: 'target',
        productKey: '94336414'
      })
    ).rejects.toThrow('Supabase unsubscribe failed: network unavailable')
  })

  it('surfaces fallback product lookup failures instead of silently skipping unsubscribe', async () => {
    const { client } = makeFakeClient({
      product: null,
      productLookupError: { message: 'permission denied' }
    })
    const source = new SupabaseMonitorSource({ client })

    await expect(
      source.unsubscribe({
        productUrl: 'https://www.target.com/p/A-94336414',
        retailer: 'target',
        productKey: '94336414'
      })
    ).rejects.toThrow('unsubscribe product lookup failed: permission denied')
  })

  it('stop() releases channels but keeps subscriptions (app quit is not "stop watching")', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })

    await source.stop()

    expect(calls.removed).toBe(1)
    expect(calls.deletes).toEqual([])
  })

  it('returns an extended gate for a valid post-drop in-stock inventory event', async () => {
    const { client, broadcast } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct(TARGET_PRODUCT)
    await vi.waitFor(() => expect(source.getHealth()[TARGET_PRODUCT.productUrl].catchingUp).toBe(false))

    broadcast('inventory', {
      product_id: 'prod-1',
      tcin: '94336414',
      available: true,
      observed_at: '2026-08-11T08:36:12.000Z'
    })

    expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:11.000Z'))
      .toMatchObject({ mode: 'extend', available: true })
  })

  it('stops for a newer out-of-stock observation and falls back for pre-drop evidence', async () => {
    const { client, broadcast } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct(TARGET_PRODUCT)
    await vi.waitFor(() => expect(source.getHealth()[TARGET_PRODUCT.productUrl].catchingUp).toBe(false))
    broadcast('inventory', {
      product_id: 'prod-1',
      tcin: '94336414',
      available: false,
      observed_at: '2026-08-11T08:36:12.000Z'
    })

    expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:11.000Z'))
      .toMatchObject({ mode: 'stop', available: false })
    expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:13.000Z'))
      .toMatchObject({ mode: 'fallback', reason: 'inventory-predates-drop' })
  })

  it('falls back while interrupted and restores an inventory gate after catch-up', async () => {
    let now = Date.parse('2026-08-11T08:36:20.000Z')
    const inventoryRows = [{
      tcin: '94336414',
      available: true,
      observed_at: '2026-08-11T08:36:12.000Z'
    }]
    const { client, emitStatus } = makeFakeClient({ product: SEED, inventoryRows })
    const source = new SupabaseMonitorSource({ client, now: () => now })
    await source.addProduct(TARGET_PRODUCT)
    await vi.waitFor(() => expect(source.getHealth()[TARGET_PRODUCT.productUrl].catchingUp).toBe(false))
    expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:11.000Z').mode)
      .toBe('extend')

    emitStatus('CHANNEL_ERROR', new Error('socket lost'))
    expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:11.000Z'))
      .toMatchObject({ mode: 'fallback', reason: 'channel-interrupted' })

    emitStatus('SUBSCRIBED')
    await vi.waitFor(() => expect(source.getHealth()[TARGET_PRODUCT.productUrl].interruptedAt).toBe(null))
    expect(source.getInventoryGate(TARGET_PRODUCT.productUrl, '2026-08-11T08:36:11.000Z').mode)
      .toBe('extend')
  })

  it('recovers only a current interrupted generation and ignores stale CLOSED callbacks', async () => {
    let now = 1_000
    const { client, calls, emitStatus } = makeFakeClient({
      product: SEED,
      closeOnRemove: true
    })
    const source = new SupabaseMonitorSource({ client, now: () => now })
    await source.addProduct(TARGET_PRODUCT)

    expect(source.getHealth()['https://www.target.com/p/A-94336414']).toMatchObject({
      productId: 'prod-1',
      status: 'SUBSCRIBED'
    })
    emitStatus('CHANNEL_ERROR', new Error('socket lost'))
    now += 30_000
    await expect(source.recoverInterruptedChannels({ minInterruptedMs: 30_000 }))
      .resolves.toEqual({ recovered: 1 })

    expect(calls.removed).toBe(1)
    expect(calls.channels).toHaveLength(2)
    expect(source.getHealth()['https://www.target.com/p/A-94336414'].status).toBe('SUBSCRIBED')
    await vi.waitFor(() => {
      expect(source.getHealth()['https://www.target.com/p/A-94336414'].interruptedAt).toBe(null)
    })
    emitStatus('CLOSED', undefined, 0)
    now += 30_000
    await expect(source.recoverInterruptedChannels({ minInterruptedMs: 30_000 }))
      .resolves.toEqual({ recovered: 0 })
    expect(calls.channels).toHaveLength(2)
    await source.stop()
  })

  it('catches up a row missed during a channel interruption and deduplicates cursor overlap', async () => {
    vi.useFakeTimers()
    let now = Date.parse('2026-07-27T02:05:00.000Z')
    const dropRows = []
    const { client, calls, fireDrop, emitStatus } = makeFakeClient({ product: SEED, dropRows })
    const source = new SupabaseMonitorSource({ client, now: () => now })
    const drops = []
    source.on('drop', (event) => drops.push(event))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    await vi.advanceTimersByTimeAsync(0)

    const deliveredBeforeDisconnect = {
      id: 'drop-before-disconnect',
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock',
      created_at: '2026-07-27T02:02:00.000Z'
    }
    fireDrop(deliveredBeforeDisconnect)
    dropRows.push(deliveredBeforeDisconnect, {
      id: 'drop-missed',
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'restock',
      created_at: '2026-07-27T02:03:00.000Z'
    })

    emitStatus('CHANNEL_ERROR', new Error('socket lost'))
    now += 30_000
    await source.recoverInterruptedChannels({ minInterruptedMs: 30_000 })
    await vi.advanceTimersByTimeAsync(0)

    expect(drops.map((event) => event.eventId)).toEqual(['drop-before-disconnect', 'drop-missed'])
    expect(calls.dropQueries).toHaveLength(2)
    expect(calls.dropQueries[1].filters.created_at_gte).toBe('2026-07-27T02:01:59.000Z')
    expect(source.getHealth()['https://www.target.com/p/A-94336414']).toMatchObject({
      status: 'SUBSCRIBED',
      lastEventId: 'drop-missed',
      lastDelivery: 'catch_up',
      lastCatchUpRecovered: 1
    })
    await source.stop()
  })
})
