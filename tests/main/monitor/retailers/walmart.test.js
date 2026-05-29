import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalmartPoller } from '../../../../src/main/monitor/retailers/walmart.js'
import axios from 'axios'

vi.mock('axios')

describe('WalmartPoller', () => {
  let poller
  beforeEach(() => {
    poller = new WalmartPoller({
      productUrl: 'https://www.walmart.com/ip/pokemon-etb/123456789',
      maxPrice: 60
    })
  })

  it('returns null when out of stock', async () => {
    axios.get.mockResolvedValue({ data: { availabilityStatus: 'OUT_OF_STOCK', priceInfo: { currentPrice: { price: 49.99 } } } })
    expect(await poller.poll()).toBeNull()
  })

  it('returns drop event when in stock under max price', async () => {
    axios.get.mockResolvedValue({ data: { availabilityStatus: 'IN_STOCK', priceInfo: { currentPrice: { price: 49.99 } }, name: 'Pokemon ETB' } })
    const result = await poller.poll()
    expect(result).not.toBeNull()
    expect(result.retailer).toBe('walmart')
    expect(result.dropType).toBe('in_stock')
    expect(result.price).toBe(49.99)
  })

  it('returns null when price exceeds max', async () => {
    axios.get.mockResolvedValue({ data: { availabilityStatus: 'IN_STOCK', priceInfo: { currentPrice: { price: 70 } } } })
    expect(await poller.poll()).toBeNull()
  })

  it('returns null on request error', async () => {
    axios.get.mockRejectedValue(new Error('network error'))
    expect(await poller.poll()).toBeNull()
  })
})
