import { sendDiscordAlert } from './discord.js'
import { sendSmsAlert } from './sms.js'
import { sendDesktopAlert } from './desktop.js'

export class NotificationEngine {
  constructor(settingsGetter) {
    this._getSettings = settingsGetter
  }

  async fire(dropEvent) {
    const s = this._getSettings()
    await Promise.allSettled([
      sendDiscordAlert({ webhookUrl: s.discordWebhook, dropEvent }),
      sendSmsAlert({ accountSid: s.twilioSid, authToken: s.twilioToken, from: s.twilioFrom, to: s.twilioTo, dropEvent }),
      sendDesktopAlert(dropEvent)
    ])
  }
}
