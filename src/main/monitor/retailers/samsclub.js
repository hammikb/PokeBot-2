import axios from 'axios'
import * as cheerio from 'cheerio'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('SamsClubPoller')
const ERROR_LOG_COOLDOWN_MS = 60_000
const BROWSER_REFRESH_INTERVAL_MS = 60_000
const TRAFFIC_GATE_REFRESH_COOLDOWN_MS = 5 * 60_000
const MONTHS = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december'
  ].map((month, index) => [month, index])
)

export class SamsClubPoller {
  constructor({
    productUrl,
    maxPrice = Infinity,
    now = () => Date.now(),
    monitorContext = null,
    browserPool = null
  }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.itemId = extractSamsItemId(productUrl)
    if (!this.itemId) throw new Error(`Cannot extract item ID from Sam's Club URL: ${productUrl}`)
    this._now = now
    this.monitorContext = monitorContext
    this.browserPool = browserPool
    this._wasInStock = false
    this._etag = null
    this._lastErrorKey = null
    this._lastErrorAt = 0
    this._forceBrowser = false
    this._polling = false
    this._browserContext = null
    this._browserPage = null
    this._browserTrafficGateActive = false
    this._browserTrafficGateReported = false
    this._nextBrowserNavigationAt = 0
  }

  async poll() {
    if (this._polling) return null
    this._polling = true
    try {
      const product = await this._fetchProduct()
      if (!product || String(product.usItemId || product.id) !== this.itemId) return null

      const state = getSamsProductState(product, this._now())
      const price = Number(product.priceInfo?.currentPrice?.price)

      if (!state.inStock || !Number.isFinite(price) || price > this.maxPrice) {
        this._wasInStock = false
        return null
      }
      if (this._wasInStock) return null

      this._wasInStock = true
      return createDropEvent({
        retailer: 'samsclub',
        productName: product.name || "Sam's Club Product",
        productUrl: this.productUrl,
        dropType: DROP_TYPES.IN_STOCK,
        price
      })
    } catch (error) {
      this._logPollError(error)
      return null
    } finally {
      this._polling = false
    }
  }

  async _fetchProduct() {
    // The server-rendered Next.js payload is enough to detect stock. Start with
    // this small request even when a browser fallback is available; opening and
    // reloading a full Sam's Club tab every four seconds wastes bandwidth and is
    // more likely to encounter a traffic/challenge page during a drop.
    if (this._forceBrowser) {
      return this._fetchProductViaBrowser()
    }

    const headers = {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36'
    }
    if (this._etag) headers['If-None-Match'] = this._etag

    const response = await axios.get(this.productUrl, {
      headers,
      timeout: 15000,
      validateStatus: (status) => [200, 304, 403, 429].includes(status)
    })
    if (response.status === 304) return null
    if ([403, 429].includes(response.status)) {
      this._forceBrowser = true
      if (this.monitorContext || this.browserPool) return this._fetchProductViaBrowser()
      throw new Error(`Sam's Club lightweight monitor returned HTTP ${response.status}`)
    }
    if (response.headers.etag) this._etag = response.headers.etag

    const product = extractSamsProduct(response.data)
    if (!product && /are-you-human|not a robot/i.test(String(response.data))) {
      this._forceBrowser = true
      if (this.monitorContext || this.browserPool) return this._fetchProductViaBrowser()
      throw new Error(
        "Sam's Club challenged the lightweight monitor; browser monitoring is required"
      )
    }
    return product
  }

  async _fetchProductViaBrowser() {
    const page = await this._getPage()

    // Sam's waiting room owns this tab once it appears. Navigating to the product
    // again on every monitor tick restarts the waiting-room request and can keep the
    // session trapped on "Hold tight for a moment" indefinitely.
    if (this._browserTrafficGateActive) {
      const product = await readSamsBrowserProduct(page)
      if (!product) return null
      this._browserTrafficGateActive = false
      this._browserTrafficGateReported = false
      this._nextBrowserNavigationAt = this._now() + TRAFFIC_GATE_REFRESH_COOLDOWN_MS
      log.info("Sam's Club traffic gate cleared without refreshing", { itemId: this.itemId })
      return product
    }

    if (await isSamsBrowserTrafficGate(page)) {
      this._holdBrowserTrafficGate()
      return null
    }

    // A browser fallback used to navigate every four seconds. Keep reading the
    // already-loaded product state between sparse refreshes, especially after a
    // traffic gate has just admitted this session.
    if (this._now() < this._nextBrowserNavigationAt) {
      return readSamsBrowserProduct(page)
    }

    try {
      await page.goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      this._nextBrowserNavigationAt = this._now() + BROWSER_REFRESH_INTERVAL_MS
    } catch (error) {
      // The waiting-room app can replace the document while Playwright's goto is
      // settling. Treat that abort as the gate taking ownership of the warm tab;
      // later polls inspect it in place instead of starting another navigation.
      if (/ERR_ABORTED|frame was detached/i.test(String(error?.message || ''))) {
        this._holdBrowserTrafficGate()
        return null
      }
      throw error
    }

    if (await isSamsBrowserTrafficGate(page)) {
      this._holdBrowserTrafficGate()
      return null
    }
    if (/are-you-human/i.test(page.url())) {
      throw new Error("Sam's Club browser monitor encountered a robot challenge")
    }
    return readSamsBrowserProduct(page)
  }

