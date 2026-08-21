/**
 * WalmartQueueHost — hold N Walmart virtual-queue tickets over plain HTTP.
 *
 * Replaces the browser-per-queue model for Walmart. Captured from a live drop
 * on 2026-08-19: `validateTickets` takes NO parameters — it reads the `wr`
 * cookie and returns one entry per queue held. So polling cost is FLAT:
 * holding 14 queues is the same single request as holding 1. Joining is the
 * only per-item cost.
 *
 * We only ever READ tickets. The `signature` in each is Walmart's signed proof
 * of your spot; never forge or replay it. One session takes one real spot.
 */
import { EventEmitter } from 'events'
import axios from 'axios'
import { createModuleLogger } from '../utils/logger.js'
import {
  isQueueActive,
  issueTicketUrl,
  parseListingItemIds,
  parseQp,
  parseTickets,
  parseWrCookie,
  queueApiHeaders,
  validateTicketsUrl
} from './walmartQueue.js'

const log = createModuleLogger('WalmartQueueHost')

const DEFAULT_POLL_MS = 30000
const MIN_POLL_MS = 2000

export class WalmartQueueHost extends EventEmitter {
  constructor({
    getCookieHeader,
    onTicketCookie,
    fetchPage,
    http = axios,
    pollMs = DEFAULT_POLL_MS
  } = {}) {
    super()
    this._getCookieHeader = getCookieHeader || (() => '')
    // Mirrors the `wr` ticket cookie back into the browser session, so the
    // queue is visible there and checkout can proceed when admitted.
    this._onTicketCookie = onTicketCookie || null
    // PerimeterX blocks axios on /search; the browser gets through.
    this._fetchPage = fetchPage || null
    this._http = http
    this._pollMs = Math.max(pollMs, MIN_POLL_MS)
    this._tickets = new Map()
    this._queueIds = new Map() // itemId -> resolved queue status
    this._timer = null
    this._polling = false
    this._lastPollAt = null
  }

  list() {
    return [...this._tickets.values()].map((t) => ({ ...t }))
  }

  stats() {
    const all = this.list()
    return {
      tickets: all.length,
      inQueue: all.filter((t) => t.state === 'pending').length,
      pending: all.filter((t) => !t.state).length,
      ready: all.filter((t) => t.yourTurn).length,
      errors: all.filter((t) => t.error).length,
      lastPollAt: this._lastPollAt,
      pollMs: this._pollMs
    }
  }

  track({ queueId, itemId, itemName, price, imageUrl, sku, autoCheckout = false }) {
    if (!queueId) throw new Error('track requires a queueId')
    const prev = this._tickets.get(queueId) || {}
    this._tickets.set(queueId, {
      queueId,
      itemId: itemId ?? prev.itemId ?? null,
      itemName: itemName ?? prev.itemName ?? null,
      price: price ?? prev.price ?? null,
      imageUrl: imageUrl ?? prev.imageUrl ?? null,
      sku: sku ?? prev.sku ?? itemId ?? null,
      autoCheckout: autoCheckout ?? prev.autoCheckout ?? false,
      state: prev.state ?? null,
      ticket: prev.ticket ?? null,
      offerId: prev.offerId ?? null,
      admissionLikelihood: prev.admissionLikelihood ?? null,
      expectedTurnMs: prev.expectedTurnMs ?? null,
      yourTurn: prev.yourTurn ?? false,
      error: prev.error ?? null,
      joinedAt: prev.joinedAt ?? null
    })
    this._emit()
    return this._tickets.get(queueId)
  }

  remove(queueId) {
    const had = this._tickets.delete(queueId)
    if (had) this._emit()
    return had
  }

  setAutoCheckout(queueId, enabled) {
    const t = this._tickets.get(queueId)
    if (!t) return false
    t.autoCheckout = Boolean(enabled)
    this._emit()
    return true
  }

  /**
   * The queue API is session-bound: it needs `auth`, `CID` and a live `_px3`
   * PerimeterX token from a signed-in Walmart session. Without them Walmart
   * answers 401/403, which reads like a bug. Fail loudly and specifically
   * instead, so the UI can say "sign in" rather than "HTTP 403".
   */
  _requireSession() {
    const cookie = this._getCookieHeader() || ''
    if (!cookie.trim()) {
      throw new Error('No Walmart session cookies available - sign in to a Walmart account first')
    }
    return cookie
  }

