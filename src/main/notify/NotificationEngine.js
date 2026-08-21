import { sendDesktopAlert } from './desktop.js'

export class NotificationEngine {
  constructor({ desktopAlert = sendDesktopAlert, now = () => Date.now() } = {}) {
    this._desktopAlert = desktopAlert
    this._now = now
    this._active = new Set()
    this._health = {
      lastAttempt: null,
      lastShown: null,
      lastFailed: null,
      lastClicked: null
    }
    this._onDesktopEvent = this._onDesktopEvent.bind(this)
  }

  async fire(dropEvent) {
    let result
    try {
      result = await this._desktopAlert(dropEvent, this._onDesktopEvent)
    } catch (error) {
      result = {
        supported: true,
        accepted: false,
        notificationId: null,
        error: String(error?.message || error || 'Desktop notification failed').slice(0, 500)
      }
    }
    const at = this._now()
    this._health.lastAttempt = {
      notificationId: result?.notificationId || null,
      at,
      accepted: result?.accepted === true,
      supported: result?.supported === true
    }
    if (result?.accepted && result.notificationId) this._active.add(result.notificationId)
    if (result?.error) {
      this._health.lastFailed = {
        notificationId: result.notificationId || null,
        at,
        reason: String(result.error).slice(0, 500)
      }
    }
    return result
  }

  _onDesktopEvent(event) {
    if (!event?.notificationId) return
    const evidence = { notificationId: String(event.notificationId).slice(0, 100), at: event.at }
    if (event.event === 'show') this._health.lastShown = evidence
    if (event.event === 'click') this._health.lastClicked = evidence
    if (event.event === 'failed') {
      this._health.lastFailed = {
        ...evidence,
        reason: String(event.error || 'Desktop notification failed').slice(0, 500)
      }
      this._active.delete(event.notificationId)
    }
    if (event.event === 'close') this._active.delete(event.notificationId)
  }

  getHealthSnapshot() {
    return {
      lastAttempt: this._health.lastAttempt ? { ...this._health.lastAttempt } : null,
      lastShown: this._health.lastShown ? { ...this._health.lastShown } : null,
      lastFailed: this._health.lastFailed ? { ...this._health.lastFailed } : null,
      lastClicked: this._health.lastClicked ? { ...this._health.lastClicked } : null,
      activeCount: this._active.size
    }
  }
}
