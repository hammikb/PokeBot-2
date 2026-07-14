import { describe, expect, it } from 'vitest'
import { SupabaseMonitorSource } from '../../../src/main/monitor/SupabaseMonitorSource.js'

// Fake supabase client. Captures upserts, channel creation, and lets the test
// fire a broadcast into the registered handler.
function makeFakeClient({
  product,
  userId = 'user-1',
  registerResult = { data: { id: 'prod-new' }, error: null }
}) {
  const calls = { upserts: [], registerCalls: [], deletes: [], channels: [], removed: 0 }
  let dropHandler = null
  const client = {
    from: (table) => {
      if (table === 'products') {
        return {
          select: () => ({
            match: () => ({ maybeSingle: async () => ({ data: product, error: null }) })
          }),
          upsert: (row, opts) => {
            calls.registerCalls.push({ row, opts })
            return { select: () => ({ single: async () => registerResult }) }
          }
        }
      }
      return {
        upsert: async (row, opts) => {
          calls.upserts.push({ table, row, opts })
          return { error: null }
        },
        delete: () => ({
          eq: async (column, value) => {
            calls.deletes.push({ table, column, value })
            return { error: null }
          }
        })
      }
    },
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    channel: (name, opts) => {
      const ch = {
        name,
        opts,
        on: (type, filter, cb) => {
          if (type === 'broadcast') dropHandler = cb
          return ch
        },
        subscribe: async () => ch
      }
      calls.channels.push(ch)
      return ch
    },
    removeChannel: async () => {
      calls.removed += 1
    }
  }
  return { client, calls, fireDrop: (payload) => dropHandler({ payload }) }
}

const SEED = { id: 'prod-1' }

describe('SupabaseMonitorSource', () => {
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
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock'
    })

    expect(drops).toEqual([
      {
        retailer: 'target',
        productName: 'Pokemon ETB',
        productUrl: 'https://www.target.com/p/A-94336414',
        price: 49.99,
        dropType: 'in_stock'
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
    expect(calls.registerCalls[0]).toMatchObject({
      row: {
        retailer: 'target',
        product_key: '99999999',
        product_url: 'https://www.target.com/p/A-99999999',
        name: 'Some New Item',
        active: true
      },
      opts: { onConflict: 'retailer,product_key' }
    })
    expect(calls.channels[0].name).toBe('drops:product:prod-new')
  })

  it('emits a notice and does not subscribe when self-registration fails', async () => {
    const { client, calls } = makeFakeClient({
      product: null,
      registerResult: { data: null, error: { message: 'permission denied' } }
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

  it('removeProduct deletes the subscription row and unsubscribes the channel', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    await source.removeProduct('https://www.target.com/p/A-94336414')
    expect(calls.deletes).toEqual([
      { table: 'subscriptions', column: 'product_id', value: 'prod-1' }
    ])
    expect(calls.removed).toBe(1)
  })
})
