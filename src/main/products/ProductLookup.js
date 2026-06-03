import axios from 'axios'
import { lookupProductWithScrapling } from './ScraplingLookup.js'
import { decodeHtmlEntities, stripHtml } from './htmlUtils.js'

const TARGET_REDSKY_KEY = 'ff457966e64d5e877fdbad070f276d18ecec4a01'
const DEFAULT_TARGET_STORE_ID = '3991'

export async function lookupProduct(productUrl, options = {}) {
  if (isTargetUrl(productUrl))
    return lookupWithRetailerFallback(productUrl, lookupTargetProduct, options)
  if (isWalmartUrl(productUrl))
    return lookupWithRetailerFallback(productUrl, lookupWalmartProduct, options)
  throw new Error('Product lookup is currently supported for Target and Walmart URLs')
}

async function lookupWithRetailerFallback(productUrl, fallbackLookup, options = {}) {
  try {
    const scraplingProduct = await lookupProductWithScrapling(productUrl)
    if (scraplingProduct) return scraplingProduct
  } catch (err) {
    if (isRetailerBlock(err)) throw err
    options.onScraplingFallback?.({ productUrl, error: err })
  }

  return fallbackLookup(productUrl)
}

function isTargetUrl(productUrl) {
  try {
    return new URL(productUrl).hostname.includes('target.com')
  } catch {
    return false
  }
}

function isWalmartUrl(productUrl) {
  try {
    return new URL(productUrl).hostname.includes('walmart.com')
  } catch {
    return false
  }
}

async function lookupTargetProduct(productUrl) {
  const tcin = productUrl.match(/A-(\d+)/)?.[1]
  if (!tcin) throw new Error(`Cannot extract Target TCIN from URL: ${productUrl}`)

  const { data } = await axios.get(
    'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1',
    {
      params: {
        key: TARGET_REDSKY_KEY,
        tcin,
        store_id: DEFAULT_TARGET_STORE_ID,
        pricing_store_id: DEFAULT_TARGET_STORE_ID
      },
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }
  )
  const product = data?.data?.product
  if (!product) throw new Error('Target did not return product information')

  const imageInfo = product.item?.enrichment?.image_info
  const primaryImage = imageInfo?.primary_image?.url || null
  const alternateImages = (imageInfo?.alternate_images || [])
    .map((image) => image.url)
    .filter(Boolean)
  const images = [...new Set([primaryImage, ...alternateImages].filter(Boolean))]

  return {
    retailer: 'target',
    productUrl,
    canonicalUrl: product.item?.enrichment?.buy_url || productUrl,
    productName: decodeHtmlEntities(product.item?.product_description?.title || 'Target Product'),
    price: product.price?.current_retail ?? null,
    formattedPrice: product.price?.formatted_current_price || null,
    imageUrl: images[0] || null,
    images,
    availability:
      product.fulfillment?.shipping_options?.availability_status ||
      product.item?.fulfillment?.shipping_options?.availability_status ||
      null,
    brand: product.item?.primary_brand?.name || null,
    category: product.category?.name || null,
    bullets: product.item?.product_description?.soft_bullets?.bullets || []
  }
}

async function lookupWalmartProduct(productUrl) {
  const itemId = productUrl.split('/').pop()?.split('?')[0]
  if (!itemId) throw new Error(`Cannot extract Walmart item ID from URL: ${productUrl}`)

  const canonicalUrl = `https://www.walmart.com/ip/${itemId}`
  const { data } = await axios.get(canonicalUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    params: { modules: 'item' }
  })
  const productData = normalizeWalmartProductData(data)
  const images = [
    productData?.imageInfo?.thumbnailUrl,
    ...(productData?.imageInfo?.allImages || []).map((image) => image.url)
  ].filter(Boolean)
  const uniqueImages = [...new Set(images)]
  const price = productData?.priceInfo?.currentPrice?.price ?? null

  return {
    retailer: 'walmart',
    productUrl,
    canonicalUrl,
    productName: decodeHtmlEntities(productData?.name || 'Walmart Product'),
    price,
    formattedPrice:
      productData?.priceInfo?.currentPrice?.priceString || (price != null ? `$${price}` : null),
    imageUrl: uniqueImages[0] || null,
    images: uniqueImages,
    availability: productData?.availabilityStatus || null,
    brand: productData?.brand || productData?.brandName || null,
    category:
      productData?.category?.path?.[0]?.name || productData?.categoryPath?.[0]?.name || null,
    bullets: productData?.shortDescription ? [stripHtml(productData.shortDescription)] : []
  }
}

function normalizeWalmartProductData(data) {
  if (typeof data !== 'string') return data
  const nextData = extractNextData(data)
  return (
    nextData?.props?.pageProps?.initialData?.data?.product ||
    nextData?.props?.pageProps?.initialData?.product ||
    nextData?.props?.pageProps?.initialData?.item ||
    {}
  )
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  try {
    return JSON.parse(decodeHtmlEntities(match[1].trim()))
  } catch {
    return null
  }
}

function isRetailerBlock(err) {
  const status = err?.response?.status || err?.status
  const captchaUrl =
    err?.response?.data?.captchaAbsoluteURL || err?.response?.data?.captchaRelativeURL
  return status === 403 || Boolean(captchaUrl)
}
