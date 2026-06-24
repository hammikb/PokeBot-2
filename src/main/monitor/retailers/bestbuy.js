import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('BestBuyPoller')

export class BestBuyPoller {
  constructor({ productUrl, maxPrice = Infinity, browserPool = null }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.browserPool = browserPool
    this.sku = productUrl.match(/\/(\d+)\.p/)?.[1]
    if (!this.sku) throw new Error(`Cannot extract SKU from Best Buy URL: ${productUrl}`)
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
      if (status === 403 || status === 429) {
        this._consecutiveBlocks += 1
        const cooldown = Math.min(30_000 * 2 ** (this._consecutiveBlocks - 1), 10 * 60_000)
        this._cooldownUntil = Date.now() + cooldown
        log.warn('Best Buy rate-limited — backing off', { sku: this.sku, cooldownMs: cooldown })
        return null
      }
      log.error('Best Buy lookup failed', { sku: this.sku, error: err.message })
      return null
    }

    this._consecutiveBlocks = 0
    this._cooldownUntil = 0
    if (!product) return null

    const { name, price, inStock } = product
    log.info('Polled Best Buy product', {
      sku: this.sku,
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
      retailer: 'bestbuy',
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
  async _fetchViaBrowser() {
    let context = null
    let page = null
    try {
      context = await this.browserPool.launchContext({ accountId: `monitor-bestbuy-${this.sku}` })
      page = await context.newPage()
      return await this._interceptBestBuyApi(page)
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

  async _interceptBestBuyApi(page) {
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

    // Best Buy fires buttonstate and product API calls during page load.
    page
      .route(/\/api\/tcfb\/model\.json|\/api\/2\/json\/product\/|buttonstate/, async (route) => {
        try {
          const response = await route.fetch()
          const json = await response.json().catch(() => null)
          if (json) {
            const parsed = this._parseBestBuyResponse(json)
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

  _parseBestBuyResponse(json) {
    // buttonstate API shape
    const bsVal =
      json?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[this.sku]?.conditions?.NONE
        ?.destinationZip?.['55423']?.storeId?.['281']?.context?.cyp?.addAll?.['false']?.value
    if (bsVal) {
      return {
        name: 'Best Buy Product',
        price: bsVal.price ?? null,
        inStock: bsVal.buttonState === 'ADD_TO_CART'
      }
    }
    // Product API shape
    const product = json?.products?.[0] || json?.product
    if (product) {
      return {
        name: product.name || 'Best Buy Product',
        price: product.salePrice ?? product.regularPrice ?? null,
        inStock: product.addToCartEligible === true || product.onlineAvailability === true
      }
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Axios fallback
  // ---------------------------------------------------------------------------
  async _fetchViaAxios() {
    const { data } = await axios.get('https://www.bestbuy.com/api/tcfb/model.json', {
      timeout: 15000,
      params: {
        paths: `[["shop","buttonstate","v5","item","skus","${this.sku}","conditions","NONE","destinationZip","55423","storeId","281","context","cyp","addAll","false"]]`
      },
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const val =
      data?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[this.sku]?.conditions?.NONE
        ?.destinationZip?.['55423']?.storeId?.['281']?.context?.cyp?.addAll?.['false']?.value
    return {
      name: 'Best Buy Product',
      price: val?.price ?? null,
      inStock: val?.buttonState === 'ADD_TO_CART'
    }
  }
}
