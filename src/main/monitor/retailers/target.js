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
    this._isFirstPoll = true
  }

  async poll() {
    try {
      console.log(`[TargetPoller] Polling TCIN ${this.tcin}, isFirstPoll: ${this._isFirstPoll}`)
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
      
      console.log(`[TargetPoller] Status: ${status}, Price: ${price}, Name: ${name}`)

      if (status !== 'IN_STOCK') {
        this._wasInStock = false
        this._isFirstPoll = false
        return null
      }
      if (price == null) {
        this._wasInStock = false
        this._isFirstPoll = false
        return null
      }
      if (price > this.maxPrice) {
        this._wasInStock = false
        this._isFirstPoll = false
        return null
      }
      
      // Allow event on first poll even if already in stock
      // After first poll, only emit on state changes (restock)
      if (this._wasInStock && !this._isFirstPoll) {
        return null
      }

      this._wasInStock = true
      const isFirstCheck = this._isFirstPoll
      this._isFirstPoll = false
      
      return createDropEvent({
        retailer: 'target',
        productName: name,
        productUrl: this.productUrl,
        dropType: DROP_TYPES.IN_STOCK,
        price,
        isFirstCheck
      })
    } catch {
      return null
    }
  }
}
