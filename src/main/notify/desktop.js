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

export async function sendDesktopAlert(dropEvent) {
  const Notification = await loadNotification()
  if (!Notification?.isSupported?.()) return
  try {
    const n = new Notification({
      title: `DROP: ${dropEvent.productName}`,
      body: `${dropEvent.retailer} — $${dropEvent.price ?? '?'} — ${dropEvent.dropType}`
    })
    n.show()
  } catch {
    // Notification delivery should never break monitoring or checkout.
  }
}
