import { randomUUID } from 'crypto'

export function createDropEvent({ retailer, productName, productUrl, dropType, price = null }) {
  return {
    id: randomUUID(),
    retailer,
    productName,
    productUrl,
    dropType,
    price,
    timestamp: Date.now()
  }
}
