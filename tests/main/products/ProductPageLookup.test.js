import { beforeEach, describe, expect, it, vi } from 'vitest'
import { launchPersistentContext } from 'cloakbrowser'
import { lookupProductFromPage } from '../../../src/main/products/ProductPageLookup.js'

vi.mock('cloakbrowser', () => ({
  launchPersistentContext: vi.fn()
}))

function mockBrowserSnapshot(snapshot) {
  const page = {
    goto: vi.fn(),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => snapshot)
  }
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {})
  }
  launchPersistentContext.mockResolvedValue(context)

  return { page, context }
}

describe('lookupProductFromPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts public product details from rendered page metadata', async () => {
    const { context } = mockBrowserSnapshot({
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

    const product = await lookupProductFromPage('https://www.target.com/p/guppy/A-123', {
      proxy: 'proxy.example:80:user:password'
    })

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
    expect(context.close).toHaveBeenCalled()
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
      lookupProductFromPage('https://www.target.com/p/guppy/A-123', {
        proxy: 'proxy.example:80:user:password'
      })
    ).rejects.toMatchObject({
      status: 403
    })
  })

  it('refuses to expose the home IP when a retailer lookup has no proxy', async () => {
    await expect(lookupProductFromPage('https://www.target.com/p/guppy/A-123')).rejects.toThrow(
      'direct home-IP lookup is disabled'
    )
    expect(launchPersistentContext).not.toHaveBeenCalled()
  })
})