  _holdBrowserTrafficGate() {
    this._browserTrafficGateActive = true
    if (this._browserTrafficGateReported) return
    this._browserTrafficGateReported = true
    log.info("Sam's Club traffic gate detected; holding the existing monitor tab", {
      itemId: this.itemId
    })
  }

  async _getPage() {
    if (this.monitorContext) return this.monitorContext.getPage(this.itemId)
    if (!this._browserContext) {
      this._browserContext = await this.browserPool.launchContext({
        accountId: `monitor-samsclub-${this.itemId}`
      })
      this._browserPage = await this._browserContext.newPage()
    }
    return this._browserPage
  }

  async destroy() {
    if (this.monitorContext) {
      await this.monitorContext.closePage(this.itemId)
      return
    }
    await this._browserContext?.close().catch(() => {})
    this._browserContext = null
    this._browserPage = null
    this._browserTrafficGateActive = false
    this._browserTrafficGateReported = false
    this._nextBrowserNavigationAt = 0
  }

  _logPollError(error) {
    const key = `${error?.response?.status || error?.code || 'error'}:${error?.message || error}`
    const now = this._now()
    if (key === this._lastErrorKey && now - this._lastErrorAt < ERROR_LOG_COOLDOWN_MS) return
    this._lastErrorKey = key
    this._lastErrorAt = now
    log.warn("Sam's Club monitor request failed", {
      itemId: this.itemId,
      status: error?.response?.status || null,
      error: error?.message || String(error)
    })
  }
}

async function isSamsBrowserTrafficGate(page) {
  if (typeof page?.locator !== 'function') return false
  const text = await page
    .locator('body')
    .innerText({ timeout: 1000 })
    .catch(() => '')
  return /hold tight for a moment|high traffic is slowing things down|experiencing high (?:traffic|demand)/i.test(
    String(text || '')
  )
}

async function readSamsBrowserProduct(page) {
  return page.evaluate(() => {
    const raw = document.querySelector('#__NEXT_DATA__')?.textContent
    if (!raw) return null
    try {
      const data = JSON.parse(raw)?.props?.pageProps?.initialData?.data
      const product = data?.product || null
      if (product && data?.idml && !product.idml) product.idml = data.idml
      return product
    } catch {
      return null
    }
  })
}

export function extractSamsItemId(productUrl) {
  try {
    const pathname = new URL(productUrl).pathname
    const segments = pathname.split('/').filter(Boolean)
    const ipIndex = segments.findIndex((segment) => segment.toLowerCase() === 'ip')
    if (ipIndex < 0) return null
    return segments.slice(ipIndex + 1).findLast((segment) => /^\d{6,}$/.test(segment)) || null
  } catch {
    return null
  }
}

export function getSamsProductState(product, now = Date.now()) {
  const shipping = (product?.fulfillmentOptions || []).find(
    (option) => option.type === 'SHIPPING' && option.selected !== false
  )
  const availableQuantity = Number(shipping?.availableQuantity || 0)
  const releaseAt = extractAnnouncedSamsReleaseAt(product, now)
  const releasePending = Number.isFinite(releaseAt) && now < releaseAt
  const membershipGate =
    shipping?.viewOnly === true &&
    product?.showAtc !== false &&
    /SIGN_IN|MEMBER/i.test(
      `${product?.specialCtaType || ''} ${product?.specialCtaContext || ''} ${product?.staticMessageType || ''}`
    )
  const shippingReady =
    shipping?.availabilityStatus === 'IN_STOCK' &&
    shipping?.restricted !== true &&
    availableQuantity > 0

  return {
    inStock:
      product?.availabilityStatus === 'IN_STOCK' &&
      shippingReady &&
      !releasePending &&
      (shipping?.viewOnly !== true || membershipGate),
    membershipGate,
    releasePending,
    releaseAt,
    availableQuantity,
    orderLimit:
      Number(shipping?.orderLimit || product?.orderLimit || product?.memberLimit || 0) || null
  }
}

export function extractAnnouncedSamsReleaseAt(product, now = Date.now()) {
  const description = `${product?.shortDescription || ''} ${product?.idml?.shortDescription || ''}`
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
  if (!/coming soon/i.test(description)) return null

  const match = description.match(
    /(?:coming soon[^]*?)?\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[^]*?\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(?:CST|CDT|CT|Central)/i
  )
  if (!match) return null

  const month = MONTHS.get(match[1].toLowerCase())
  const day = Number(match[2])
  const minute = Number(match[4] || 0)
  let hour = Number(match[3]) % 12
  if (match[5].toUpperCase() === 'PM') hour += 12

  const current = new Date(now)
  let year = current.getUTCFullYear()
  let timestamp = centralTimeToUtc(year, month, day, hour, minute)
  if (timestamp < now - 180 * 24 * 60 * 60 * 1000) {
    year += 1
    timestamp = centralTimeToUtc(year, month, day, hour, minute)
  }
  return timestamp
}

function centralTimeToUtc(year, month, day, hour, minute) {
  const initialGuess = Date.UTC(year, month, day, hour, minute)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(initialGuess)).map(({ type, value }) => [type, value])
  )
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute)
  )
  return initialGuess - (representedAsUtc - initialGuess)
}

export function extractSamsProduct(html) {
  if (typeof html !== 'string') return null
  const $ = cheerio.load(html)
  const raw = $('#__NEXT_DATA__').text()
  if (!raw) return null
  try {
    const data = JSON.parse(raw)?.props?.pageProps?.initialData?.data
    const product = data?.product || null
    if (product && data?.idml && !product.idml) product.idml = data.idml
    return product
  } catch {
    return null
  }
}
