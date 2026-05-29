import axios from 'axios'
import * as cheerio from 'cheerio'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class GameStopPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.get(this.productUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      const $ = cheerio.load(data)
      const addToCart = $('button.add-to-cart:not([disabled]), button[data-buttonstate="ADD_TO_CART"]').first()
      const inStock = addToCart.length > 0
      const priceText = $('[itemprop="price"], .price-badge__regular-price').first().text().replace(/[^0-9.]/g, '')
      const price = priceText ? parseFloat(priceText) : null
      const name = $('h1.product-name, h1[itemprop="name"]').first().text().trim() || 'GameStop Product'

      if (!inStock) { this._wasInStock = false; return null }
      if (price == null) { this._wasInStock = false; return null }
      if (price > this.maxPrice) { this._wasInStock = false; return null }
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({ retailer: 'gamestop', productName: name, productUrl: this.productUrl, dropType: DROP_TYPES.IN_STOCK, price })
    } catch {
      return null
    }
  }
}
