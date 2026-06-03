import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

export class TargetPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.tcin = productUrl.match(/A-(\d+)/)?.[1]
    if (!this.tcin) throw new Error(`Cannot extract TCIN from URL: ${productUrl}`)
    this._wasInStock = false
  }

  async poll() {
    try {
      const { data } = await axios.get(
        'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1',
        {
          params: {
            key: 'ff457966e64d5e877fdbad070f276d18ecec4a01',
            tcin: this.tcin,
            store_id: '3991'
          },
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }
      )
      const product = data?.data?.product
      const status = product?.fulfillment?.shipping_options?.availability_status
      const price = product?.price?.current_retail
      const name = product?.item?.product_description?.title || 'Target Product'

      if (status !== 'IN_STOCK') {
        this._wasInStock = false
        return null
      }
      if (price == null) {
        this._wasInStock = false
        return null
      }
      if (price > this.maxPrice) {
        this._wasInStock = false
        return null
      }
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({
        retailer: 'target',
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
