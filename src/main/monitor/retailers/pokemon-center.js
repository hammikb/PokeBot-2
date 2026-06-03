import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class PokemonCenterPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.sku = productUrl.match(/\/product\/[^/]+\/([^/?#]+)$/)?.[1]
    if (!this.sku) throw new Error(`Cannot extract SKU from Pokemon Center URL: ${productUrl}`)
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.get(`https://www.pokemoncenter.com/api/products/${this.sku}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
      })
      const inStock = data?.availability === 'InStock'
      const price = data?.price
      const name = data?.name || 'Pokemon Center Product'
      const queueEnabled = data?.queueEnabled === true

      if (!inStock) {
        this._wasInStock = false
        return null
      }
      if (price == null) return null
      if (price > this.maxPrice) return null
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({
        retailer: 'pokemon-center',
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
