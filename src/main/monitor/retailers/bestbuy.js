import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class BestBuyPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.sku = productUrl.match(/\/(\d+)\.p/)?.[1]
    if (!this.sku) throw new Error(`Cannot extract SKU from Best Buy URL: ${productUrl}`)
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.get(
        `https://www.bestbuy.com/api/tcfb/model.json`,
        {
          params: { paths: `[["shop","buttonstate","v5","item","skus","${this.sku}","conditions","NONE","destinationZip","55423","storeId","281","context","cyp","addAll","false"]]` },
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }
      )
      const val = data?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[this.sku]?.conditions?.NONE?.destinationZip?.['55423']?.storeId?.['281']?.context?.cyp?.addAll?.['false']?.value
      const purchasable = val?.buttonState === 'ADD_TO_CART'
      const price = val?.price

      if (!purchasable) { this._wasInStock = false; return null }
      if (price == null) { this._wasInStock = false; return null }
      if (price > this.maxPrice) { this._wasInStock = false; return null }
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({ retailer: 'bestbuy', productName: 'Best Buy Product', productUrl: this.productUrl, dropType: DROP_TYPES.IN_STOCK, price })
    } catch {
      return null
    }
  }
}
