import { describe, expect, it, vi, beforeEach } from 'vitest'
import { findWalmartMatch } from '../../../src/main/products/WalmartMatch.js'
import { searchProducts } from '../../../src/main/products/ProductSearch.js'

vi.mock('../../../src/main/products/ProductSearch.js', () => ({
  searchProducts: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findWalmartMatch', () => {
  it('searches by UPC first and tags results with upc confidence', async () => {
    searchProducts.mockResolvedValueOnce([
      { retailer: 'walmart', name: 'Exact Hit', url: 'https://www.walmart.com/ip/1', itemId: '1' }
    ])

    const result = await findWalmartMatch({ upc: '196214112568', name: 'Some Product' })

    expect(searchProducts).toHaveBeenCalledWith('196214112568', 'walmart')
    expect(searchProducts).toHaveBeenCalledTimes(1)
    expect(result).toEqual([
      {
        retailer: 'walmart',
        name: 'Exact Hit',
        url: 'https://www.walmart.com/ip/1',
        itemId: '1',
        confidence: 'upc'
      }
    ])
  })

  it('falls back to a name search, tagged as name confidence, when UPC finds nothing', async () => {
    searchProducts
      .mockResolvedValueOnce([]) // UPC search: no hit
      .mockResolvedValueOnce([
        { retailer: 'walmart', name: 'Fuzzy Hit', url: 'https://www.walmart.com/ip/2', itemId: '2' }
      ])

    const result = await findWalmartMatch({ upc: '000000000000', name: 'Pokemon ETB' })

    expect(searchProducts).toHaveBeenNthCalledWith(1, '000000000000', 'walmart')
    expect(searchProducts).toHaveBeenNthCalledWith(2, 'Pokemon ETB', 'walmart')
    expect(result).toEqual([
      {
        retailer: 'walmart',
        name: 'Fuzzy Hit',
        url: 'https://www.walmart.com/ip/2',
        itemId: '2',
        confidence: 'name'
      }
    ])
  })

  it('skips the UPC search entirely when there is no UPC', async () => {
    searchProducts.mockResolvedValueOnce([
      { retailer: 'walmart', name: 'Fuzzy Hit', url: 'https://www.walmart.com/ip/3', itemId: '3' }
    ])

    const result = await findWalmartMatch({ upc: null, name: 'Pokemon ETB' })

    expect(searchProducts).toHaveBeenCalledTimes(1)
    expect(searchProducts).toHaveBeenCalledWith('Pokemon ETB', 'walmart')
    expect(result[0].confidence).toBe('name')
  })

  it('filters out disabled (blocked/captcha) search results', async () => {
    searchProducts.mockResolvedValueOnce([
      { retailer: 'walmart', disabled: true, name: 'walmart search blocked by retailer CAPTCHA' }
    ])

    const result = await findWalmartMatch({ upc: '123', name: null })

    expect(result).toEqual([])
  })

  it('returns an empty array when neither UPC nor name find anything', async () => {
    searchProducts.mockResolvedValue([])

    const result = await findWalmartMatch({ upc: '123', name: 'Nothing Like This' })

    expect(result).toEqual([])
  })
})
