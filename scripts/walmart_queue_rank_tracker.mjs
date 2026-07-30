/**
 * Production entrypoint for the Pi's server-side-alert-bot rank-tracker image.
 *
 * It uses one Walmart category-page request per interval, then makes a single
 * redirect-only product request for page-one candidates that have not been
 * checked recently. A 3xx redirect to /qp is the queue-open signal. Queue
 * tokens, cookies, and proxy credentials are never logged or published.
 *
 * Deploy as:
 *   /home/hammikb/server-side-alert-bot/src/entry/rankTracker.entry.js
 */
import 'dotenv/config'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createRedis } from '../redis.js'
import { CookieStore } from '../state/cookieStore.js'
import { httpGet } from '../worker/httpClient.js'
import { buildProxyUrl } from '../proxy/parse.js'
import { parseWalmartBrowse, compareWalmartBrowse } from '../parse/walmartBrowse.js'
import { createDropEvent, DROP_TYPES } from '../lib/events.js'
import { createRouter } from '../notify/router.js'
import { createSupabaseClient } from '../supabase/client.js'
import { createSupabasePublisher } from '../notify/supabasePublisher.js'
import { createModuleLogger } from '../logger.js'

const log = createModuleLogger('WalmartRankTracker')
const BLOCK_STATUSES = new Set([403, 412, 418, 429])
const DEFAULT_URL =
  'https://www.walmart.com/browse/collectibles/pokemon-cards/5967908_9807313_4252400?seo=collectibles&seo=pokemon-cards&seo=5967908_9807313_4252400&facet=retailer_type%3AWalmart%7C%7Cfacet_product_type%3ATrading+Cards%7C%7Cfacet_product_type%3ATrading+Card+Games%7C%7Cfacet_product_type%3ACard+Games&sort=new&affinityOverride=default&page=1'

const numberFromEnv = (name, fallback, min, max) => {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

const intervalMs = numberFromEnv('RANK_TRACKER_INTERVAL_MS', 60_000, 30_000, 15 * 60_000)
const maxRuntimeMs = numberFromEnv(
  'RANK_TRACKER_MAX_RUNTIME_MS',
  45 * 60_000,
  60_000,
  2 * 60 * 60_000
)
const maxRequests = numberFromEnv('RANK_TRACKER_MAX_REQUESTS', 45, 1, 120)
const maxQueueProbes = numberFromEnv('RANK_TRACKER_MAX_QUEUE_PROBES', 150, 1, 500)
const queueProbeCooldownMs = numberFromEnv(
  'RANK_TRACKER_QUEUE_PROBE_COOLDOWN_MS',
  10 * 60_000,
  60_000,
  60 * 60_000
)
const queueProbeDelayMs = numberFromEnv('RANK_TRACKER_QUEUE_PROBE_DELAY_MS', 1_250, 500, 10_000)
const browseUrl = process.env.RANK_TRACKER_URL || DEFAULT_URL

let stopping = false
let wakeWait = null
const wait = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeWait = null
      resolve()
    }, ms)
    wakeWait = () => {
      clearTimeout(timer)
      wakeWait = null
      resolve()
    }
  })
const requestStop = () => {
  stopping = true
  wakeWait?.()
}
process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)

