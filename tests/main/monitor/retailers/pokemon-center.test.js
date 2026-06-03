import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PokemonCenterPoller } from '../../../../src/main/monitor/retailers/pokemon-center.js'
import axios from 'axios'

vi.mock('axios')

describe('PokemonCenterPoller', () => {
  let poller
  beforeEach(() => {
    poller = new PokemonCenterPoller({
      productUrl: 'https://www.pokemoncenter.com/product/pokemon-etb/290-80551',
      maxPrice: 60
    })
  })

  it('returns null when out of stock', async () => {
    axios.get.mockResolvedValue({ data: { availability: 'OutOfStock', price: 49.99, name: 'ETB' } })
    expect(await poller.poll()).toBeNull()
  })

  it('returns in_stock drop event when available', async () => {
    axios.get.mockResolvedValue({
      data: { availability: 'InStock', price: 49.99, name: 'Pokemon ETB', queueEnabled: false }
    })
    const result = await poller.poll()
    expect(result).not.toBeNull()
    expect(result.retailer).toBe('pokemon-center')
    expect(result.dropType).toBe('in_stock')
  })

  it('returns queue_open when queue enabled', async () => {
    axios.get.mockResolvedValue({
      data: { availability: 'InStock', price: 49.99, name: 'Pokemon ETB', queueEnabled: true }
    })
    const result = await poller.poll()
    expect(result.dropType).toBe('queue_open')
  })

  it('returns null on dedup', async () => {
    axios.get.mockResolvedValue({ data: { availability: 'InStock', price: 49.99, name: 'ETB' } })
    await poller.poll()
    expect(await poller.poll()).toBeNull()
  })

  it('returns null on error', async () => {
    axios.get.mockRejectedValue(new Error('fail'))
    expect(await poller.poll()).toBeNull()
  })
})
