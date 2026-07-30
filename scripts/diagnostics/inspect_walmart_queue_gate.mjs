/**
 * One-request Walmart product-gate diagnostic.
 *
 * Deploy into server-side-alert-bot/src/entry/ on the Pi. It uses one warmed,
 * proxy-pinned Walmart session and reports queue signals without printing the
 * queue token, cookies, proxy credentials, or signed ticket.
 */
import 'dotenv/config'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createRedis } from '../redis.js'
import { buildProxyUrl } from '../proxy/parse.js'
import { CookieStore } from '../state/cookieStore.js'

const itemId = String(process.argv[2] || '').trim()
if (!/^\d+$/.test(itemId)) throw new Error('A numeric Walmart item ID is required')

const redis = createRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379')
const cookieStore = new CookieStore(redis)

try {
  const pair = await cookieStore.getFreshPair('walmart')
  if (!pair) throw new Error('No warmed Walmart session is available')

  const productUrl = `https://www.walmart.com/ip/${itemId}`
  const proxyUrl = buildProxyUrl(pair.proxy)
  const agent = new HttpsProxyAgent(proxyUrl)
  let currentUrl = productUrl
  let referer = 'https://www.walmart.com/'
  const hops = []

  for (let hop = 0; hop < 5; hop += 1) {
    const response = await axios.get(currentUrl, {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      maxRedirects: 0,
      responseType: 'text',
      timeout: 30_000,
      validateStatus: () => true,
      maxContentLength: 1_000_000,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        cookie: pair.cookieHeader,
        referer,
        'user-agent': pair.ua
      }
    })

    const body = String(response.data || '')
    const rawLocation = String(response.headers?.location || '')
    let locationPath = null
    let locationHasQpdata = false
    let nextUrl = null
    if (rawLocation) {
      const location = new URL(rawLocation, currentUrl)
      locationPath = location.pathname
      locationHasQpdata = location.searchParams.has('qpdata')
      nextUrl = location.href
    }

    const signals = {
      status: response.status,
      requestPath: new URL(currentUrl).pathname,
      locationPath,
      locationHasQpdata,
      bodyBytes: Buffer.byteLength(body),
      bodyHasQpdata: body.includes('qpdata=') || body.includes('"qpdata"'),
      bodyHasIssueTicket: body.includes('issueTicket'),
      bodyHasQueueText: /hold my spot|you(?:'|’)re in line|almost gone|queue/i.test(body)
    }
    hops.push(signals)

    if (
      signals.locationHasQpdata ||
      signals.locationPath === '/qp' ||
      signals.bodyHasQpdata ||
      signals.bodyHasIssueTicket
    ) {
      break
    }
    if (!nextUrl || response.status < 300 || response.status >= 400) break
    referer = currentUrl
    currentUrl = nextUrl
  }

  console.log(JSON.stringify({ itemId, hops }))
} finally {
  await redis.quit()
}