  /**
   * Resolve an item's queue id by hitting its PDP: when a queue is open Walmart
   * 307s to /qp?qpdata={"queued":true,"queue":"q...",...}. Returns null when no
   * queue is active (the item is simply buyable, or not dropping).
   */
  async resolveQueueId(itemId) {
    // A queue id, once known, is all that issueTicket needs -- so remember it
    // and skip the network entirely next time. Ids stay stable for a drop.
    const cached = this._queueIds.get(itemId)
    if (cached) return cached

    const cookie = this._requireSession()
    // Do NOT follow the redirect. Walmart answers a queued item with a 307
    // whose Location header already carries qpdata; following it downloads
    // ~127 KB of queue-page HTML for a value we already have in the header.
    const response = await this._http.get(`https://www.walmart.com/ip/${itemId}`, {
      headers: queueApiHeaders({ cookie, accept: 'text/html,application/xhtml+xml' }),
      timeout: 25000,
      maxRedirects: 0,
      validateStatus: () => true
    })

    const location = response.headers?.location || response.headers?.Location || ''
    let source = ''
    if (location.includes('qpdata=')) {
      source = location.startsWith('http') ? location : `https://www.walmart.com${location}`
    } else if (response.status >= 200 && response.status < 300) {
      // Not redirected: either no queue, or the token is inline in the body.
      const body = typeof response.data === 'string' ? response.data : ''
      if (!isQueueActive({ url: '', body })) return null
      source = body
    } else {
      return null
    }

    try {
      const status = parseQp(source)
      if (!status?.queueId) return null
      this._queueIds.set(itemId, status)
      return status
    } catch {
      return null
    }
  }

  /** Forget a cached queue id (e.g. the drop ended and the queue closed). */
  forgetQueueId(itemId) {
    return this._queueIds.delete(itemId)
  }

  /**
   * Tickets are keyed by queueId, so an itemId lookup needs a scan. Getting
   * this wrong takes a second spot in the same line for the same item.
   */
  isHoldingItem(itemId) {
    if (!itemId) return false
    for (const t of this._tickets.values()) {
      if (t.itemId === itemId && t.ticket) return true
    }
    return false
  }

  /** Detect + join in one step, from a drop event that only knows the item. */
  async joinByItem({ itemId, itemName, price, imageUrl }) {
    if (!itemId) return null
    if (this.isHoldingItem(itemId)) return null
    const status = await this.resolveQueueId(itemId)
    if (!status?.queueId) {
      log.info('No Walmart queue open for item', { itemId })
      return null
    }
    return this.join(status.queueId, {
      itemId,
      itemName: itemName || status.itemName,
      price: price || status.price,
      imageUrl,
      sku: itemId
    })
  }

  /**
   * Discover candidate items straight from a Walmart listing page.
   *
   * Needed because a queue can be open on an item the monitor never published
   * a drop for -- those never reach local tasks or drop_history, so a
   * candidate list built from those sources silently misses them.
   */
  async discoverItemIds(listingUrl) {
    if (!listingUrl) return []
    try {
      const cookie = this._requireSession()
      const response = await this._http.get(listingUrl, {
        headers: queueApiHeaders({ cookie, accept: 'text/html,application/xhtml+xml' }),
        timeout: 30000,
        validateStatus: () => true
      })
      let body = typeof response.data === 'string' ? response.data : ''
      if (/Robot or human|px-captcha/i.test(body) || !body) {
        // axios cannot impersonate a TLS fingerprint, so /search 403s it.
        // Fall back to the stealth browser, which already passes.
        if (!this._fetchPage) {
          log.warn('Walmart listing blocked and no browser fallback available')
          return []
        }
        log.info('Listing blocked for HTTP; retrying through the browser')
        body = await this._fetchPage(listingUrl)
        if (/Robot or human|px-captcha/i.test(body || '')) {
          log.warn('Walmart listing blocked in the browser too')
          return []
        }
      }
      const ids = parseListingItemIds(body)
      log.info('Discovered Walmart listing items', { count: ids.length })
      return ids
    } catch (error) {
      log.warn('Walmart listing discovery failed', { error: error.message })
      return []
    }
  }

  /**
   * Join every item that has a queue open RIGHT NOW.
   *
   * Deliberately independent of the monitor's out->in transition: a queue that
   * is already open never produces a transition, so waiting for one means
   * missing the whole drop. This just asks Walmart directly, per item.
   */
  async scanAndJoin(items = []) {
    const results = { joined: [], noQueue: [], failed: [] }
    for (const entry of items) {
      const itemId = typeof entry === 'string' ? entry : entry?.itemId
      if (!itemId) continue
      if (this.isHoldingItem(itemId)) continue // already holding a spot for it
      try {
        const status = await this.resolveQueueId(itemId)
        if (!status?.queueId) {
          results.noQueue.push(itemId)
          continue
        }
        if ([...this._tickets.values()].some((t) => t.queueId === status.queueId && t.ticket)) {
          continue
        }
        await this.join(status.queueId, {
          itemId,
          itemName: (typeof entry === 'object' && entry?.itemName) || status.itemName,
          price: (typeof entry === 'object' && entry?.price) || status.price,
          sku: itemId
        })
        results.joined.push({ itemId, queueId: status.queueId })
        log.info('Joined open Walmart queue', { itemId, queueId: status.queueId })
      } catch (error) {
        results.failed.push({ itemId, error: error.message })
        log.warn('Could not join Walmart queue', { itemId, error: error.message })
      }
      // Space the requests out; a burst of PDP hits is what trips PerimeterX.
      await new Promise((r) => setTimeout(r, 1200))
    }
    this._emit()
    return results
  }

