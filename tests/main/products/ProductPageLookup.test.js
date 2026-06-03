import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import { lookupProductFromPage } from '../../../src/main/products/ProductPageLookup.js'

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn()
  }
}))

function mockBrowserSnapshot(snapshot) {
  const page = {
    goto: vi.fn(),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => snapshot)
  }
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {})
  }
  chromium.launch.mockResolvedValue(browser)
  return { page, browser }
}

describe('lookupProductFromPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts public product details from rendered page metadata', async () => {
    const { browser } = mockBrowserSnapshot({
      url: 'https://www.target.com/p/example/-/A-123',
      title: 'Pokemon Example Box : Target',
      bodyText: 'Add to cart',
      h1: 'Pokemon Example Box',
      ogTitle: 'Pokemon Example Box : Target',
      ogImage: 'https://target.scene7.com/example',
      canonical: 'https://www.target.com/p/example/-/A-123',
      scripts: [
        JSON.stringify({
          '@type': 'Product',
          name: 'Pokemon Example Box',
          brand: { name: 'Pokemon' },
          image: ['https://target.scene7.com/example'],
          offers: { price: '29.99', availability: 'InStock' }
        })
      ],
      nextData: null,
      prices: ['$29.99']
    })

    const product = await lookupProductFromPage('https://www.target.com/p/guppy/A-123')

    expect(product).toMatchObject({
      retailer: 'target',
      canonicalUrl: 'https://www.target.com/p/example/-/A-123',
      productName: 'Pokemon Example Box',
      price: 29.99,
      formattedPrice: '$29.99',
      imageUrl: 'https://target.scene7.com/example',
      availability: 'IN_STOCK',
      brand: 'Pokemon',
      source: 'page'
    })
    expect(browser.close).toHaveBeenCalled()
  })

  it('throws a retailer block error when the rendered page is a captcha', async () => {
    mockBrowserSnapshot({
      url: 'https://www.target.com/captcha',
      title: 'Robot or human?',
      bodyText: 'Please verify you are human',
      canonical: 'https://www.target.com/captcha',
      scripts: [],
      prices: []
    })

    await expect(
      lookupProductFromPage('https://www.target.com/p/guppy/A-123')
    ).rejects.toMatchObject({
      status: 403
    })
  })
})
