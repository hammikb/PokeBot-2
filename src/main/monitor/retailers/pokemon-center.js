import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class PokemonCenterPoller {
  constructor({ productUrl, maxPrice = Infinity, monitorContext = null, browserPool = null }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.sku = extractPokemonCenterSku(productUrl)
    if (!this.sku) throw new Error(`Cannot extract SKU from Pokemon Center URL: ${productUrl}`)
    this.monitorContext = monitorContext
    this.browserPool = browserPool
    this._wasInStock = false
    this._browserContext = null
    this._browserPage = null
    this._polling = false
  }

  async poll() {
    if (this._polling) return null
    this._polling = true
    try {
      const product =
        this.monitorContext || this.browserPool
          ? await this._fetchViaBrowser()
          : await this._fetchViaApi()
      if (!product) return null

      if (product.queueOpen) {
        this._wasInStock = false
        return createDropEvent({
          retailer: 'pokemon-center',
          productName: product.name || 'Pokemon Center Queue',
          productUrl: this.productUrl,
          dropType: DROP_TYPES.QUEUE_OPEN,
          price: product.price
        })
      }

      if (!product.inStock || product.price == null || product.price > this.maxPrice) {
        this._wasInStock = false
        return null
      }
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({
        retailer: 'pokemon-center',
        productName: product.name || 'Pokemon Center Product',
        productUrl: this.productUrl,
        dropType: DROP_TYPES.IN_STOCK,
        price: product.price
      })
    } catch {
      return null
    } finally {
      this._polling = false
    }
  }

  async _fetchViaBrowser() {
    const page = await this._getPage()
    await page.goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return page.evaluate(() => {
      const text = document.body?.innerText || ''
      const buttons = [...document.querySelectorAll('button')]
      const addButton = buttons.find((button) =>
        /^(preorder:\s*)?add to (cart|basket)$/i.test(button.innerText.trim())
      )
      const queueOpen = buttons.some(
        (button) => /join|enter/i.test(button.innerText) && /queue/i.test(button.innerText)
      )
      const priceMatch = text.match(/\$([0-9]+(?:\.[0-9]{2})?)/)
      return {
        name: document.querySelector('h1')?.textContent?.trim() || document.title,
        price: priceMatch ? Number(priceMatch[1]) : null,
        inStock: Boolean(
          addButton && !addButton.disabled && addButton.getAttribute('aria-disabled') !== 'true'
        ),
        queueOpen
      }
    })
  }

  async _fetchViaApi() {
    const { data } = await axios.get(`https://www.pokemoncenter.com/api/products/${this.sku}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
    })
    return {
      inStock: data?.availability === 'InStock',
      price: Number(data?.price),
      name: data?.name,
      queueOpen: data?.queueEnabled === true
    }
  }

  async _getPage() {
    if (this.monitorContext) return this.monitorContext.getPage(this.sku)
    if (!this._browserContext) {
      this._browserContext = await this.browserPool.launchContext({
        accountId: `monitor-pokemon-center-${this.sku}`
      })
      this._browserPage = await this._browserContext.newPage()
    }
    return this._browserPage
  }

  async destroy() {
    if (this.monitorContext) {
      await this.monitorContext.closePage(this.sku)
      return
    }
    await this._browserContext?.close().catch(() => {})
    this._browserContext = null
    this._browserPage = null
  }
}

function extractPokemonCenterSku(productUrl) {
  try {
    const parts = new URL(productUrl).pathname.split('/').filter(Boolean)
    return parts[0] === 'product' ? parts[1] || null : null
  } catch {
    return null
  }
}
