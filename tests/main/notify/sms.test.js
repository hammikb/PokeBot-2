import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendSmsAlert } from '../../../src/main/notify/sms.js'

const mockCreate = vi.fn().mockResolvedValue({ sid: 'SM123' })
vi.mock('twilio', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } }))
}))

describe('sendSmsAlert', () => {
  beforeEach(() => {
    mockCreate.mockClear()
    mockCreate.mockResolvedValue({ sid: 'SM123' })
  })

  it('sends SMS with drop info', async () => {
    await sendSmsAlert({
      accountSid: 'ACtest',
      authToken: 'token',
      from: '+10000000000',
      to: '+19999999999',
      dropEvent: { retailer: 'walmart', productName: 'ETB', price: 49.99 }
    })
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('walmart'),
        to: '+19999999999'
      })
    )
  })

  it('does nothing when credentials missing', async () => {
    await sendSmsAlert({ accountSid: null, authToken: null, from: null, to: null, dropEvent: {} })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('does not throw on Twilio error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('twilio fail'))
    await expect(
      sendSmsAlert({
        accountSid: 'AC',
        authToken: 'tok',
        from: '+1',
        to: '+2',
        dropEvent: { retailer: 'walmart', productName: 'ETB', price: 49 }
      })
    ).resolves.not.toThrow()
  })
})
