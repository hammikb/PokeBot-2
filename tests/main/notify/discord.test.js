import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendDiscordAlert } from '../../../src/main/notify/discord.js'
import axios from 'axios'

vi.mock('axios')

describe('sendDiscordAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('POSTs embed to webhook URL', async () => {
    axios.post.mockResolvedValue({ status: 204 })
    await sendDiscordAlert({
      webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      dropEvent: { retailer: 'walmart', productName: 'ETB', price: 49.99, productUrl: 'https://walmart.com/ip/123', dropType: 'in_stock', timestamp: Date.now() }
    })
    expect(axios.post).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ embeds: expect.any(Array) })
    )
  })

  it('does not throw on network error', async () => {
    axios.post.mockRejectedValue(new Error('network'))
    await expect(sendDiscordAlert({ webhookUrl: 'https://discord.com/api/webhooks/123/abc', dropEvent: {} })).resolves.not.toThrow()
  })

  it('does nothing when webhookUrl is missing', async () => {
    await sendDiscordAlert({ webhookUrl: null, dropEvent: { retailer: 'walmart' } })
    expect(axios.post).not.toHaveBeenCalled()
  })
})
