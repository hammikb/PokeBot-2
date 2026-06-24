import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('WalmartPoller')

// ---------------------------------------------------------------------------
// WalmartPoller

// ---------------------------------------------------------------------------
export class WalmartPoller {
  /**
   * @param {object} opts
   * @param {string}  opts.productUrl
   * @param {number}  [opts.maxPrice]
   * @param {object}  [opts.browserPool]  BrowserPool — enables Guppy-style browser
   *                                       interception (no bot-detection risk).
   */
  constructor({ productUrl, maxPrice = Infinity, browserPool = null }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.browserPool = browserPool
    // Handle both URL shapes:
    //   /ip/123456789          → itemId = "123456789"
    //   /ip/product-name/123456789 → itemId = "123456789"
    const ipSegments = productUrl.split('/ip/').pop()?.split('?')[0]?.split('/') ?? []
    this.itemId = ipSegments.find((s) => /^\d+$/.test(s)) ?? null
    if (!this.itemId) {
      throw new Error(`Cannot extract item ID from Walmart URL: ${productUrl}`)
    }

    this._wasInStock = false
    this._isFirstPoll = true
    this._cooldownUntil = 0
    this._consecutiveBlocks = 0
  }

  async poll() {
    if (Date.now() < this._cooldownUntil) return null

    let product
    try {
      product = this.browserPool ? await this._fetchViaBrowser() : await this._fetchViaAxios()
    } catch (err) {
      const status = err.response?.status
      if (status === 403 || status === 429 || status === 412) {
        this._consecutiveBlocks += 1
        const cooldown = Math.min(30_000 * 2 ** (this._consecutiveBlocks - 1), 10 * 60_000)
        this._cooldownUntil = Date.now() + cooldown
        log.warn('Walmart rate-limited — backing off', {
          itemId: this.itemId,
          status,
          cooldownMs: cooldown
        })
        return null
      }
      log.error('Walmart lookup failed', { itemId: this.itemId, error: err.message })
      return null
    }

    this._consecutiveBlocks = 0
    this._cooldownUntil = 0

    if (!product) return null

    const { name, price, inStock } = product
    log.info('Polled Walmart product', {
      itemId: this.itemId,
      inStock,
      price,
      name,
      method: this.browserPool ? 'browser-intercept' : 'axios'
    })

    const overPrice = price != null && Number.isFinite(this.maxPrice) && price > this.maxPrice
    if (!inStock || overPrice) {
      this._wasInStock = false
      this._isFirstPoll = false
      return null
    }

    if (this._wasInStock && !this._isFirstPoll) return null

    const isFirstCheck = this._isFirstPoll
    this._wasInStock = true
    this._isFirstPoll = false

    return createDropEvent({
      retailer: 'walmart',
      productName: name,
      productUrl: this.productUrl,
      dropType: DROP_TYPES.IN_STOCK,
      price,
      isFirstCheck
    })
  }

  // ---------------------------------------------------------------------------
  // Browser-based interception (Guppy-style)
  // ---------------------------------------------------------------------------
  // Walmart fires several API calls during page load. We intercept the item
  // data API response which contains availability + price — same approach Guppy
  // uses for Walmart monitoring.
  async _fetchViaBrowser() {
    let context = null
    let page = null
    try {
      context = await this.browserPool.launchContext({
        accountId: `monitor-walmart-${this.itemId}`
      })
      page = await context.newPage()
      return await this._interceptWalmartApi(page)
    } finally {
      try {
        await page?.close()
      } catch {
        /* ignore */
      }
      try {
        await context?.close()
      } catch {
        /* ignore */
      }
    }
  }

  async _interceptWalmartApi(page) {
    let resolveData
    const dataPromise = new Promise((res) => {
      resolveData = res
    })
    let resolved = false
    let productData = null

    const tryResolve = () => {
      if (resolved || !productData) return
      resolved = true
      clearTimeout(timer)
      resolveData(productData)
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolveData(productData)
      }
    }, 20_000)

    // Intercept Walmart's item API calls — they fire during page render.
    page
      .route(/\/orchestra\/.*\/graphql\/|\/api\/2\/items\/|\/api\/items\//, async (route) => {
        try {
          const response = await route.fetch()
          const json = await response.json().catch(() => null)
          if (json) {
            const parsed = this._parseWalmartApiResponse(json)
            if (parsed) {
              productData = parsed
              tryResolve()
            }
          }
          await route.fulfill({ response })
        } catch {
          await route.abort().catch(() => {})
          tryResolve()
        }
      })
      .catch(() => {})

    await page
      .goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      .catch(() => {
        if (!resolved) resolveData(null)
      })

    return dataPromise
  }

  _parseWalmartApiResponse(json) {
    // Try multiple response shapes Walmart uses
    const item =
      json?.data?.product?.item || json?.item || json?.data?.item || json?.payload?.item || null

    if (!item) return null

    const name = item?.name || item?.productName || 'Walmart Product'
    const price =
      item?.priceInfo?.currentPrice?.price ??
      item?.priceInfo?.wasPrice?.price ??
      item?.price?.currentPrice?.price ??
      null
    const availabilityStatus =
      item?.availabilityStatus || item?.fulfillmentStatus || item?.inventory?.status || null

    const inStock =
      availabilityStatus === 'IN_STOCK' ||
      availabilityStatus === 'AVAILABLE' ||
      item?.addToCartEligible === true ||
      item?.buyable === true

    return { name, price, inStock }
  }

  // ---------------------------------------------------------------------------
  // Axios fallback
  // ---------------------------------------------------------------------------
  async _fetchViaAxios() {
    // Use Walmart's item API with proper headers
    const { data } = await axios.get(`https://www.walmart.com/ip/${this.itemId}`, {
      timeout: 15000,
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9'
      },
      params: { modules: 'item,price,inventory' }
    })

    const name = data?.name || data?.item?.name || 'Walmart Product'
    const price = data?.priceInfo?.currentPrice?.price ?? data?.price?.currentPrice?.price ?? null
    const status = data?.availabilityStatus || data?.item?.availabilityStatus
    const inStock = status === 'IN_STOCK'

    return { name, price, inStock }
  }
}
