import axios from 'axios'
import { estimatePokemonMsrp, formatMoney } from './ProductMetadata.js'
import { decodeHtmlEntities } from './htmlUtils.js'

const TARGET_REDSKY_KEY = 'ff457966e64d5e877fdbad070f276d18ecec4a01'
const DEFAULT_TARGET_STORE_ID = '3991'
const DEFAULT_TARGET_VISITOR_ID = '12345678901234567890123456789012'

export async function searchProducts(query, retailer) {
  const q = (query || '').trim()
  if (q.length < 2) return []

  const searches = []
  if (!retailer || retailer === 'target') searches.push(searchTarget(q))
  if (!retailer || retailer === 'walmart') searches.push(searchWalmart(q))

  const settled = await Promise.allSettled(searches)
  const resultGroups = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value
    const failedRetailer = getSearchRetailers(retailer)[index]
    return [makeSearchFailureResult(failedRetailer, result.reason)]
  })
  const results = interleaveResults(resultGroups)
  return results.slice(0, retailer ? 5 : 10)
}

function getSearchRetailers(retailer) {
  if (retailer === 'target') return ['target']
  if (retailer === 'walmart') return ['walmart']
  return ['target', 'walmart']
}

function makeSearchFailureResult(retailer, error) {
  const isCaptcha =
    error?.response?.status === 403 &&
    (error?.response?.data?.captchaAbsoluteURL || error?.response?.data?.captchaRelativeURL)
  return {
    retailer,
    name: isCaptcha
      ? `${retailer} search blocked by retailer CAPTCHA`
      : `${retailer} search unavailable`,
    url: null,
    price: null,
    formattedPrice: null,
    imageUrl: null,
    itemId: null,
    disabled: true,
    message: isCaptcha
      ? 'Try again later, use a working proxy, or paste the product URL directly.'
      : error?.message || 'Search failed'
  }
}

async function searchTarget(query) {
  const { data } = await axios.get(
    'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2',
    {
      params: {
        key: TARGET_REDSKY_KEY,
        keyword: query,
        count: 5,
        offset: 0,
        channel: 'WEB',
        page: `/s/${query}`,
        visitor_id: DEFAULT_TARGET_VISITOR_ID,
        default_purchasability_filter: true,
        store_id: DEFAULT_TARGET_STORE_ID,
        pricing_store_id: DEFAULT_TARGET_STORE_ID
      },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    }
  )

  const products = data?.data?.search?.products || []
  return products
    .slice(0, 5)
    .map((product) => normalizeTargetSearchResult(product))
    .filter((r) => r.url || r.disabled)
}

async function searchWalmart(query) {
  const { data: html } = await axios.get('https://www.walmart.com/search', {
    params: { q: query },
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    timeout: 10000
  })

  if (isRobotChallengePage(html)) {
    throw {
      response: {
        status: 403,
        data: { captchaRelativeURL: '/blocked?reason=robot-or-human' }
      }
    }
  }

  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return []

  const json = JSON.parse(match[1])
  const items = json?.props?.pageProps?.initialData?.searchResult?.itemStacks?.[0]?.items || []

  return items
    .slice(0, 5)
    .map((item) => normalizeWalmartSearchResult(item))
    .filter((r) => r.url || r.disabled)
}

function normalizeTargetSearchResult(product) {
  const item = product?.item || {}
  const tcin = item.tcin || product.tcin || extractTargetTcin(item.enrichment?.buy_url)
  const url = absoluteUrl(
    item.enrichment?.buy_url || (tcin ? `/p/-/A-${tcin}` : null),
    'https://www.target.com'
  )
  const price = product.price?.current_retail ?? product.price?.reg_retail ?? null
  return {
    retailer: 'target',
    name: decodeHtmlEntities(item.product_description?.title || 'Target Product'),
    url,
    price,
    formattedPrice: product.price?.formatted_current_price || (price != null ? `$${price}` : null),
    msrp: estimatePokemonMsrp(item.product_description?.title || ''),
    formattedMsrp: formatMoney(estimatePokemonMsrp(item.product_description?.title || '')),
    sellerName: 'Target',
    retailerOwnedListing: true,
    freshStockConfidence: 'high',
    imageUrl:
      item.enrichment?.image_info?.primary_image?.url ||
      item.enrichment?.image_info?.alternate_images?.[0]?.url ||
      null,
    itemId: tcin || null
  }
}

function normalizeWalmartSearchResult(item) {
  const itemId = item.usItemId || item.itemId || extractWalmartItemId(item.canonicalUrl)
  const url = absoluteUrl(
    item.canonicalUrl || (itemId ? `/ip/${itemId}` : null),
    'https://www.walmart.com'
  )
  const price = item.priceInfo?.currentPrice?.price ?? item.price ?? null
  const sellerName =
    item.sellerName ||
    item.sellerDisplayName ||
    item.sellerInfo?.name ||
    item.fulfillmentSummary?.[0]?.sellerName ||
    null
  const isWalmartSeller = sellerName ? /walmart/i.test(sellerName) : false
  const name = decodeHtmlEntities(item.name || 'Walmart Product')
  const msrp = estimatePokemonMsrp(name)
  return {
    retailer: 'walmart',
    name,
    url,
    price,
    formattedPrice:
      item.priceInfo?.currentPrice?.priceString || (price != null ? `$${price}` : null),
    msrp,
    formattedMsrp: formatMoney(msrp),
    sellerName,
    retailerOwnedListing: isWalmartSeller,
    freshStockConfidence: isWalmartSeller ? 'high' : 'unknown',
    imageUrl:
      item.imageInfo?.thumbnailUrl || item.imageInfo?.allImages?.[0]?.url || item.image || null,
    itemId: itemId || null
  }
}

function absoluteUrl(value, origin) {
  if (!value) return null
  try {
    return new URL(value, origin).toString()
  } catch {
    return null
  }
}

function extractTargetTcin(value) {
  return value?.match(/A-(\d+)/)?.[1] || null
}

function extractWalmartItemId(value) {
  return value?.split('/').filter(Boolean).pop()?.split('?')[0] || null
}

function isRobotChallengePage(html) {
  return /<title>\s*Robot or human\?\s*<\/title>|Robot or human\?/i.test(String(html))
}

function interleaveResults(groups) {
  const results = []
  const maxLength = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      if (group[index]) results.push(group[index])
    }
  }
  return results
}
