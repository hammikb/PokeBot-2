import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

import { createDesktopNotifier } from '../../../src/main/notify/desktop.js'

function fakeNotification({ supported = true, constructorError = null } = {}) {
  const instances = []
  class FakeNotification extends EventEmitter {
    static isSupported() {
      return supported
    }

    constructor(options) {
      super()
      if (constructorError) throw constructorError
      this.options = options
      this.show = vi.fn()
      instances.push(this)
    }
  }
  return { FakeNotification, instances }
}

describe('createDesktopNotifier', () => {
  it('reports unsupported and constructor failures without throwing', () => {
    const unsupported = fakeNotification({ supported: false })
    expect(createDesktopNotifier({ Notification: unsupported.FakeNotification }).send({}))
      .toMatchObject({ supported: false, accepted: false })

    const broken = fakeNotification({ constructorError: new Error('shell unavailable') })
    expect(createDesktopNotifier({ Notification: broken.FakeNotification }).send({ id: 'd1' }))
      .toMatchObject({ supported: true, accepted: false, error: 'shell unavailable' })
  })

  it('shows urgent stock alerts and emits bounded lifecycle evidence', () => {
    const { FakeNotification, instances } = fakeNotification()
    const events = []
    const notifier = createDesktopNotifier({
      Notification: FakeNotification,
      now: () => 1234,
      onEvent: (event) => events.push(event)
    })
    const result = notifier.send({
      eventId: 'drop/unsafe id',
      retailer: 'target',
      productName: 'Prismatic ETB',
      price: 49.99,
      dropType: 'in_stock'
    })

    expect(result).toMatchObject({ supported: true, accepted: true })
    expect(result.notificationId).toMatch(/^[a-zA-Z0-9:._-]+$/)
    expect(instances[0].options).toMatchObject({ urgency: 'critical', timeoutType: 'never' })
    expect(instances[0].show).toHaveBeenCalledOnce()

    instances[0].emit('show')
    instances[0].emit('click')
    instances[0].emit('failed', {}, new Error('x'.repeat(900)))
    expect(events.map((event) => event.event)).toEqual(['show', 'click', 'failed'])
    expect(events.at(-1).error).toHaveLength(500)
    expect(notifier.getActiveCount()).toBe(0)
  })

  it('uses ordinary priority for checkout-step notifications and retains until close', () => {
    const { FakeNotification, instances } = fakeNotification()
    const notifier = createDesktopNotifier({ Notification: FakeNotification })
    notifier.send({ id: 'step-1', productName: 'Adding to cart', dropType: 'checkout_step' })
    expect(instances[0].options.urgency).toBe('normal')
    expect(instances[0].options.timeoutType).toBeUndefined()
    expect(notifier.getActiveCount()).toBe(1)
    instances[0].emit('close')
    expect(notifier.getActiveCount()).toBe(0)
  })
})
