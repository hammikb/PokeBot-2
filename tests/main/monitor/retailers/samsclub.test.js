import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SamsClubPoller,
  extractAnnouncedSamsReleaseAt,
  extractSamsItemId,
  extractSamsProduct,
  getSamsProductState
} from '../../../../src/main/monitor/retailers/samsclub.js'

vi.mock('axios')

function pageHtml({
  viewOnly = true,
  quantity = 8,
  memberGate = false,
  shortDescription = ''
} = {}) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialData: {
          data: {
            product: {
              usItemId: '20186272756',
              name: 'Focused Fighters Premium Collection',
              availabilityStatus: 'IN_STOCK',
              showAtc: true,
              specialCtaType: memberGate ? 'SIGN_IN_TO_SEE_PRICE' : null,
              staticMessageType: memberGate ? 'MEMBER_ONLY_PRICE' : null,
              shortDescription,
              priceInfo: { currentPrice: { price: 55.98 } },
              fulfillmentOptions: [
                {
                  type: 'SHIPPING',
                  selected: true,
                  availabilityStatus: 'IN_STOCK',
                  viewOnly,
                  restricted: false,
                  availableQuantity: quantity
                }
              ]
            }
          }
        }
      }
    }
  })}</script></html>`
}

describe('SamsClubPoller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not fire while a coming-soon offer is view-only', async () => {
    axios.get.mockResolvedValue({ status: 200, data: pageHtml(), headers: {} })
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/Focused-Fighters-Premium-Collection/20186272756',
      maxPrice: 60
    })

    await expect(poller.poll()).resolves.toBeNull()
  })

  it('fires once when shipping becomes actionable', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: pageHtml({ viewOnly: false }),
      headers: {}
    })
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/Focused-Fighters-Premium-Collection/20186272756',
      maxPrice: 60
    })

    const event = await poller.poll()
    expect(event).toMatchObject({
      retailer: 'samsclub',
      productName: 'Focused Fighters Premium Collection',
      price: 55.98
    })
    await expect(poller.poll()).resolves.toBeNull()
  })

  it("supports short Sam's Club URLs and fires for a members-only in-stock item", async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: pageHtml({ memberGate: true }),
      headers: {}
    })
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/20186272756',
      maxPrice: 60
    })

    expect(extractSamsItemId('https://www.samsclub.com/ip/20186272756')).toBe('20186272756')
    await expect(poller.poll()).resolves.toMatchObject({ retailer: 'samsclub', price: 55.98 })
  })

  it("uses the shared browser monitor when Sam's blocks lightweight requests", async () => {
    axios.get.mockResolvedValue({ status: 403, data: 'Access denied', headers: {} })
    const product = extractSamsProduct(pageHtml({ viewOnly: false }))
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://www.samsclub.com/ip/item/20186272756'),
      evaluate: vi.fn().mockResolvedValue(product)
    }
    const monitorContext = {
      getPage: vi.fn().mockResolvedValue(page),
      closePage: vi.fn().mockResolvedValue(undefined)
    }
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/20186272756',
      maxPrice: 60,
      monitorContext
    })

    await expect(poller.poll()).resolves.toMatchObject({ retailer: 'samsclub', price: 55.98 })
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(monitorContext.getPage).toHaveBeenCalledWith('20186272756')
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.samsclub.com/ip/20186272756',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    )
    await poller.destroy()
    expect(monitorContext.closePage).toHaveBeenCalledWith('20186272756')
  })

  it('does not navigate again while the live traffic gate owns the monitor tab', async () => {
    axios.get.mockResolvedValue({ status: 403, data: 'Access denied', headers: {} })
    let bodyText = ''
    const page = {
      goto: vi.fn(async () => {
        bodyText = "Hold tight for a moment High traffic is slowing things down a bit."
      }),
      url: vi.fn().mockReturnValue('https://www.samsclub.com/ip/item/20186272756'),
      locator: vi.fn(() => ({
        innerText: vi.fn(async () => bodyText)
      })),
      evaluate: vi.fn().mockResolvedValue(null)
    }
    const monitorContext = { getPage: vi.fn().mockResolvedValue(page), closePage: vi.fn() }
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/20186272756',
      maxPrice: 60,
      monitorContext
    })

    await expect(poller.poll()).resolves.toBeNull()
    await expect(poller.poll()).resolves.toBeNull()

    expect(page.goto).toHaveBeenCalledTimes(1)
    expect(page.evaluate).toHaveBeenCalledTimes(1)
  })

  it('resumes from the existing tab when the traffic gate loads the product', async () => {
    axios.get.mockResolvedValue({ status: 403, data: 'Access denied', headers: {} })
    const product = extractSamsProduct(pageHtml({ viewOnly: false }))
    let bodyText = ''
    let loadedProduct = null
    const page = {
      goto: vi.fn(async () => {
        bodyText = 'Hold tight for a moment'
      }),
      url: vi.fn().mockReturnValue('https://www.samsclub.com/ip/item/20186272756'),
      locator: vi.fn(() => ({ innerText: vi.fn(async () => bodyText) })),
      evaluate: vi.fn(async () => loadedProduct)
    }
    const monitorContext = { getPage: vi.fn().mockResolvedValue(page), closePage: vi.fn() }
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/20186272756',
      maxPrice: 60,
      monitorContext
    })

    await expect(poller.poll()).resolves.toBeNull()
    bodyText = 'Focused Fighters Premium Collection Add to cart'
    loadedProduct = product
    await expect(poller.poll()).resolves.toMatchObject({ retailer: 'samsclub', price: 55.98 })
    await expect(poller.poll()).resolves.toBeNull()

    expect(page.goto).toHaveBeenCalledTimes(1)
  })

  it('keeps monitoring lightweight when a browser fallback is available', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: pageHtml({ viewOnly: false }),
      headers: { etag: 'stock-v1' }
    })
    const monitorContext = { getPage: vi.fn(), closePage: vi.fn() }
    const poller = new SamsClubPoller({
      productUrl: 'https://www.samsclub.com/ip/20186272756',
      maxPrice: 60,
      monitorContext
    })

    await expect(poller.poll()).resolves.toMatchObject({ retailer: 'samsclub' })
    expect(axios.get).toHaveBeenCalledWith(
      'https://www.samsclub.com/ip/20186272756',
      expect.objectContaining({ timeout: 15000 })
    )
    expect(monitorContext.getPage).not.toHaveBeenCalled()
  })

  it('holds a members-only signal until the announced Central launch time', () => {
    const product = extractSamsProduct(
      pageHtml({
        memberGate: true,
        shortDescription:
          '<strong>Coming Soon In-Club & Online - July 21st (availability begins Online at 10 PM CST).</strong>'
      })
    )
    const beforeLaunch = Date.parse('2026-07-22T02:59:00.000Z')
    const afterLaunch = Date.parse('2026-07-22T03:01:00.000Z')

    expect(extractAnnouncedSamsReleaseAt(product, beforeLaunch)).toBe(
      Date.parse('2026-07-22T03:00:00.000Z')
    )
    expect(getSamsProductState(product, beforeLaunch).inStock).toBe(false)
    expect(getSamsProductState(product, afterLaunch).inStock).toBe(true)
  })

  it('extracts the server-rendered product payload', () => {
    expect(extractSamsProduct(pageHtml())?.usItemId).toBe('20186272756')
  })
})
