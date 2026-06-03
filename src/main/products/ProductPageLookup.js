import { chromium } from 'playwright'

const BLOCK_PATTERNS = [
  /captcha/i,
  /robot or human/i,
  /verify you are/i,
  /access denied/i,
  /sorry, this request/i
]

export async function lookupProductFromPage(productUrl) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    })
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

    const snapshot = await page.evaluate(() => {
      const text = document.body?.innerText || ''
      const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || null
      const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((script) => script.textContent || '')
        .filter(Boolean)
      const nextData = document.querySelector('script#__NEXT_DATA__')?.textContent || null
      const prices = [...document.querySelectorAll('[data-test*="price"], [class*="price"]')]
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .slice(0, 10)

      return {
        url: location.href,
        title: document.title,
        bodyText: text.slice(0, 4000),
        h1: document.querySelector('h1')?.textContent?.trim() || null,
        ogTitle: meta('meta[property="og:title"]'),
        ogImage: meta('meta[property="og:image"]'),
        description: meta('meta[name="description"]'),
        canonical,
        scripts,
        nextData,
        prices
      }
    })

    if (isBlockedSnapshot(snapshot)) {
      const err = new Error('Retailer page is showing a CAPTCHA or robot check')
      err.status = 403
      err.response = { status: 403, data: { captchaRelativeURL: snapshot.url } }
      throw err
    }

    return normalizePageSnapshot(productUrl, snapshot)
  } finally {
    await browser.close().catch(() => {})
  }
}

function normalizePageSnapshot(productUrl, snapshot) {
  const retailer = detectRetailer(productUrl)
  if (!retailer)
    throw new Error('Product page lookup is currently supported for Target and Walmart URLs')

  const structured = extractStructuredProduct(snapshot)
  const productName =
    cleanTitle(structured?.name || snapshot.h1 || snapshot.ogTitle || snapshot.title) ||
    `${retailer === 'target' ? 'Target' : 'Walmart'} Product`
  const imageUrl = firstValue(structured?.image) || snapshot.ogImage || null
  const price = parsePrice(structured?.offers?.price || snapshot.prices?.[0])
  const formattedPrice =
    price != null ? `$${price.toFixed(2)}` : extractPriceString(snapshot.prices)

  return {
    retailer,
    productUrl,
    canonicalUrl: snapshot.canonical || productUrl,
    productName,
    price,
    formattedPrice,
    imageUrl,
    images: imageUrl ? [imageUrl] : [],
    availability: normalizeAvailability(structured?.offers?.availability || snapshot.bodyText),
    brand: structured?.brand?.name || structured?.brand || null,
    category: null,
    bullets: snapshot.description ? [snapshot.description] : [],
    source: 'page'
  }
}

function extractStructuredProduct(snapshot) {
  for (const raw of snapshot.scripts || []) {
    const parsed = safeJson(raw)
    const product = findProductJson(parsed)
    if (product) return product
  }

  const nextData = safeJson(snapshot.nextData)
  return findNextProduct(nextData)
}

function findProductJson(value) {
  if (!value) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductJson(item)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  if (String(value['@type'] || '').toLowerCase() === 'product') return value
  if (value['@graph']) return findProductJson(value['@graph'])
  return null
}

function findNextProduct(value) {
  if (!value || typeof value !== 'object') return null
  return (
    value?.props?.pageProps?.initialData?.data?.product ||
    value?.props?.pageProps?.initialData?.product ||
    value?.props?.pageProps?.initialData?.item ||
    null
  )
}

function isBlockedSnapshot(snapshot) {
  const combined = `${snapshot.title || ''}\n${snapshot.bodyText || ''}`
  return BLOCK_PATTERNS.some((pattern) => pattern.test(combined))
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

function safeJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function firstValue(value) {
  if (Array.isArray(value)) return value.find(Boolean) || null
  return value || null
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s*:\s*Target\s*$/i, '')
    .replace(/\s*-\s*Walmart\.com\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePrice(value) {
  if (typeof value === 'number') return value
  const match = String(value || '').match(/\$?\s*(\d+(?:\.\d{2})?)/)
  return match ? Number.parseFloat(match[1]) : null
}

function extractPriceString(prices = []) {
  return prices.find((price) => /\$\s*\d/.test(price)) || null
}

function normalizeAvailability(value) {
  const text = String(value || '')
  if (/InStock|in stock|add to cart/i.test(text)) return 'IN_STOCK'
  if (/OutOfStock|out of stock|sold out/i.test(text)) return 'OUT_OF_STOCK'
  return null
}
