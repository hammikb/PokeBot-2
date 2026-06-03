import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { lookupProduct } from '../../../src/main/products/ProductLookup.js'
import { lookupProductWithScrapling } from '../../../src/main/products/ScraplingLookup.js'

vi.mock('axios')
vi.mock('../../../src/main/products/ScraplingLookup.js', () => ({
  lookupProductWithScrapling: vi.fn()
}))

describe('lookupProduct', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lookupProductWithScrapling.mockResolvedValue(null)
  })

  it('returns normalized Target product information with images', async () => {
    axios.get.mockResolvedValue({
      data: {
        data: {
          product: {
            tcin: '95225595',
            category: { name: 'Trading Cards' },
            item: {
              enrichment: {
                buy_url:
                  'https://www.target.com/p/pokemon-trading-card-game-first-partner/-/A-95225595',
                image_info: {
                  primary_image: {
                    url: 'https://target.scene7.com/is/image/Target/GUEST_primary'
                  },
                  alternate_images: [
                    { url: 'https://target.scene7.com/is/image/Target/GUEST_alt_1' },
                    { url: 'https://target.scene7.com/is/image/Target/GUEST_alt_2' }
                  ]
                }
              },
              fulfillment: {
                shipping_options: { availability_status: 'IN_STOCK' }
              },
              primary_brand: { name: 'Pokemon' },
              product_description: {
                title:
                  'Pok&#233;mon Trading Card Game: First Partner Illustration Collection Series 1',
                soft_bullets: {
                  bullets: ['1 Pokemon TCG booster pack', '2 Pokemon TCG booster packs']
                }
              }
            },
            price: {
              current_retail: 15.99,
              formatted_current_price: '$15.99'
            }
          }
        }
      }
    })

    const product = await lookupProduct('https://www.target.com/p/guppy/A-95225595')

    expect(axios.get).toHaveBeenCalledWith(
      'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1',
      expect.objectContaining({
        params: expect.objectContaining({
          tcin: '95225595',
          store_id: '3991',
          pricing_store_id: '3991'
        })
      })
    )
    expect(product).toEqual({
      retailer: 'target',
      productUrl: 'https://www.target.com/p/guppy/A-95225595',
      canonicalUrl: 'https://www.target.com/p/pokemon-trading-card-game-first-partner/-/A-95225595',
      productName: 'Pokémon Trading Card Game: First Partner Illustration Collection Series 1',
      price: 15.99,
      formattedPrice: '$15.99',
      imageUrl: 'https://target.scene7.com/is/image/Target/GUEST_primary',
      images: [
        'https://target.scene7.com/is/image/Target/GUEST_primary',
        'https://target.scene7.com/is/image/Target/GUEST_alt_1',
        'https://target.scene7.com/is/image/Target/GUEST_alt_2'
      ],
      availability: 'IN_STOCK',
      brand: 'Pokemon',
      category: 'Trading Cards',
      bullets: ['1 Pokemon TCG booster pack', '2 Pokemon TCG booster packs']
    })
  })

  it('uses Scrapling data before Target RedSky when available', async () => {
    lookupProductWithScrapling.mockResolvedValue({
      retailer: 'target',
      productUrl: 'https://www.target.com/p/guppy/A-95225595',
      canonicalUrl: 'https://www.target.com/p/example/-/A-95225595',
      productName: 'Pokemon Trading Card Game Scrapling Box',
      price: 24.99,
      formattedPrice: '$24.99',
      imageUrl: 'https://target.scene7.com/is/image/Target/GUEST_scrapling',
      images: ['https://target.scene7.com/is/image/Target/GUEST_scrapling'],
      availability: 'IN_STOCK',
      brand: 'Pokemon',
      category: null,
      bullets: [],
      source: 'scrapling'
    })

    const product = await lookupProduct('https://www.target.com/p/guppy/A-95225595')

    expect(product.source).toBe('scrapling')
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('notifies before using Target RedSky when Scrapling is unavailable', async () => {
    const onScraplingFallback = vi.fn()
    lookupProductWithScrapling.mockRejectedValue(new Error('Scrapling missing'))
    axios.get.mockResolvedValue({
      data: {
        data: {
          product: {
            item: {
              enrichment: {
                buy_url: 'https://www.target.com/p/example/-/A-95225595',
                image_info: {
                  primary_image: { url: 'https://target.scene7.com/is/image/Target/GUEST_api' }
                }
              },
              product_description: { title: 'Pokemon API Product' }
            },
            price: { current_retail: 19.99, formatted_current_price: '$19.99' }
          }
        }
      }
    })

    const product = await lookupProduct('https://www.target.com/p/guppy/A-95225595', {
      onScraplingFallback
    })

    expect(onScraplingFallback).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/guppy/A-95225595',
      error: expect.any(Error)
    })
    expect(product.productName).toBe('Pokemon API Product')
    expect(axios.get).toHaveBeenCalled()
  })

  it('does not use RedSky fallback when Scrapling sees a retailer block', async () => {
    lookupProductWithScrapling.mockRejectedValue({
      status: 403,
      response: { status: 403, data: { captchaRelativeURL: '/captcha' } }
    })

    await expect(lookupProduct('https://www.target.com/p/guppy/A-95225595')).rejects.toMatchObject({
      status: 403
    })
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('returns normalized Walmart product information with images', async () => {
    axios.get.mockResolvedValue({
      data: {
        availabilityStatus: 'IN_STOCK',
        imageInfo: {
          thumbnailUrl: 'https://i5.walmartimages.com/primary.jpeg',
          allImages: [
            { url: 'https://i5.walmartimages.com/primary.jpeg' },
            { url: 'https://i5.walmartimages.com/alternate.jpeg' }
          ]
        },
        name: 'Pokemon Scarlet and Violet Booster Bundle',
        priceInfo: {
          currentPrice: {
            price: 26.94,
            priceString: '$26.94'
          }
        },
        brand: 'Pokemon'
      }
    })

    const product = await lookupProduct('https://www.walmart.com/ip/pokemon-booster/123456789')

    expect(axios.get).toHaveBeenCalledWith(
      'https://www.walmart.com/ip/123456789',
      expect.objectContaining({
        params: { modules: 'item' }
      })
    )
    expect(product).toEqual({
      retailer: 'walmart',
      productUrl: 'https://www.walmart.com/ip/pokemon-booster/123456789',
      canonicalUrl: 'https://www.walmart.com/ip/123456789',
      productName: 'Pokemon Scarlet and Violet Booster Bundle',
      price: 26.94,
      formattedPrice: '$26.94',
      imageUrl: 'https://i5.walmartimages.com/primary.jpeg',
      images: [
        'https://i5.walmartimages.com/primary.jpeg',
        'https://i5.walmartimages.com/alternate.jpeg'
      ],
      availability: 'IN_STOCK',
      brand: 'Pokemon',
      category: null,
      bullets: []
    })
  })

  it('extracts Walmart product information from embedded page data when HTML is returned', async () => {
    axios.get.mockResolvedValue({
      data: `
        <html>
          <script id="__NEXT_DATA__" type="application/json">
            {
              "props": {
                "pageProps": {
                  "initialData": {
                    "data": {
                      "product": {
                        "name": "Pokemon Poster Collection",
                        "availabilityStatus": "IN_STOCK",
                        "brand": "Pokemon",
                        "imageInfo": {
                          "thumbnailUrl": "https://i5.walmartimages.com/poster.jpeg"
                        },
                        "priceInfo": {
                          "currentPrice": {
                            "price": 14.98,
                            "priceString": "$14.98"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          </script>
        </html>
      `
    })

    const product = await lookupProduct('https://www.walmart.com/ip/Pokemon-Poster/987654321')

    expect(product).toMatchObject({
      retailer: 'walmart',
      canonicalUrl: 'https://www.walmart.com/ip/987654321',
      productName: 'Pokemon Poster Collection',
      price: 14.98,
      formattedPrice: '$14.98',
      imageUrl: 'https://i5.walmartimages.com/poster.jpeg',
      availability: 'IN_STOCK',
      brand: 'Pokemon'
    })
  })

  it('throws a useful error when a Target URL does not include a TCIN', async () => {
    await expect(lookupProduct('https://www.target.com/p/no-tcin')).rejects.toThrow(
      'Cannot extract Target TCIN from URL'
    )
  })

  it('throws a useful error when a product URL is not Target or Walmart', async () => {
    await expect(lookupProduct('https://example.com/product/123')).rejects.toThrow(
      'Product lookup is currently supported for Target and Walmart URLs'
    )
  })
})
