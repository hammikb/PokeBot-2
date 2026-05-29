import { describe, it, expect, vi } from 'vitest'
import { NotificationEngine } from '../../../src/main/notify/NotificationEngine.js'

vi.mock('../../../src/main/notify/discord.js', () => ({ sendDiscordAlert: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../src/main/notify/sms.js', () => ({ sendSmsAlert: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../src/main/notify/desktop.js', () => ({ sendDesktopAlert: vi.fn().mockResolvedValue(undefined) }))

import { sendDiscordAlert } from '../../../src/main/notify/discord.js'
import { sendSmsAlert } from '../../../src/main/notify/sms.js'
import { sendDesktopAlert } from '../../../src/main/notify/desktop.js'

describe('NotificationEngine', () => {
  it('fires all 3 channels on drop event', async () => {
    const settings = { discordWebhook: 'https://discord.com/api/webhooks/1', twilioSid: 'AC', twilioToken: 'tok', twilioFrom: '+1', twilioTo: '+2' }
    const engine = new NotificationEngine(() => settings)
    const event = { retailer: 'walmart', productName: 'ETB', price: 49.99, dropType: 'in_stock', timestamp: Date.now() }
    await engine.fire(event)
    expect(sendDiscordAlert).toHaveBeenCalledWith({ webhookUrl: settings.discordWebhook, dropEvent: event })
    expect(sendSmsAlert).toHaveBeenCalledWith({ accountSid: settings.twilioSid, authToken: settings.twilioToken, from: settings.twilioFrom, to: settings.twilioTo, dropEvent: event })
    expect(sendDesktopAlert).toHaveBeenCalledWith(event)
  })

  it('reads settings at call-time not construction-time', async () => {
    let webhookUrl = 'https://initial.webhook'
    const engine = new NotificationEngine(() => ({ discordWebhook: webhookUrl }))
    webhookUrl = 'https://updated.webhook'
    await engine.fire({ retailer: 'walmart', productName: 'Test', price: 10, dropType: 'in_stock', timestamp: Date.now() })
    expect(sendDiscordAlert).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: 'https://updated.webhook' }))
  })

  it('resolves even when a channel throws', async () => {
    sendDiscordAlert.mockRejectedValueOnce(new Error('discord down'))
    const engine = new NotificationEngine(() => ({}))
    await expect(engine.fire({ retailer: 'test', productName: 'X', price: 1, dropType: 'in_stock', timestamp: Date.now() })).resolves.not.toThrow()
  })
})
