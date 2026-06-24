import axios from 'axios'
import * as cheerio from 'cheerio'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('CostcoPoller')

export class CostcoPoller {
  constructor({ productUrl, maxPrice = Infinity, browserPool = null }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.browserPool = browserPool
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
        log.warn('Costco rate-limited — backing off', { cooldownMs: cooldown })
        return null
      }
      log.error('Costco lookup failed', { error: err.message })
      return null
    }

    this._consecutiveBlocks = 0
    this._cooldownUntil = 0
    if (!product) return null

    const { name, price, inStock, queueEnabled } = product
    log.info('Polled Costco product', {
      inStock,
      price,
      name,
      queueEnabled,
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
      retailer: 'costco',
      productName: name,
      productUrl: this.productUrl,
      dropType: queueEnabled ? DROP_TYPES.QUEUE_OPEN : DROP_TYPES.IN_STOCK,
      price,
      isFirstCheck
    })
  }

  // ---------------------------------------------------------------------------
  // Browser-based interception (Guppy-style)
  // ---------------------------------------------------------------------------
  // Costco fires a product API call during page load. We intercept it for
  // availability + price, and fall back to HTML parsing if it doesn't fire.
  async _fetchViaBrowser() {
    let context = null
    let page = null
    try {
      context = await this.browserPool.launchContext({ accountId: `monitor-costco-${Date.now()}` })
      page = await context.newPage()
      return await this._interceptCostcoApi(page)
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

  async _interceptCostcoApi(page) {
    let resolveData
    const dataPromise = new Promise((res) => {
      resolveData = res
    })
    let resolved = false
    let apiData = null
    let htmlData = null

    const tryResolve = () => {
      if (resolved) return
      if (apiData || htmlData) {
        resolved = true
        clearTimeout(timer)
        resolveData(apiData || htmlData)
      }
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolveData(apiData || htmlData)
      }
    }, 20_000)

    // Intercept Costco's product/inventory API calls
    page
      .route(
        /\/AjaxGetProductAvailability|\/api\/2\/products\/|\/product\/api\//,
        async (route) => {
          try {
            const response = await route.fetch()
            const json = await response.json().catch(() => null)
            if (json) {
              const parsed = this._parseCostcoApiResponse(json)
              if (parsed) {
                apiData = parsed
                tryResolve()
              }
            }
            await route.fulfill({ response })
          } catch {
            await route.abort().catch(() => {})
            tryResolve()
          }
        }
      )
      .catch(() => {})

    // Navigate and parse HTML as fallback
    const htmlResult = await page
      .goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      .then(async () => {
        const html = await page.content().catch(() => null)
        return html ? this._parseCostcoHtml(html) : null
      })
      .catch(() => null)

    if (htmlResult && !apiData) {
      htmlData = htmlResult
      tryResolve()
    }

    if (!resolved) resolveData(apiData || htmlData)
    return dataPromise
  }

  _parseCostcoApiResponse(json) {
    const product = json?.product || json?.data?.product || json
    if (!product) return null
    const inStock =
      product.availability === 'IN_STOCK' ||
      product.addToCartEligible === true ||
      product.onlineAvailability === true
    const price = product.finalPrice ?? product.price?.value ?? null
    const name = product.productName || product.name || 'Costco Product'
    const queueEnabled = Boolean(product.queueEnabled || product.waitingRoom)
    if (!name && !inStock) return null
    return { name, price, inStock, queueEnabled }
  }

  _parseCostcoHtml(html) {
    const $ = cheerio.load(html)
    const addToCartBtn = $('input#add-to-cart-btn, button[id*="add-to-cart"]').first()
    const inStock = addToCartBtn.length > 0 && !addToCartBtn.attr('disabled')
    const priceText = $('.your-price .value, .price-value')
      .first()
      .text()
      .replace(/[^0-9.]/g, '')
    const price = priceText ? parseFloat(priceText) : null
    const name = $('h1.product-title').first().text().trim() || 'Costco Product'
    const queueEnabled = $('[class*="queue"], [id*="waiting-room"]').length > 0
    return { name, price, inStock, queueEnabled }
  }

  // ---------------------------------------------------------------------------
  // Axios fallback (HTML scraping)
  // ---------------------------------------------------------------------------
  async _fetchViaAxios() {
    const { data } = await axios.get(this.productUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }
    })
    return this._parseCostcoHtml(data)
  }
}
