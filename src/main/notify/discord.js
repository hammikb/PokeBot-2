import axios from 'axios'

export async function sendDiscordAlert({ webhookUrl, dropEvent }) {
  if (!webhookUrl) return
  const color = dropEvent.dropType === 'queue_open' ? 0xf5a623 : 0x00c851
  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title: `DROP: ${dropEvent.productName || 'Unknown Product'}`,
        color,
        fields: [
          { name: 'Retailer', value: dropEvent.retailer || '—', inline: true },
          { name: 'Price', value: dropEvent.price != null ? `$${dropEvent.price}` : '—', inline: true },
          { name: 'Type', value: dropEvent.dropType || '—', inline: true }
        ],
        url: dropEvent.productUrl,
        timestamp: new Date(dropEvent.timestamp).toISOString()
      }]
    })
  } catch {}
}
