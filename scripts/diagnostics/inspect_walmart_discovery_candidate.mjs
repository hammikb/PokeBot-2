/**
 * One-request Walmart browse-page diagnostic.
 *
 * Deploy this file into server-side-alert-bot/src/entry/ on the Pi. It reuses a
 * warmed Walmart cookie/proxy pair and reports whether candidate item IDs are
 * present on page one. It never prints cookies, proxy credentials, or queue
 * tickets.
 */
import 'dotenv/config'
import { createRedis } from '../redis.js'
import { CookieStore } from '../state/cookieStore.js'
import { httpGet } from '../worker/httpClient.js'
import { parseWalmartBrowse } from '../parse/walmartBrowse.js'

const DEFAULT_URL =
  'https://www.walmart.com/browse/collectibles/pokemon-cards/5967908_9807313_4252400?seo=collectibles&seo=pokemon-cards&seo=5967908_9807313_4252400&facet=retailer_type%3AWalmart%7C%7Cfacet_product_type%3ATrading+Cards%7C%7Cfacet_product_type%3ATrading+Card+Games%7C%7Cfacet_product_type%3ACard+Games&sort=new&affinityOverride=default&page=1'

const candidateIds = new Set(process.argv.slice(2).map(String))
const redis = createRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379')
const cookieStore = new CookieStore(redis)

try {
  const pair = await cookieStore.getFreshPair('walmart')
  if (!pair) throw new Error('No warmed Walmart session is available')

  const browseUrl = process.env.RANK_TRACKER_URL || DEFAULT_URL
  const response = await httpGet(browseUrl, {
    proxy: pair.proxy,
    timeout: 30_000,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      cookie: pair.cookieHeader,
      referer: browseUrl,
      'user-agent': pair.ua
    }
  })
  const snapshot = parseWalmartBrowse(response.data)
  if (!snapshot?.products?.length) throw new Error('Browse response contained no products')

  const matches = snapshot.products
    .filter((item) => candidateIds.has(item.id))
    .map(({ id, rank, name, inStock, canAddToCart, availability, offerId }) => ({
      id,
      rank,
      name,
      inStock,
      canAddToCart,
      availability,
      hasOfferId: Boolean(offerId)
    }))

  console.log(
    JSON.stringify({
      visible: snapshot.products.length,
      total: snapshot.totalCount,
      maxPage: snapshot.maxPage,
      requestedCandidateIds: [...candidateIds],
      matches
    })
  )
} finally {
  await redis.quit()
}
