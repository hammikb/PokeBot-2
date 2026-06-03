import Twilio from 'twilio'

export async function sendSmsAlert({ accountSid, authToken, from, to, dropEvent }) {
  if (!accountSid || !authToken || !from || !to) return
  try {
    const client = Twilio(accountSid, authToken)
    await client.messages.create({
      body: `DROP: ${dropEvent.productName ?? 'Unknown'} @ ${dropEvent.retailer} — $${dropEvent.price ?? '?'}`,
      from,
      to
    })
  } catch {
    // Notification delivery should never break monitoring or checkout.
  }
}