async function main() {
  const redis = createRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379')
  const cookieStore = new CookieStore(redis)
  const supabase = createSupabaseClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  )
  const routeAlert = createRouter({
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
    supabasePublisher: supabase ? createSupabasePublisher(supabase) : undefined
  })
  const startedAt = Date.now()
  const probedAt = new Map()
  const queueAlertedAt = new Map()
  let requests = 0
  let queueProbes = 0
  let previous = null

  log.info('Drop tracker started', {
    intervalMs,
    maxRuntimeMs,
    maxRequests,
    maxQueueProbes,
    queueProbeCooldownMs,
    page: 1,
    queueAlerts: Boolean(supabase || process.env.DISCORD_WEBHOOK)
  })

  try {
    while (!stopping && requests < maxRequests && Date.now() - startedAt < maxRuntimeMs) {
      const pair = await cookieStore.getFreshPair('walmart')
      if (!pair) {
        log.info('Waiting for Walmart session')
        await wait(10_000)
        continue
      }

      try {
        const response = await httpGet(browseUrl, {
          proxy: pair.proxy,
          timeout: 30_000,
          headers: walmartHeaders(pair, browseUrl)
        })
        requests += 1
        const snapshot = parseWalmartBrowse(response.data)
        if (!snapshot || snapshot.products.length === 0) {
          log.warn('Browse response contained no products', { request: requests })
        } else {
          const changes = compareWalmartBrowse(previous, snapshot)
          if (!previous) {
            log.info('Baseline captured', {
              visible: snapshot.products.length,
              total: snapshot.totalCount,
              maxPage: snapshot.maxPage,
              walmartSeller: snapshot.products.filter((item) => item.soldByWalmart).length,
              inStock: snapshot.products.filter((item) => item.inStock).length
            })
          }
          logBrowseChanges(changes)

          const candidates = snapshot.products.filter(
            (item) =>
              item.soldByWalmart &&
              item.offerId &&
              Date.now() - (probedAt.get(item.id) || 0) >= queueProbeCooldownMs
          )
          for (const item of candidates) {
            if (stopping || queueProbes >= maxQueueProbes) break
            probedAt.set(item.id, Date.now())
            queueProbes += 1
            const result = await inspectQueueGate(item.id, pair)
            if (BLOCK_STATUSES.has(result.status)) {
              await cookieStore.markStale('walmart', pair.proxyId)
              log.warn('Queue gate session blocked', { id: item.id, status: result.status })
              break
            }
            if (result.queueOpen) {
              const lastAlerted = queueAlertedAt.get(item.id) || 0
              if (Date.now() - lastAlerted >= queueProbeCooldownMs) {
                queueAlertedAt.set(item.id, Date.now())
                const productId = await ensureWalmartProduct(supabase, item)
                const delivery = await routeAlert(
                  createDropEvent({
                    retailer: 'walmart',
                    productName: item.name,
                    productUrl: `https://www.walmart.com/ip/${item.id}`,
                    productId,
                    dropType: DROP_TYPES.QUEUE_OPEN,
                    price: item.price
                  })
                )
                log.info('Walmart queue detected', {
                  id: item.id,
                  name: item.name,
                  delivered: delivery.delivered,
                  sinks: delivery.sinks
                })
              }
            }
            if (!stopping) await wait(queueProbeDelayMs)
          }
          previous = snapshot
        }
      } catch (error) {
        const status = error?.response?.status ?? null
        requests += 1
        if (BLOCK_STATUSES.has(status)) {
          await cookieStore.markStale('walmart', pair.proxyId)
        }
        log.warn('Browse check failed', { request: requests, status, error: error.message })
      }

      if (!stopping && requests < maxRequests) await wait(intervalMs)
    }
  } finally {
    log.info('Drop tracker stopped', {
      requests,
      queueProbes,
      elapsedMs: Date.now() - startedAt,
      reason: stopping ? 'manual' : requests >= maxRequests ? 'request-limit' : 'time-limit'
    })
    await redis.quit()
  }
}

async function inspectQueueGate(itemId, pair) {
  const proxyUrl = buildProxyUrl(pair.proxy)
  const agent = new HttpsProxyAgent(proxyUrl)
  const response = await axios.get(`https://www.walmart.com/ip/${itemId}`, {
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
    maxRedirects: 0,
    responseType: 'text',
    timeout: 30_000,
    validateStatus: () => true,
    maxContentLength: 1_000_000,
    headers: walmartHeaders(pair, 'https://www.walmart.com/')
  })
  const location = response.headers?.location
    ? new URL(response.headers.location, `https://www.walmart.com/ip/${itemId}`)
    : null
  return {
    status: response.status,
    queueOpen:
      Boolean(location) &&
      location.pathname === '/qp' &&
      (location.searchParams.has('qpdata') || response.status === 307)
  }
}

async function ensureWalmartProduct(supabase, item) {
  if (!supabase) return null
  const identity = { retailer: 'walmart', product_key: String(item.id) }
  const existing = await supabase.from('products').select('id').match(identity).maybeSingle()
  if (existing.error) {
    log.warn('Walmart queue product lookup failed', {
      id: item.id,
      error: existing.error.message
    })
    return null
  }
  if (existing.data?.id) return existing.data.id

  const inserted = await supabase
    .from('products')
    .insert({
      ...identity,
      product_url: `https://www.walmart.com/ip/${item.id}`,
      name: item.name,
      active: false
    })
    .select('id')
    .single()
  if (!inserted.error) return inserted.data?.id || null
  if (inserted.error.code === '23505') {
    const raced = await supabase.from('products').select('id').match(identity).maybeSingle()
    return raced.data?.id || null
  }
  log.warn('Walmart queue product registration failed', {
    id: item.id,
    error: inserted.error.message
  })
  return null
}

function walmartHeaders(pair, referer) {
  return {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9',
    cookie: pair.cookieHeader,
    referer,
    'user-agent': pair.ua
  }
}

function logBrowseChanges(changes) {
  for (const item of changes.newListings) {
    log.info('New page-one listing', {
      id: item.id,
      rank: item.rank,
      name: item.name,
      inStock: item.inStock,
      price: item.price
    })
  }
  for (const item of changes.stockChanges) {
    log.info('Stock status changed', {
      id: item.id,
      name: item.name,
      from: item.previousInStock ? 'in-stock' : 'out-of-stock',
      to: item.inStock ? 'in-stock' : 'out-of-stock',
      previousRank: item.previousRank,
      rank: item.rank,
      movement: item.previousRank - item.rank
    })
  }
  if (changes.newListings.length || changes.removed.length || changes.stockChanges.length) {
    log.info('Page-one composition changed', {
      newListings: changes.newListings.length,
      removed: changes.removed.length,
      stockChanges: changes.stockChanges.length,
      rankedItemsMoved: changes.rankChanges.length
    })
  }
}

main().catch((error) => {
  log.error('Drop tracker crashed', { error: error.message })
  process.exit(1)
})
