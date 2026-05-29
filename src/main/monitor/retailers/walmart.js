import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class WalmartPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.itemId = productUrl.split('/').pop().split('?')[0]
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.get(
        `https://www.walmart.com/ip/${this.itemId}`,
        {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          params: { 'modules': 'item' }
        }
      )
      const status = data?.availabilityStatus
      const price = data?.priceInfo?.currentPrice?.price
      const name = data?.name || 'Walmart Product'

      if (status !== 'IN_STOCK') { this._wasInStock = false; return null }
      if (price > this.maxPrice) return null
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({
        retailer: 'walmart',
        productName: name,
        productUrl: this.productUrl,
        dropType: DROP_TYPES.IN_STOCK,
        price
      })
    } catch {
      return null
    }
  }
}
