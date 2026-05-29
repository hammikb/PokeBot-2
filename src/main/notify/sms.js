import Twilio from 'twilio'

export async function sendSmsAlert({ accountSid, authToken, from, to, dropEvent }) {
  if (!accountSid || !authToken || !from || !to) return
  try {
    const client = Twilio(accountSid, authToken)
    await client.messages.create({
      body: `DROP: ${dropEvent.productName} @ ${dropEvent.retailer} — $${dropEvent.price ?? '?'}`,
      from,
      to
    })
  } catch {}
}
