import { randomUUID } from 'crypto'

const ACTIONABLE_TYPES = new Set(['in_stock', 'restock', 'price_drop', 'preorder', 'available'])
const NOOP = () => {}
const notifierByListener = new WeakMap()

let _Notification = null
let _loaded = false

async function loadNotification() {
  if (_loaded) return _Notification
  _loaded = true
  try {
    const { Notification } = await import('electron')
    _Notification = Notification
  } catch {
    // Desktop notifications are optional outside Electron.
  }
  return _Notification
}

function notificationId(dropEvent) {
  const candidate =
    dropEvent?.eventId || dropEvent?.id || dropEvent?.dropCycleId || randomUUID()
  const sanitized = String(candidate)
    .replace(/[^a-z0-9:._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return sanitized || randomUUID()
}

function safeError(error) {
  return String(error?.message || error || 'Desktop notification failed').slice(0, 500)
}

export function createDesktopNotifier({
  Notification,
  now = () => Date.now(),
  onEvent = NOOP,
  maxActive = 100
}) {
  const active = new Map()
  const emit = (event) => {
    try {
      onEvent(event)
    } catch {
      // Telemetry listeners must never affect notification delivery.
    }
  }

  return {
    send(dropEvent = {}) {
      if (!Notification?.isSupported?.()) {
        return { supported: false, accepted: false, notificationId: null }
      }
      const id = notificationId(dropEvent)
      const actionable = ACTIONABLE_TYPES.has(String(dropEvent.dropType || '').toLowerCase())
      try {
        const options = {
          title: `DROP: ${dropEvent.productName || 'Product update'}`,
          body: `${dropEvent.retailer || 'retailer'} — $${dropEvent.price ?? '?'} — ${dropEvent.dropType || 'update'}`,
          urgency: actionable ? 'critical' : 'normal'
        }
        if (actionable) options.timeoutType = 'never'
        const instance = new Notification(options)
        const lifecycle = (eventName, error = null) => {
          const evidence = { event: eventName, notificationId: id, at: now() }
          if (error) evidence.error = safeError(error)
          emit(evidence)
          if (eventName === 'failed' || eventName === 'close') active.delete(id)
        }
        instance.on?.('show', () => lifecycle('show'))
        instance.on?.('click', () => lifecycle('click'))
        instance.on?.('failed', (...args) => lifecycle('failed', args.at(-1)))
        instance.on?.('close', () => lifecycle('close'))
        active.set(id, instance)
        while (active.size > Math.max(1, maxActive)) {
          const oldestId = active.keys().next().value
          const oldest = active.get(oldestId)
          active.delete(oldestId)
          try {
            oldest?.close?.()
          } catch {
            // Capping retained native objects is best effort.
          }
        }
        instance.show()
        return { supported: true, accepted: true, notificationId: id }
      } catch (error) {
        active.delete(id)
        const message = safeError(error)
        emit({ event: 'failed', notificationId: id, at: now(), error: message })
        return { supported: true, accepted: false, notificationId: id, error: message }
      }
    },
    getActiveCount() {
      return active.size
    }
  }
}

export async function sendDesktopAlert(dropEvent, onEvent = NOOP) {
  const Notification = await loadNotification()
  const listener = typeof onEvent === 'function' ? onEvent : NOOP
  let notifier = notifierByListener.get(listener)
  if (!notifier) {
    notifier = createDesktopNotifier({ Notification, onEvent: listener })
    notifierByListener.set(listener, notifier)
  }
  return notifier.send(dropEvent)
}
