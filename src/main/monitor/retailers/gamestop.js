import axios from 'axios'
import * as cheerio from 'cheerio'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('GameStopPoller')

export class GameStopPoller {
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
        log.warn('GameStop rate-limited — backing off', { cooldownMs: cooldown })
        return null
      }
      log.error('GameStop lookup failed', { error: err.message })
      return null
    }

    this._consecutiveBlocks = 0
    this._cooldownUntil = 0
    if (!product) return null

    const { name, price, inStock } = product
    log.info('Polled GameStop product', {
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
      retailer: 'gamestop',
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
  // GameStop uses Salesforce Commerce Cloud. We intercept the product API call
  // that fires during page load — it returns availability + price as JSON.
  async _fetchViaBrowser() {
    let context = null
    let page = null
    try {
      context = await this.browserPool.launchContext({
        accountId: `monitor-gamestop-${Date.now()}`
      })
      page = await context.newPage()
      return await this._interceptGameStopApi(page)
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

  async _interceptGameStopApi(page) {
    let resolveData
    const dataPromise = new Promise((res) => {
      resolveData = res
    })
    let resolved = false
    let productData = null
    let htmlData = null

    const tryResolve = () => {
      if (resolved) return
      if (productData || htmlData) {
        resolved = true
        clearTimeout(timer)
        resolveData(productData || htmlData)
      }
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolveData(productData || htmlData)
      }
    }, 20_000)

    // Intercept GameStop's SFCC product API
    page
      .route(/\/on\/demandware\.store\/.*\/Product-Variation|\/api\/products\//, async (route) => {
        try {
          const response = await route.fetch()
          const json = await response.json().catch(() => null)
          if (json) {
            const parsed = this._parseGameStopApiResponse(json)
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

    // Also capture the HTML as fallback (parse after navigation)
    const htmlResult = await page
      .goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      .then(async () => {
        const html = await page.content().catch(() => null)
        return html ? this._parseGameStopHtml(html) : null
      })
      .catch(() => null)

    if (htmlResult && !productData) {
      htmlData = htmlResult
      tryResolve()
    }

    if (!resolved) resolveData(productData || htmlData)
    return dataPromise
  }

  _parseGameStopApiResponse(json) {
    const product = json?.product || json
    if (!product?.id) return null
    return {
      name: product.productName || product.name || 'GameStop Product',
      price: product.price?.sales?.value ?? product.price?.list?.value ?? null,
      inStock: product.available === true || product.availability?.available === true
    }
  }

  _parseGameStopHtml(html) {
    const $ = cheerio.load(html)
    const addToCart = $(
      'button.add-to-cart:not([disabled]), button[data-buttonstate="ADD_TO_CART"]'
    ).first()
    const inStock = addToCart.length > 0
    const priceText = $('[itemprop="price"], .price-badge__regular-price')
      .first()
      .text()
      .replace(/[^0-9.]/g, '')
    const price = priceText ? parseFloat(priceText) : null
    const name =
      $('h1.product-name, h1[itemprop="name"]').first().text().trim() || 'GameStop Product'
    if (!name && !inStock) return null
    return { name, price, inStock }
  }

  // ---------------------------------------------------------------------------
  // Axios fallback (HTML scraping)
  // ---------------------------------------------------------------------------
  async _fetchViaAxios() {
    const { data } = await axios.get(this.productUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    return this._parseGameStopHtml(data)
  }
}
