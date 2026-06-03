import { lookupProduct } from './ProductLookup.js'
import { estimatePokemonMsrp } from './ProductMetadata.js'

export function getCatalogItems(getDb) {
  return getDb().prepare('SELECT * FROM product_catalog').all()
}

export async function addCatalogItemFromUrl(getDb, productUrl, options = {}) {
  let item
  try {
    const product = await lookupProduct(productUrl, {
      onScraplingFallback: options.onScraplingFallback
    })
    item = productToCatalogItem(product)
  } catch (err) {
    item = blockedUrlToCatalogItem(productUrl, err)
  }
  saveCatalogItem(getDb, item)
  return item
}

export async function refreshCatalogItem(getDb, id, options = {}) {
  const existing = getDb().prepare('SELECT * FROM product_catalog WHERE id = ?').get(id)
  if (!existing) throw new Error('Catalog item not found')

  try {
    const product = await lookupProduct(existing.product_url, {
      onScraplingFallback: options.onScraplingFallback
    })
    const refreshed = {
      ...productToCatalogItem(product),
      created_at: existing.created_at,
      status: 'active'
    }
    saveCatalogItem(getDb, refreshed)
    return refreshed
  } catch (err) {
    const blocked = {
      ...existing,
      status: err.response?.status === 403 ? 'blocked' : 'refresh_failed',
      updated_at: nowSeconds()
    }
    saveCatalogItem(getDb, blocked)
    return blocked
  }
}

export function deleteCatalogItem(getDb, id) {
  return getDb().prepare('DELETE FROM product_catalog WHERE id = ?').run(id).changes > 0
}

export function productToCatalogItem(product) {
  const retailerItemId = extractRetailerItemId(product)
  if (!retailerItemId)
    throw new Error(`Cannot extract product identifier for ${product.productUrl}`)

  const title = product.productName || `${product.retailer} Product`
  const retailerOwnedListing = product.retailer === 'target' ? 1 : null
  const msrp = estimatePokemonMsrp(title)
  const checkedAt = nowSeconds()

  return {
    id: `${product.retailer}:${retailerItemId}`,
    retailer: product.retailer,
    retailer_item_id: retailerItemId,
    id_type: product.retailer === 'target' ? 'TCIN' : 'ITEM_ID',
    product_url: product.canonicalUrl || product.productUrl,
    title,
    brand: product.brand || null,
    category: product.category || null,
    image_url: product.imageUrl || null,
    msrp,
    current_price: product.price ?? null,
    formatted_current_price: product.formattedPrice || null,
    availability: product.availability || null,
    seller: product.retailer === 'target' ? 'Target' : product.seller || null,
    retailer_owned_listing: retailerOwnedListing,
    fresh_stock_confidence: product.retailer === 'target' ? 'high' : 'unknown',
    tags_json: JSON.stringify(makeTags(title)),
    status: 'active',
    last_checked_at: checkedAt,
    created_at: checkedAt,
    updated_at: checkedAt
  }
}

function saveCatalogItem(getDb, item) {
  getDb()
    .prepare(
      `
      INSERT OR REPLACE INTO product_catalog (
        id, retailer, retailer_item_id, id_type, product_url, title, brand, category, image_url,
        msrp, current_price, formatted_current_price, availability, seller, retailer_owned_listing,
        fresh_stock_confidence, tags_json, status, last_checked_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      item.id,
      item.retailer,
      item.retailer_item_id,
      item.id_type,
      item.product_url,
      item.title,
      item.brand,
      item.category,
      item.image_url,
      item.msrp,
      item.current_price,
      item.formatted_current_price,
      item.availability,
      item.seller,
      item.retailer_owned_listing,
      item.fresh_stock_confidence,
      item.tags_json,
      item.status,
      item.last_checked_at,
      item.created_at,
      item.updated_at
    )
}

function extractRetailerItemId(product) {
  if (product.retailer === 'target') {
    return (product.canonicalUrl || product.productUrl)?.match(/A-(\d+)/)?.[1] || null
  }
  if (product.retailer === 'walmart') {
    try {
      return new URL(product.canonicalUrl || product.productUrl).pathname
        .split('/')
        .filter(Boolean)
        .pop()
    } catch {
      return product.productUrl?.split('/').pop()?.split('?')[0] || null
    }
  }
  return null
}

function blockedUrlToCatalogItem(productUrl, err) {
  const retailer = detectRetailer(productUrl)
  const retailerItemId = extractItemIdFromUrl(retailer, productUrl)
  if (!retailer || !retailerItemId || !isRetailerBlock(err)) throw err

  const checkedAt = nowSeconds()
  return {
    id: `${retailer}:${retailerItemId}`,
    retailer,
    retailer_item_id: retailerItemId,
    id_type: retailer === 'target' ? 'TCIN' : 'ITEM_ID',
    product_url: productUrl,
    title: `${retailer === 'target' ? 'Target' : 'Walmart'} Product ${retailer === 'target' ? `A-${retailerItemId}` : retailerItemId}`,
    brand: null,
    category: null,
    image_url: null,
    msrp: null,
    current_price: null,
    formatted_current_price: null,
    availability: null,
    seller: retailer === 'target' ? 'Target' : null,
    retailer_owned_listing: retailer === 'target' ? 1 : null,
    fresh_stock_confidence: retailer === 'target' ? 'high' : 'unknown',
    tags_json: JSON.stringify(['pokemon', 'tcg']),
    status: 'blocked',
    last_checked_at: checkedAt,
    created_at: checkedAt,
    updated_at: checkedAt
  }
}

function isRetailerBlock(err) {
  const status = err?.response?.status || err?.status
  const captchaUrl =
    err?.response?.data?.captchaAbsoluteURL || err?.response?.data?.captchaRelativeURL

  return status === 403 || Boolean(captchaUrl)
}

function detectRetailer(productUrl) {
  try {
    const hostname = new URL(productUrl).hostname
    if (hostname.includes('target.com')) return 'target'
    if (hostname.includes('walmart.com')) return 'walmart'
  } catch {
    return null
  }
  return null
}

function extractItemIdFromUrl(retailer, productUrl) {
  if (retailer === 'target') return productUrl.match(/A-(\d+)/)?.[1] || null
  if (retailer === 'walmart') return productUrl.split('/').pop()?.split('?')[0] || null
  return null
}

function makeTags(title) {
  const tags = ['pokemon', 'tcg']
  const normalized = title.toLowerCase()
  if (/elite trainer box| etb/.test(normalized)) tags.push('etb')
  if (/booster bundle/.test(normalized)) tags.push('booster-bundle')
  if (/booster box/.test(normalized)) tags.push('booster-box')
  if (/tin/.test(normalized)) tags.push('tin')
  if (/collection/.test(normalized)) tags.push('collection')
  return tags
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}