  async join(queueId, meta = {}) {
    this.track({ queueId, ...meta })
    try {
      const cookie = this._requireSession()
      const response = await this._http.get(issueTicketUrl(queueId), {
        headers: queueApiHeaders({ cookie }),
        timeout: 20000,
        validateStatus: () => true
      })
      if (response.status >= 400) throw new Error('issueTicket HTTP ' + response.status)
      const setCookie = response.headers?.['set-cookie'] || []
      const wr = setCookie
        .map((c) => {
          const m = /(?:^|;\s*)wr=([^;]+)/.exec(c)
          return m ? m[1] : null
        })
        .find(Boolean)
      if (wr) {
        this._applyWrCookie(wr)
        // Fire and forget: a browser-write failure must not lose the ticket.
        Promise.resolve(this._onTicketCookie?.('wr', wr)).catch((error) =>
          log.warn('Could not mirror wr cookie to browser', { error: error.message })
        )
      }
      const t = this._tickets.get(queueId)
      if (t) {
        t.joinedAt = Date.now()
        t.error = null
      }
      this._emit()
      return t
    } catch (error) {
      const t = this._tickets.get(queueId)
      if (t) t.error = error.message
      log.warn('Walmart queue join failed', { queueId, error: error.message })
      this._emit()
      throw error
    }
  }

  async pollOnce() {
    if (this._polling) return this.list()
    this._polling = true
    try {
      const cookie = this._requireSession()
      const response = await this._http.get(validateTicketsUrl(), {
        headers: queueApiHeaders({ cookie }),
        timeout: 20000,
        validateStatus: () => true
      })
      if (response.status >= 400) throw new Error('validateTickets HTTP ' + response.status)
      this._lastPollAt = Date.now()
      let fastest = null
      for (const status of parseTickets(response.data)) {
        const prev = this._tickets.get(status.queueId)
        const merged = {
          ...(prev || { queueId: status.queueId, autoCheckout: false }),
          queueId: status.queueId,
          state: status.state,
          ticket: status.ticket,
          offerId: status.offerId || prev?.offerId || null,
          itemId: status.itemId || prev?.itemId || null,
          itemName: status.itemName || prev?.itemName || null,
          price: status.price || prev?.price || null,
          sku: prev?.sku || status.itemId || null,
          admissionLikelihood: status.admissionLikelihood,
          expectedTurnMs: status.expectedTurnMs,
          yourTurn: status.yourTurn,
          error: null
        }
        this._tickets.set(status.queueId, merged)
        if (status.refreshSec) {
          const ms = status.refreshSec * 1000
          fastest = fastest == null ? ms : Math.min(fastest, ms)
        }
        if (status.yourTurn && !prev?.yourTurn) {
          log.info('Walmart queue ready', { queueId: status.queueId, itemId: merged.itemId })
          this.emit('ready', { ...merged })
        }
      }
      if (fastest) this._pollMs = Math.max(fastest, MIN_POLL_MS)
      this._emit()
      return this.list()
    } catch (error) {
      log.warn('Walmart queue poll failed', { error: error.message })
      for (const t of this._tickets.values()) t.error = error.message
      // EventEmitter THROWS on emit('error') when nothing is listening, which
      // would take down the main process on a single failed poll. The ticket
      // state above already carries the reason, so only emit if someone cares.
      if (this.listenerCount('error') > 0) this.emit('error', error)
      this._emit()
      return this.list()
    } finally {
      this._polling = false
    }
  }

  start() {
    if (this._timer) return
    const tick = async () => {
      await this.pollOnce()
      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = setTimeout(tick, this._pollMs)
      }
    }
    this._timer = setTimeout(tick, 0)
  }

  stop() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
  }

  restoreFromCookie(wrValue) {
    this._applyWrCookie(wrValue)
    this._emit()
    return this.list()
  }

  _applyWrCookie(wrValue) {
    for (const block of parseWrCookie(wrValue)) {
      const prev = this._tickets.get(block.queueId) || { autoCheckout: false }
      this._tickets.set(block.queueId, {
        ...prev,
        queueId: block.queueId,
        ticket: block.ticket ?? prev.ticket ?? null,
        state: block.state ?? prev.state ?? null,
        itemId: block.itemId ?? prev.itemId ?? null,
        offerId: block.offerId ?? prev.offerId ?? null,
        sku: prev.sku ?? block.itemId ?? null,
        yourTurn: block.state === 'valid' || prev.yourTurn || false,
        error: prev.error ?? null
      })
    }
  }

  _emit() {
    this.emit('update', { tickets: this.list(), stats: this.stats() })
  }
}
