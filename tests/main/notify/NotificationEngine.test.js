import { describe, it, expect, vi } from 'vitest'
import { NotificationEngine } from '../../../src/main/notify/NotificationEngine.js'

vi.mock('../../../src/main/notify/desktop.js', () => ({
  sendDesktopAlert: vi.fn().mockResolvedValue({
    supported: true,
    accepted: true,
    notificationId: 'drop-1'
  })
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
    expect(sendDesktopAlert).toHaveBeenCalledWith(event, expect.any(Function))
    expect(engine.getHealthSnapshot()).toMatchObject({
      lastAttempt: expect.objectContaining({ notificationId: 'drop-1' }),
      activeCount: 1
    })
  })

  it('records later lifecycle events without exposing notification objects', async () => {
    const engine = new NotificationEngine({ now: () => 1000 })
    await engine.fire({ eventId: 'drop-1', productName: 'ETB' })
    const onEvent = sendDesktopAlert.mock.calls.at(-1)[1]
    onEvent({ event: 'show', notificationId: 'drop-1', at: 1100 })
    onEvent({ event: 'click', notificationId: 'drop-1', at: 1200 })
    onEvent({ event: 'close', notificationId: 'drop-1', at: 1300 })
    expect(engine.getHealthSnapshot()).toEqual({
      lastAttempt: { notificationId: 'drop-1', at: 1000, accepted: true, supported: true },
      lastShown: { notificationId: 'drop-1', at: 1100 },
      lastFailed: null,
      lastClicked: { notificationId: 'drop-1', at: 1200 },
      activeCount: 0
    })
  })
})
