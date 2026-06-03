import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TargetPoller } from '../../../../src/main/monitor/retailers/target.js'
import axios from 'axios'

vi.mock('axios')

const MOCK_IN_STOCK = {
  data: {
    data: {
      product: {
        fulfillment: { shipping_options: { availability_status: 'IN_STOCK' } },
        price: { current_retail: 49.99 },
        item: { product_description: { title: 'Pokemon ETB' } }
      }
    }
  }
}

const MOCK_OUT = {
  data: {
    data: {
      product: {
        fulfillment: { shipping_options: { availability_status: 'UNAVAILABLE' } },
        price: { current_retail: 49.99 },
        item: { product_description: { title: 'Pokemon ETB' } }
      }
    }
  }
}

describe('TargetPoller', () => {
  let poller
  beforeEach(() => {
    poller = new TargetPoller({ productUrl: 'https://www.target.com/p/-/A-12345678', maxPrice: 60 })
  })

  it('returns null when unavailable', async () => {
    axios.get.mockResolvedValue(MOCK_OUT)
    expect(await poller.poll()).toBeNull()
  })

  it('returns drop event when available under max price', async () => {
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    const result = await poller.poll()
    expect(result).not.toBeNull()
    expect(result.retailer).toBe('target')
    expect(result.price).toBe(49.99)
  })

  it('returns null on second poll (dedup)', async () => {
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    await poller.poll()
    expect(await poller.poll()).toBeNull()
  })

  it('fires again after restock', async () => {
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    await poller.poll()
    axios.get.mockResolvedValue(MOCK_OUT)
    await poller.poll()
    axios.get.mockResolvedValue(MOCK_IN_STOCK)
    expect(await poller.poll()).not.toBeNull()
  })

  it('returns null on error', async () => {
    axios.get.mockRejectedValue(new Error('fail'))
    expect(await poller.poll()).toBeNull()
  })
})
