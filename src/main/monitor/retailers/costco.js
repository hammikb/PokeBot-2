import axios from 'axios'
import * as cheerio from 'cheerio'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class CostcoPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.get(this.productUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }
      })
      const $ = cheerio.load(data)
      const addToCartBtn = $('input#add-to-cart-btn, button[id*="add-to-cart"]').first()
      const inStock = addToCartBtn.length > 0 && !addToCartBtn.attr('disabled')
      const priceText = $('.your-price .value, .price-value').first().text().replace(/[^0-9.]/g, '')
      const price = priceText ? parseFloat(priceText) : null
      const name = $('h1.product-title').first().text().trim() || 'Costco Product'
      const queueEnabled = $('[class*="queue"], [id*="waiting-room"]').length > 0

      if (!inStock) { this._wasInStock = false; return null }
      if (price == null) return null
      if (price > this.maxPrice) return null
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({
        retailer: 'costco',
        productName: name,
        productUrl: this.productUrl,
        dropType: queueEnabled ? DROP_TYPES.QUEUE_OPEN : DROP_TYPES.IN_STOCK,
        price
      })
    } catch {
      return null
    }
  }
}
