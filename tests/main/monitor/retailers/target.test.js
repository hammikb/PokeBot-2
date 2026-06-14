import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TargetPoller } from '../../../../src/main/monitor/retailers/target.js'
import axios from 'axios'

vi.mock('axios')

// ---------------------------------------------------------------------------
// Helpers to build mock redsky responses (axios path)
// ---------------------------------------------------------------------------
function makeResponse({ status = 'IN_STOCK', atp = null, reasonCode = null, price = 49.99 } = {}) {
  return {
    data: {
      data: {
        product: {
          fulfillment: {
            shipping_options: {
              availability_status: status,
              available_to_promise_quantity: atp,
              reason_code: reasonCode
            }
          },
          price: { current_retail: price },
          item: { product_description: { title: 'Pokemon ETB' } }
        }
      }
    }
  }
}

const MOCK_IN_STOCK = makeResponse({ status: 'IN_STOCK', atp: 5 })
const MOCK_OUT = makeResponse({ status: 'UNAVAILABLE' })

describe('TargetPoller', () => {
  let poller
  beforeEach(() => {
    vi.clearAllMocks()
    poller = new TargetPoller({ productUrl: 'https://www.target.com/p/-/A-12345678', maxPrice: 60 })
  })

  // ---------------------------------------------------------------------------
  // Basic stock detection (axios path — no browserPool)
  // ---------------------------------------------------------------------------
  it('returns null when unavailable', async () => {
    axios.get.mockResolvedValue(MOCK_OUT)
    expect(await poller.poll()).toBeNull()
  })

  it('returns drop event when available under max price', async () => {
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    const result = await poller.poll()
    expect(result).not.toBeNull()
    expect(result.retailer).toBe('target')
    expect(result.price).toBe(49.99)
  })

  it('returns null on second poll (dedup)', async () => {
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    await poller.poll()
    expect(await poller.poll()).toBeNull()
  })

  it('fires again after restock', async () => {
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    await poller.poll()
    axios.get.mockResolvedValue(MOCK_OUT)
    await poller.poll()
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    expect(await poller.poll()).not.toBeNull()
  })

  it('returns null on error', async () => {
    axios.get.mockRejectedValue(new Error('fail'))
    expect(await poller.poll()).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Guppy-style in-stock logic
  // ---------------------------------------------------------------------------
  it('treats SELLABLE status with no reasonCode as in-stock', async () => {
    axios.get.mockResolvedValue(makeResponse({ status: 'SELLABLE', atp: null, reasonCode: null }))
    expect(await poller.poll()).not.toBeNull()
  })

  it('treats SELLABLE status WITH a reasonCode as out-of-stock', async () => {
    axios.get.mockResolvedValue(
      makeResponse({ status: 'SELLABLE', atp: null, reasonCode: 'ITEM_NOT_AVAILABLE_IN_STORE' })
    )
    expect(await poller.poll()).toBeNull()
  })

  it('treats UNSELLABLE as out-of-stock even if ATP > 0', async () => {
    axios.get.mockResolvedValue(makeResponse({ status: 'UNSELLABLE', atp: 10 }))
    expect(await poller.poll()).toBeNull()
  })

  it('treats DISCONTINUED as out-of-stock', async () => {
    axios.get.mockResolvedValue(makeResponse({ status: 'DISCONTINUED' }))
    expect(await poller.poll()).toBeNull()
  })

  it('treats LIMITED_STOCK as in-stock', async () => {
    axios.get.mockResolvedValue(makeResponse({ status: 'LIMITED_STOCK', reasonCode: null }))
    expect(await poller.poll()).not.toBeNull()
  })

  it('treats IN_STOCK as in-stock regardless of ATP', async () => {
    const p = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      minQuantity: 3
    })
    axios.get.mockResolvedValue(makeResponse({ status: 'IN_STOCK', atp: 2 }))
    expect(await p.poll()).not.toBeNull()
  })

  it('uses ATP alone when status is ambiguous but ATP >= minQuantity', async () => {
    const p = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      minQuantity: 1
    })
    axios.get.mockResolvedValue(makeResponse({ status: 'AVAILABLE', atp: 5, reasonCode: null }))
    expect(await p.poll()).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Akamai backoff
  // ---------------------------------------------------------------------------
  it('backs off without re-requesting after a 403 (Akamai block)', async () => {
    const blocked = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403 }
    })
    axios.get.mockRejectedValue(blocked)

    expect(await poller.poll()).toBeNull()
    expect(axios.get).toHaveBeenCalledTimes(1)

    // While cooled down, poll() must NOT make another request.
    expect(await poller.poll()).toBeNull()
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  it('resumes and clears backoff once the cooldown elapses and requests succeed', async () => {
    const blocked = Object.assign(new Error('403'), { response: { status: 403 } })
    axios.get.mockRejectedValueOnce(blocked)
    await poller.poll()

    poller._cooldownUntil = 0
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    const result = await poller.poll()
    expect(result).not.toBeNull()
    expect(poller._consecutiveBlocks).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // Poll-in-progress guard (prevents window explosion)
  // ---------------------------------------------------------------------------
  it('skips concurrent polls when one is already in progress', async () => {
    let resolveFirst
    const slowPromise = new Promise((res) => {
      resolveFirst = res
    })
    axios.get.mockReturnValueOnce(slowPromise)

    const firstPoll = poller.poll()
    const secondPoll = await poller.poll()
    expect(secondPoll).toBeNull()
    expect(axios.get).toHaveBeenCalledTimes(1)

    resolveFirst(MOCK_IN_STOCK)
    await firstPoll
  })

  // ---------------------------------------------------------------------------
  // Browser-intercept path (navigate PDP, intercept the enrichment/stock XHR)
  // ---------------------------------------------------------------------------

  // cdui_orchestrations deferred_enrichment shape: shipping_options nested deep,
  // price elsewhere in the same payload. Our parser deep-searches both.
  function makeCduiPayload({
    status = 'IN_STOCK',
    atp = 3,
    reasonCode = null,
    price = 29.99
  } = {}) {
    return {
      data: {
        pdp: {
          fulfillment: {
            store_options: [{ order_pickup: { availability_status: 'UNAVAILABLE' } }],
            shipping_options: {
              availability_status: status,
              available_to_promise_quantity: atp,
              reason_code: reasonCode
            }
          },
          enrichment: { price: { current_retail: price } }
        }
      }
    }
  }

  // A fake page whose goto() fires the stock route handler. `delayMs > 0`
  // simulates the real timing where the XHR lands AFTER navigation resolves.
  function makeFakePage({ payload, name = 'Pikachu Box', delayMs = 0 }) {
    let routeHandler = null
    const fire = () => {
      if (!routeHandler) return
      routeHandler({
        async fetch() {
          return {
            async json() {
              return payload
            }
          }
        },
        async fulfill() {}
      })
    }
    return {
      async route(pattern, handler) {
        routeHandler = handler
      },
      async unroute() {},
      async evaluate() {
        // Stands in for _readProductInfo: name from __NEXT_DATA__, price from the
        // DOM. Price null here so the test exercises the JSON `_findPrice` fallback.
        return { name, price: null }
      },
      async goto() {
        if (delayMs > 0) setTimeout(fire, delayMs)
        else fire()
      },
      async close() {}
    }
  }

  const fakePoolFor = (page) => ({
    async launchContext() {
      return {
        async newPage() {
          return page
        },
        async close() {}
      }
    }
  })

  it('parses stock from the intercepted enrichment response', async () => {
    const page = makeFakePage({ payload: makeCduiPayload({ price: 29.99 }), name: 'Pikachu Box' })
    const browserPoller = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      browserPool: fakePoolFor(page)
    })

    const result = await browserPoller.poll()
    expect(result).not.toBeNull()
    expect(result.retailer).toBe('target')
    expect(result.price).toBe(29.99)
    expect(result.productName).toBe('Pikachu Box')
    // axios should NOT have been called — browser path was used.
    expect(axios.get).not.toHaveBeenCalled()

    await browserPoller.destroy()
  })

  it('resolves when the stock XHR lands AFTER navigation completes (real timing)', async () => {
    // Regression: the enrichment XHR fires *after* domcontentloaded. Old code
    // resolved on goto() completion → null every poll. Fix resolves from the
    // route handler when the response actually lands.
    const page = makeFakePage({
      payload: makeCduiPayload({ status: 'IN_STOCK', atp: 4, price: 19.99 }),
      name: 'Charizard ETB',
      delayMs: 5
    })
    const browserPoller = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      browserPool: fakePoolFor(page)
    })

    const result = await browserPoller.poll()
    expect(result).not.toBeNull()
    expect(result.price).toBe(19.99)
    expect(result.productName).toBe('Charizard ETB')

    await browserPoller.destroy()
  })

  it('returns null for an out-of-stock enrichment response', async () => {
    const page = makeFakePage({ payload: makeCduiPayload({ status: 'OUT_OF_STOCK', atp: 0 }) })
    const browserPoller = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      browserPool: fakePoolFor(page)
    })
    expect(await browserPoller.poll()).toBeNull()
    await browserPoller.destroy()
  })

  it('returns null (and does not hang) when no stock call ever fires', async () => {
    const fakePage = {
      async route() {},
      async unroute() {},
      async goto() {}, // navigation completes, but no redsky XHR ever fires
      async close() {}
    }
    const fakeBrowserPool = {
      async launchContext() {
        return {
          async newPage() {
            return fakePage
          },
          async close() {}
        }
      }
    }

    const browserPoller = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      browserPool: fakeBrowserPool,
      browserInterceptTimeoutMs: 40 // fast fallback for the test
    })

    expect(await browserPoller.poll()).toBeNull()
    await browserPoller.destroy()
  })

  it('reuses the same browser page on subsequent polls (no new windows)', async () => {
    let contextCreateCount = 0
    let pageCreateCount = 0

    const fakePage = {
      async route() {},
      async unroute() {},
      async goto() {},
      async close() {}
    }

    const fakeBrowserPool = {
      async launchContext() {
        contextCreateCount++
        return {
          async newPage() {
            pageCreateCount++
            return fakePage
          },
          async close() {}
        }
      }
    }

    const browserPoller = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      browserPool: fakeBrowserPool,
      browserInterceptTimeoutMs: 40 // no redsky fires here; fall back fast
    })

    await browserPoller.poll()
    await browserPoller.poll()
    await browserPoller.poll()

    // Should have created exactly ONE context and ONE page
    expect(contextCreateCount).toBe(1)
    expect(pageCreateCount).toBe(1)

    await browserPoller.destroy()
  })

  it('destroy() closes the browser context', async () => {
    let contextClosed = false
    let pageClosed = false

    const fakePage = {
      async route() {},
      async unroute() {},
      async goto() {},
      async close() {
        pageClosed = true
      }
    }

    const fakeBrowserPool = {
      async launchContext() {
        return {
          async newPage() {
            return fakePage
          },
          async close() {
            contextClosed = true
          }
        }
      }
    }

    const browserPoller = new TargetPoller({
      productUrl: 'https://www.target.com/p/-/A-12345678',
      browserPool: fakeBrowserPool,
      browserInterceptTimeoutMs: 40 // no redsky fires here; fall back fast
    })

    await browserPoller.poll()
    await browserPoller.destroy()

    expect(pageClosed).toBe(true)
    expect(contextClosed).toBe(true)
  })
})
