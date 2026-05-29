import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class SamsClubPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.itemId = productUrl.match(/\/p\/[^/]+\/(\d+)/)?.[1]
    if (!this.itemId) throw new Error(`Cannot extract item ID from Sam's Club URL: ${productUrl}`)
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.post(
        'https://www.samsclub.com/api/node/vivaldi/v2/products/graphql',
        {
          query: `query { product(itemId:"${this.itemId}") { name price { finalPrice { amount } } availabilityStatus } }`
        },
        { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
      )
      const product = data?.data?.product
      const inStock = product?.availabilityStatus === 'IN_STOCK'
      const price = product?.price?.finalPrice?.amount
      const name = product?.name || "Sam's Club Product"

      if (!inStock) { this._wasInStock = false; return null }
      if (price == null) return null
      if (price > this.maxPrice) return null
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({ retailer: 'samsclub', productName: name, productUrl: this.productUrl, dropType: DROP_TYPES.IN_STOCK, price })
    } catch {
      return null
    }
  }
}
