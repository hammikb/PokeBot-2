import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
import { initDb, getDb } from '../../../src/main/db.js'
import {
  addCatalogItemFromUrl,
  getCatalogItems,
  refreshCatalogItem
} from '../../../src/main/products/ProductCatalog.js'
import { lookupProduct } from '../../../src/main/products/ProductLookup.js'

vi.mock('../../../src/main/products/ProductLookup.js', () => ({
  lookupProduct: vi.fn()
}))

let dbPath

beforeEach(() => {
  vi.clearAllMocks()
  dbPath = join(tmpdir(), `pokebot-catalog-test-${Date.now()}.db`)
  initDb(dbPath)
})

afterEach(() => {
  getDb().close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}.json`, { force: true })
})

describe('ProductCatalog', () => {
  it('adds a Target product URL as a deduped catalog item', async () => {
    lookupProduct.mockResolvedValue({
      retailer: 'target',
      productUrl: 'https://www.target.com/p/guppy/A-95267143',
      canonicalUrl: 'https://www.target.com/p/pokemon-chaos-rising/-/A-95267143',
      productName: 'Pokemon Trading Card Game Chaos Rising Elite Trainer Box',
      price: 49.99,
      formattedPrice: '$49.99',
      imageUrl: 'https://target.scene7.com/image',
      availability: 'IN_STOCK',
      brand: 'Pokemon',
      category: 'Trading Cards'
    })

    const item = await addCatalogItemFromUrl(getDb, 'https://www.target.com/p/guppy/A-95267143')
    await addCatalogItemFromUrl(getDb, 'https://www.target.com/p/guppy/A-95267143')

    expect(item).toMatchObject({
      id: 'target:95267143',
      retailer: 'target',
      retailer_item_id: '95267143',
      id_type: 'TCIN',
      msrp: 59.99,
      seller: 'Target',
      retailer_owned_listing: 1
    })
    expect(getCatalogItems(getDb)).toHaveLength(1)
  })

  it('passes Scrapling fallback notifications into product lookup', async () => {
    const onScraplingFallback = vi.fn()
    lookupProduct.mockResolvedValue({
      retailer: 'target',
      productUrl: 'https://www.target.com/p/guppy/A-95267143',
      canonicalUrl: 'https://www.target.com/p/pokemon-chaos-rising/-/A-95267143',
      productName: 'Pokemon Trading Card Game Chaos Rising Elite Trainer Box'
    })

    await addCatalogItemFromUrl(getDb, 'https://www.target.com/p/guppy/A-95267143', {
      onScraplingFallback
    })

    expect(lookupProduct).toHaveBeenCalledWith('https://www.target.com/p/guppy/A-95267143', {
      onScraplingFallback
    })
  })

  it('refreshes an existing item with latest product data', async () => {
    lookupProduct
      .mockResolvedValueOnce({
        retailer: 'walmart',
        productUrl: 'https://www.walmart.com/ip/Pokemon-Booster/123456789',
        canonicalUrl: 'https://www.walmart.com/ip/123456789',
        productName: 'Pokemon Booster Bundle',
        price: 26.94,
        formattedPrice: '$26.94',
        availability: 'OUT_OF_STOCK'
      })
      .mockResolvedValueOnce({
        retailer: 'walmart',
        productUrl: 'https://www.walmart.com/ip/123456789',
        canonicalUrl: 'https://www.walmart.com/ip/123456789',
        productName: 'Pokemon Booster Bundle',
        price: 24.99,
        formattedPrice: '$24.99',
        availability: 'IN_STOCK'
      })

    await addCatalogItemFromUrl(getDb, 'https://www.walmart.com/ip/Pokemon-Booster/123456789')
    const refreshed = await refreshCatalogItem(getDb, 'walmart:123456789')

    expect(refreshed).toMatchObject({
      id: 'walmart:123456789',
      current_price: 24.99,
      formatted_current_price: '$24.99',
      availability: 'IN_STOCK',
      status: 'active'
    })
  })

  it('keeps stale data and marks item blocked when refresh is blocked', async () => {
    lookupProduct
      .mockResolvedValueOnce({
        retailer: 'target',
        productUrl: 'https://www.target.com/p/guppy/A-95267143',
        canonicalUrl: 'https://www.target.com/p/guppy/A-95267143',
        productName: 'Pokemon Booster Bundle',
        price: 26.94,
        formattedPrice: '$26.94'
      })
      .mockRejectedValueOnce({ response: { status: 403 } })

    await addCatalogItemFromUrl(getDb, 'https://www.target.com/p/guppy/A-95267143')
    const refreshed = await refreshCatalogItem(getDb, 'target:95267143')

    expect(refreshed).toMatchObject({
      id: 'target:95267143',
      title: 'Pokemon Booster Bundle',
      status: 'blocked'
    })
  })

  it('adds a minimal Target catalog item when Target lookup is captcha blocked', async () => {
    lookupProduct.mockRejectedValue({
      response: { status: 403 },
      message: 'Request failed with status code 403'
    })

    const item = await addCatalogItemFromUrl(getDb, 'https://www.target.com/p/guppy/A-1008749492')

    expect(item).toMatchObject({
      id: 'target:1008749492',
      retailer: 'target',
      retailer_item_id: '1008749492',
      id_type: 'TCIN',
      product_url: 'https://www.target.com/p/guppy/A-1008749492',
      title: 'Target Product A-1008749492',
      seller: 'Target',
      retailer_owned_listing: 1,
      status: 'blocked'
    })
  })

  it('adds a minimal Target catalog item when Target returns a captcha URL', async () => {
    lookupProduct.mockRejectedValue({
      response: {
        data: {
          captchaAbsoluteURL: 'https://redsky.target.com/captcha?trackingId=test'
        }
      },
      message: 'Target captcha required'
    })

    const item = await addCatalogItemFromUrl(getDb, 'https://www.target.com/p/guppy/A-1008749492')

    expect(item).toMatchObject({
      id: 'target:1008749492',
      status: 'blocked'
    })
  })
})
