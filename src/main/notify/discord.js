import axios from 'axios'

export async function sendDiscordAlert({ webhookUrl, dropEvent }) {
  if (!webhookUrl) return
  const COLOR_MAP = { in_stock: 0x00c851, queue_open: 0xf5a623, price_drop: 0x2196f3 }
  const color = COLOR_MAP[dropEvent.dropType] ?? 0x00c851
  try {
    await axios.post(webhookUrl, {
      embeds: [
        {
          title: `DROP: ${dropEvent.productName || 'Unknown Product'}`,
          color,
          fields: [
            { name: 'Retailer', value: dropEvent.retailer || '—', inline: true },
            {
              name: 'Price',
              value: dropEvent.price != null ? `$${dropEvent.price}` : '—',
              inline: true
            },
            { name: 'Type', value: dropEvent.dropType || '—', inline: true }
          ],
          url: dropEvent.productUrl,
          timestamp: new Date(dropEvent.timestamp).toISOString()
        }
      ]
    })
  } catch {
    // Notification delivery should never break monitoring or checkout.
  }
}
