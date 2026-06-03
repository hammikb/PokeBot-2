import { describe, expect, it, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { searchProducts } from '../../../src/main/products/ProductSearch.js'

vi.mock('axios')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('searchProducts', () => {
  it('returns normalized Target search results with usable product URLs', async () => {
    axios.get.mockResolvedValue({
      data: {
        data: {
          search: {
            products: [
              {
                item: {
                  tcin: '95225595',
                  enrichment: {
                    buy_url: '/p/pokemon-tcg-box/-/A-95225595',
                    image_info: {
                      primary_image: { url: 'https://target.scene7.com/product' }
                    }
                  },
                  product_description: { title: 'Pokemon TCG Box' }
                },
                price: {
                  current_retail: 49.99,
                  formatted_current_price: '$49.99'
                }
              }
            ]
          }
        }
      }
    })

    const results = await searchProducts('pokemon box', 'target')

    expect(results[0]).toMatchObject({
      retailer: 'target',
      name: 'Pokemon TCG Box',
      url: 'https://www.target.com/p/pokemon-tcg-box/-/A-95225595',
      price: 49.99,
      formattedPrice: '$49.99',
      imageUrl: 'https://target.scene7.com/product',
      itemId: '95225595',
      sellerName: 'Target',
      retailerOwnedListing: true,
      freshStockConfidence: 'high'
    })

    expect(axios.get).toHaveBeenCalledWith(
      'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2',
      expect.objectContaining({
        params: expect.objectContaining({
          channel: 'WEB',
          page: '/s/pokemon box',
          visitor_id: expect.any(String)
        })
      })
    )
  })

  it('returns normalized Walmart search results from Next data', async () => {
    axios.get.mockResolvedValue({
      data: `
        <html>
          <script id="__NEXT_DATA__" type="application/json">
            {
              "props": {
                "pageProps": {
                  "initialData": {
                    "searchResult": {
                      "itemStacks": [{
                        "items": [{
                          "name": "Pokemon Booster Bundle",
                          "canonicalUrl": "/ip/Pokemon-Booster-Bundle/123456789",
                          "usItemId": "123456789",
                          "imageInfo": { "thumbnailUrl": "https://i5.walmartimages.com/product.jpeg" },
                          "priceInfo": {
                            "currentPrice": {
                              "price": 26.94,
                              "priceString": "$26.94"
                            }
                          }
                        }]
                      }]
                    }
                  }
                }
              }
            }
          </script>
        </html>
      `
    })

    const results = await searchProducts('pokemon booster', 'walmart')

    expect(results[0]).toMatchObject({
      retailer: 'walmart',
      name: 'Pokemon Booster Bundle',
      url: 'https://www.walmart.com/ip/Pokemon-Booster-Bundle/123456789',
      price: 26.94,
      formattedPrice: '$26.94',
      formattedMsrp: '$26.94',
      imageUrl: 'https://i5.walmartimages.com/product.jpeg',
      itemId: '123456789',
      retailerOwnedListing: false,
      freshStockConfidence: 'unknown'
    })
  })

  it('marks Walmart-owned listings when seller data is Walmart', async () => {
    axios.get.mockResolvedValue({
      data: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialData":{"searchResult":{"itemStacks":[{"items":[{"name":"Pokemon Booster Bundle","canonicalUrl":"/ip/Pokemon-Booster-Bundle/123","usItemId":"123","sellerName":"Walmart.com"}]}]}}}}}</script>'
    })

    const results = await searchProducts('pokemon booster', 'walmart')

    expect(results[0]).toMatchObject({
      sellerName: 'Walmart.com',
      retailerOwnedListing: true,
      freshStockConfidence: 'high'
    })
  })

  it('returns a clear Walmart robot diagnostic when Walmart blocks search', async () => {
    axios.get.mockResolvedValue({
      data: '<html><head><title>Robot or human?</title></head><body>Robot or human?</body></html>'
    })

    const results = await searchProducts('pokemon booster', 'walmart')

    expect(results[0]).toMatchObject({
      retailer: 'walmart',
      disabled: true,
      name: 'walmart search blocked by retailer CAPTCHA'
    })
  })

  it('keeps working when one retailer search fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('target blocked')).mockResolvedValueOnce({
      data: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialData":{"searchResult":{"itemStacks":[{"items":[{"name":"Walmart Hit","canonicalUrl":"/ip/Walmart-Hit/1","usItemId":"1"}]}]}}}}}</script>'
    })

    const results = await searchProducts('pokemon')

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      retailer: 'target',
      disabled: true,
      name: 'target search unavailable'
    })
    expect(results[1]).toMatchObject({
      retailer: 'walmart',
      name: 'Walmart Hit',
      url: 'https://www.walmart.com/ip/Walmart-Hit/1'
    })
  })

  it('returns a clear Target captcha diagnostic when Target blocks search', async () => {
    axios.get
      .mockRejectedValueOnce({
        response: {
          status: 403,
          data: {
            captchaAbsoluteURL: 'https://redsky.target.com/captcha?id=1'
          }
        }
      })
      .mockResolvedValueOnce({
        data: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialData":{"searchResult":{"itemStacks":[{"items":[]}]}}}}}</script>'
      })

    const results = await searchProducts('pokemon')

    expect(results[0]).toMatchObject({
      retailer: 'target',
      disabled: true,
      name: 'target search blocked by retailer CAPTCHA',
      message: 'Try again later, use a working proxy, or paste the product URL directly.'
    })
  })

  it('returns results from both retailers when both searches succeed', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          data: {
            search: {
              products: [
                {
                  item: {
                    tcin: '1',
                    enrichment: { buy_url: '/p/target-hit/-/A-1' },
                    product_description: { title: 'Target Hit' }
                  }
                }
              ]
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialData":{"searchResult":{"itemStacks":[{"items":[{"name":"Walmart Hit","canonicalUrl":"/ip/Walmart-Hit/2","usItemId":"2"}]}]}}}}}</script>'
      })

    const results = await searchProducts('pokemon')

    expect(results.map((result) => result.retailer)).toEqual(['target', 'walmart'])
  })

  it('decodes HTML entities in search result names', async () => {
    axios.get.mockResolvedValue({
      data: {
        data: {
          search: {
            products: [
              {
                item: {
                  tcin: '95045259',
                  enrichment: { buy_url: '/p/pokemon/-/A-95045259' },
                  product_description: {
                    title: 'Pok&#233;mon Trading Card Game: Chaos&#160;Box'
                  }
                }
              }
            ]
          }
        }
      }
    })

    const results = await searchProducts('pokemon', 'target')

    expect(results[0].name).toBe('Pokémon Trading Card Game: Chaos Box')
  })
})
