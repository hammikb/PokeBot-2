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
  return normalizeTicket(JSON.parse(raw))
}

/**
 * Normalize one ticket object. Shared by parseQp (the /qp redirect token) and
 * parseTickets (the validateTickets array) -- both carry the same shape.
 */
export function normalizeTicket(d) {
  const cm = d.customMetadata || {}
  const item = cm.item || {}
  const yourTurn =
    d.state === 'valid' ||
    d.queued === false ||
    ['ready', 'admitted', 'checkout'].includes(d.status)
  return {
    state: d.state, // 'pending' | 'valid'
    queued: d.queued === true,
    inQueue: d.state === 'pending' || d.queued === true,
    yourTurn, // CTA becomes "Buy" / checkout when Walmart admits the session
    ticket: d.ticket,
    queueId: d.queue,
    shard: d.shard,
    itemId: d.itemId || item.itemID || null,
    itemUrl: item.itemURL || null,
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

/* ------------------------------------------------------------------ *
 * Queue API. Captured from a live drop 2026-08-19 via DevTools.
 *
 * Two endpoints, and the important property is that polling is FLAT:
 *   issueTicket?queue=<id>  -> appends a block to the `wr` cookie
 *   validateTickets         -> NO parameters; reads the `wr` cookie and
 *                              returns one entry per queue held.
 *
 * So holding 14 queues costs the same per poll as holding 1. Joining is the
 * only per-item cost. This is why an HTTP host beats a browser-per-queue.
 * ------------------------------------------------------------------ */

export const QUEUE_API_ORIGIN = 'https://q-api.www.walmart.com'

export function issueTicketUrl(queueId) {
  if (!queueId) throw new Error('issueTicketUrl requires a queueId')
  return `${QUEUE_API_ORIGIN}/issueTicket?queue=${encodeURIComponent(queueId)}`
}

export function validateTicketsUrl() {
  return `${QUEUE_API_ORIGIN}/validateTickets`
}

/** Header set Walmart's own frontend sends; the API 4xxs without these. */
export function queueApiHeaders(extra = {}) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'tenant-id': 'elh9ie',
    'x-o-mart': 'B2C',
    'x-o-segment': 'oaoh',
    'x-o-platform': 'rweb',
    'x-o-bu': 'WALMART-US',
    wm_mp: 'true',
    origin: 'https://www.walmart.com',
    referer: 'https://www.walmart.com/',
    'accept-language': 'en-US',
    ...extra
  }
}

/** Parse the validateTickets payload (array, one entry per held queue). */
export function parseTickets(payload) {
  let data = payload
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) data = data ? [data] : []
  return data.filter((d) => d && d.queue).map(normalizeTicket)
}

/**
 * Read the `wr` cookie, which is a MULTI-QUEUE container: one block per queue,
 * comma-separated, each `queueId=k1=v1,k2=v2...` with values url-encoded.
 * Lets us recover held tickets after a restart without re-joining.
 */
export function parseWrCookie(value) {
  if (!value) return []
  // The cookie is DOUBLE url-encoded: `%253D` -> `%3D` -> `=`. One decode
  // separates the queue blocks; the field list inside needs a second.
  const decoded = decodeURIComponent(String(value))
  const out = []
  // Split only where a new `<queueId>=` block begins, not on inner commas.
  for (const chunk of decoded.split(/,(?=q[0-9a-f]+=)/i)) {
    const eq = chunk.indexOf('=')
    if (eq === -1) continue
    const queueId = chunk.slice(0, eq).trim()
    let body = chunk.slice(eq + 1)
    if (!body.includes('=') || body.includes('%3D')) body = decodeURIComponent(body)
    const fields = {}
    for (const pair of body.split(',')) {
      const i = pair.indexOf('=')
      if (i === -1) continue
      fields[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
    }
    if (!queueId) continue
    out.push({
      queueId,
      ticket: fields.ticket ? Number(fields.ticket) : null,
      state: fields.state || null,
      itemId: fields.itemId || null,
      offerId: fields.offerId || null,
      shard: fields.shard ? Number(fields.shard) : null,
      expiresMs: fields.expires ? Number(fields.expires) : null
    })
  }
  return out
}

/**
 * Pull every item id out of a Walmart search/browse listing page.
 *
 * The sold-by-Walmart search listing is the only source that covers items the
 * monitor has never published a drop for. Candidate lists built from local
 * tasks or drop history miss those entirely.
 */
export function parseListingItemIds(html = '') {
  const ids = []
  const seen = new Set()
  const re = /"usItemId"\s*:\s*"(\d{6,})"/g
  let match
  while ((match = re.exec(html))) {
    if (!seen.has(match[1])) {
      seen.add(match[1])
      ids.push(match[1])
    }
  }
  return ids
}
