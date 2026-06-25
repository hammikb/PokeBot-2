/**
 * walmartQueue.js — detect & read Walmart virtual-queue ("/qp") state.
 *
 * We only READ the token. The `signature` inside it is Walmart's signed proof of
 * your spot in line; never forge or replay it. One real session takes one real
 * spot — same as a person, minus the manual F5. (See POKEBOT2_queue_feature_spec.md)
 */

/** Pull a qpdata token out of an HTML body if present (else null). */
export function extractQpdataFromText(body) {
  const marker = 'qpdata='
  const i = body.indexOf(marker)
  if (i === -1) return null
  const rest = body.slice(i + marker.length)
  const ends = ['"', "'", '&', ' ', '<'].map((c) => rest.indexOf(c)).filter((p) => p !== -1)
  return rest.slice(0, ends.length ? Math.min(...ends) : rest.length)
}

/** True if this URL/body got gated into the waiting room. */
export function isQueueActive({ url = '', body = '' } = {}) {
  if (url.includes('/qp') || url.includes('qpdata=')) return true
  return body.includes('qpdata') || (body.includes('"queue"') && body.includes('"ticket"'))
}

/** Decode a full /qp URL or a raw qpdata token into a flat status object. */
export function parseQp(urlOrToken) {
  let raw = urlOrToken
  if (urlOrToken.includes('qpdata=')) {
    raw = new URL(urlOrToken, 'https://www.walmart.com').searchParams.get('qpdata') || urlOrToken
  }
  // token may be url-encoded once or twice; decode until it looks like JSON
  for (let i = 0; i < 3 && !raw.trimStart().startsWith('{'); i++) {
    raw = decodeURIComponent(raw)
  }
  const d = JSON.parse(raw)
  const cm = d.customMetadata || {}
  const item = cm.item || {}
  return {
    state: d.state, // 'pending' | 'valid'
    inQueue: d.state === 'pending',
    yourTurn: d.state === 'valid', // CTA becomes "Buy"
    ticket: d.ticket,
    queueId: d.queue,
    shard: d.shard,
    itemId: d.itemId,
    offerId: d.offerId,
    itemName: item.name || null,
    price: item.currentPrice || null,
    admissionLikelihood: cm.admissionLikelihood || null, // Walmart's own odds
    refreshSec: (d.nextRefreshRelativeTime || 30000) / 1000,
    expectedTurnMs: d.expectedTurnTimeUnixTimestamp || null,
    expiresMs: d.expires || null,
    signature: d.signature || null // reuse only, never forge
  }
}

/** Rough seconds until your expected turn, from the token's own estimate. */
export function secondsUntilTurn(status) {
  const t = status?.expectedTurnMs
  return !t ? null : Math.max(0, t / 1000 - Date.now() / 1000)
}
