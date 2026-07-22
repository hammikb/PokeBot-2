import { sendDesktopAlert } from './desktop.js'

export class NotificationEngine {
  async fire(dropEvent) {
    await sendDesktopAlert(dropEvent)
  }
}
