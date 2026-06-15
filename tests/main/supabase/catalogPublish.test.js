import { describe, expect, it, vi } from 'vitest'
import {
  mapCatalogItemToProductRow,
  pushCatalogItemToSupabase
} from '../../../src/main/supabase/catalogPublish.js'

const ITEM = {
  retailer: 'target',
  retailer_item_id: '94336414',
  product_url: 'https://www.target.com/p/A-94336414',
  title: 'Pokemon ETB'
}

describe('mapCatalogItemToProductRow', () => {
  it('maps a catalog row to the products upsert payload', () => {
    expect(mapCatalogItemToProductRow(ITEM)).toEqual({
      retailer: 'target',
      product_url: 'https://www.target.com/p/A-94336414',
      product_key: '94336414',
      name: 'Pokemon ETB',
      active: true
    })
  })
})

describe('pushCatalogItemToSupabase', () => {
  it('upserts on (retailer, product_key) and returns the product id', async () => {
    const upsert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: { id: 'prod-1' }, error: null }) })
    }))
    const client = { from: vi.fn(() => ({ upsert })) }

    const result = await pushCatalogItemToSupabase({ client, item: ITEM })

    expect(client.from).toHaveBeenCalledWith('products')
    expect(upsert).toHaveBeenCalledWith(
      {
        retailer: 'target',
        product_url: 'https://www.target.com/p/A-94336414',
        product_key: '94336414',
        name: 'Pokemon ETB',
        active: true
      },
      { onConflict: 'retailer,product_key' }
    )
    expect(result).toEqual({ productId: 'prod-1' })
  })

  it('throws a clear error when the upsert fails', async () => {
    const upsert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: null, error: { message: 'denied' } }) })
    }))
    const client = { from: vi.fn(() => ({ upsert })) }
    await expect(pushCatalogItemToSupabase({ client, item: ITEM })).rejects.toThrow(
      'Supabase product publish failed: denied'
    )
  })
})
