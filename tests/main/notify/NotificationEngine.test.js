import { describe, it, expect, vi } from 'vitest'
import { NotificationEngine } from '../../../src/main/notify/NotificationEngine.js'

vi.mock('../../../src/main/notify/desktop.js', () => ({
  sendDesktopAlert: vi.fn().mockResolvedValue(undefined)
}))

import { sendDesktopAlert } from '../../../src/main/notify/desktop.js'

describe('NotificationEngine', () => {
  it('fires a desktop notification on a drop event', async () => {
    const engine = new NotificationEngine()
    const event = {
      retailer: 'walmart',
      productName: 'ETB',
      price: 49.99,
      dropType: 'in_stock',
      timestamp: Date.now()
    }
    await engine.fire(event)
    expect(sendDesktopAlert).toHaveBeenCalledWith(event)
  })
})
