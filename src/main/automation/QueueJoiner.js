import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { parseQp, extractQpdataFromText, secondsUntilTurn } from './walmartQueue.js'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('QueueJoiner')

/**
 * Parks ONE real browser session in Walmart's waiting room and reports position.
 *
 * A real browser hitting a gated item IS the probe — Walmart bounces it to /qp
 * itself, so the joiner detects + joins + tracks in one piece. No multiplexing,
 * no proxy-farming, no touching the signed ticket. Human finishes checkout.
 *
 * Emits `progress` { id, label, phase, ...status } and `turn` { id, label, status }.
 *   phase: joining | in-queue | no-queue | turn | timeout | stopped | error
 */
export class QueueJoiner extends EventEmitter {
  constructor({ browserPool, maxWaitMin = 90, rewatchSec = 20 }) {
    super()
    this.browserPool = browserPool
    this.maxWaitMin = maxWaitMin
    this.rewatchSec = rewatchSec
    this._jobs = new Map() // id → { context, stopped }
  }

  isJoining(id) {
    return this._jobs.has(id)
  }

  /** True while any queue page is using an account's shared persistent context. */
  isUsingAccount(accountId) {
    return [...this._jobs.values()].some((job) => job.accountId === accountId && !job.stopped)
  }

  start(id, { productUrl, label, account }) {
    if (this._jobs.has(id)) return
    const job = {
      context: null,
      page: null,
      ownsContext: false,
      accountId: account?.id || null,
      stopped: false,
      handedOff: false,
      queueStatus: null,
      queueCycleId: null
    }
    this._jobs.set(id, job)
    job.runPromise = this._run(id, job, { productUrl, label: label || id, account })
      .catch((err) => {
        log.error('Queue join crashed', { id, error: err.message })
        this.emit('progress', { id, label, phase: 'error', message: err.message })
      })
      .finally(() => this._finishJob(id, job))
  }

  async stop(id) {
    const job = this._jobs.get(id)
    if (!job) return
    job.stopped = true
    await this._closeJobResources(job)
    if (this._jobs.get(id) === job) this._jobs.delete(id)
    this.emit('progress', { id, phase: 'stopped' })
  }

  async stopAll() {
    for (const id of [...this._jobs.keys()]) await this.stop(id)
  }

  async _run(id, job, { productUrl, label, account }) {
    // Use the account's persistent profile so we ride the logged-in Walmart
    // session (queue spots + checkout are tied to it). Fall back to a throwaway
    // profile only when the task has no account — which means NOT logged in.
    let context
    if (account?.profile_path) {
      this.emit('progress', {
        id,
        label,
        phase: 'joining',
        message: `Opening Walmart as ${account.name || 'account'}…`
      })
      context = await this.browserPool.launch(account.id, {
        profilePath: account.profile_path,
        proxy: account.proxy,
        retailer: 'walmart',
        priority: 80
      })
    } else {
      this.emit('progress', {
        id,
        label,
        phase: 'joining',
        message: 'Opening Walmart (NOT logged in — assign an account to this task).'
      })
      context = await this.browserPool.launchContext({ accountId: `queue-${id}` })
      job.ownsContext = true
    }
    job.context = context
    if (job.stopped) {
      await this._closeJobResources(job)
      return
    }
    const page = await context.newPage()
    job.page = page
    if (job.stopped) {
      await this._closeJobResources(job)
      return
    }

    // Paste a normal /ip/ product URL — no /qp needed. A real browser hitting a
    // gated item IS the probe: Walmart bounces it to /qp on its own. Re-load the
    // item until that happens (or the deadline), so clicking BEFORE the queue is
    // live still auto-joins the moment it opens.
    // ponytail: reloads every ~20s for up to maxWaitMin; tighten rewatchSec if Walmart blocks.
    const watchDeadline = Date.now() + this.maxWaitMin * 60_000
    let qpUrl = null
    while (!job.stopped && Date.now() < watchDeadline) {
      await page
        .goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(() => {})
      qpUrl = await this._waitForQueue(page, 8_000, job)
      if (qpUrl || job.stopped) break
      this.emit('progress', {
        id,
        label,
        phase: 'watching',
        message: 'No queue yet — watching the item, will auto-join when it opens.'
      })
      await page.waitForTimeout(this.rewatchSec * 1000).catch(() => {})
    }
    if (job.stopped) return
    if (!qpUrl) {
      this.emit('progress', {
        id,
        label,
        phase: 'timeout',
        message: `No queue opened within ${this.maxWaitMin}m.`
      })
      return
    }

    this._captureQueueStatus(job, qpUrl)
    await this._holdQueueSpot(page, id, label)
    this.emit('progress', { id, label, phase: 'in-queue', message: 'In line. Holding spot.' })
    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMin * 60_000

    while (!job.stopped && Date.now() < deadline) {
      const url = page.url()
      if (await this._pageSaysCheckoutReady(page)) {
        this._emitTurn(id, job, label, {
          status: { yourTurn: true },
          message: 'READY FOR CHECKOUT — starting checkout.'
        })
        return
      }
      if (url.includes('qpdata=')) {
        const st = this._captureQueueStatus(job, url)
        if (st?.yourTurn) {
          this._emitTurn(id, job, label, {
            status: st,
            message: 'YOUR TURN — buy now!'
          })
          return
        }
        if (st) {
          this.emit('progress', {
            id,
            label,
            phase: 'in-queue',
            ticket: st.ticket,
            queueCycleId: job.queueCycleId,
            etaSec: secondsUntilTurn(st),
            percent: this._percent(startedAt, st),
            admissionLikelihood: st.admissionLikelihood,
            itemName: st.itemName,
            status: st
          })
        }
        // honor the page's own ~30s cadence so we don't look like a bot
        await page.waitForTimeout(Math.max(2000, (st?.refreshSec || 30) * 1000)).catch(() => {})
      } else if (!url.includes('/qp')) {
        // Walmart may leave the /qp URL while the page still shows its
        // "You're in line" side panel. Only explicit checkout-ready copy is
        // authoritative; a URL change alone is not admission.
        if (await this._pageSaysCheckoutReady(page)) {
          this._emitTurn(id, job, label, {
            status: { yourTurn: true },
            message: 'Admitted — checkout open!'
          })
          return
        }
        this.emit('progress', {
          id,
          label,
          phase: 'in-queue',
          message: 'Still in Walmart’s waiting room.'
        })
        await page.waitForTimeout(2000).catch(() => {})
      } else {
        await page.waitForTimeout(2000).catch(() => {})
      }
    }

    if (!job.stopped) {
      this.emit('progress', {
        id,
        label,
        phase: 'timeout',
        message: `Still queued after ${this.maxWaitMin}m.`
      })
    }
  }

  /** Poll briefly after load for a /qp URL or an embedded qpdata token. */
  async _waitForQueue(page, ms, job = null) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const url = page.url()
      if (url.includes('qpdata=') || url.includes('/qp')) {
        if (job) this._captureQueueStatus(job, url)
        await this._waitForHoldButton(page, Math.min(3000, Math.max(0, deadline - Date.now())))
        return url
      }
      const body = await page.content().catch(() => '')
      const tok = extractQpdataFromText(body)
      if (tok) {
        const queueUrl = `https://www.walmart.com/qp?qpdata=${tok}`
        if (job) this._captureQueueStatus(job, queueUrl)
        return queueUrl
      }
      await page.waitForTimeout(1000).catch(() => {})
    }
    return null
  }

  _captureQueueStatus(job, urlOrToken) {
    let parsed
    try {
      parsed = parseQp(urlOrToken)
    } catch {
      return job.queueStatus
    }

    job.queueCycleId ||= queueCycleIdFor(parsed, urlOrToken)
    const status = { ...(job.queueStatus || {}) }
    for (const [key, value] of Object.entries(toSafeQueueStatus(parsed))) {
      if (value !== undefined && value !== null) status[key] = value
    }
    if (job.queueCycleId) status.queueCycleId = job.queueCycleId
    job.queueStatus = status
    return status
  }

  _emitTurn(id, job, label, { status = {}, message }) {
    if (job.stopped || job.handedOff) return false
    const mergedStatus = { ...(job.queueStatus || {}), ...status, yourTurn: true }
    if (job.queueCycleId) mergedStatus.queueCycleId = job.queueCycleId
    job.handedOff = true

    const payload = {
      id,
      label,
      phase: 'turn',
      message,
      ticket: mergedStatus.ticket,
      queueCycleId: job.queueCycleId,
      status: mergedStatus
    }
    this.emit('progress', payload)
    this.emit('turn', {
      ...payload,
      context: job.context,
      page: job.page
    })
    return true
  }

  async _finishJob(id, job) {
    // An admitted page is deliberately handed to TaskManager for checkout. It
    // remains owned by that handoff until TaskManager calls stop(id).
    if (job.handedOff || job.stopped) return
    await this._closeJobResources(job)
    if (this._jobs.get(id) === job) this._jobs.delete(id)
  }

  async _closeJobResources(job) {
    const context = job.context
    const page = job.page
    job.context = null
    job.page = null
    try {
      // Only close throwaway contexts. An account's persistent context is shared
      // with BrowserPool, so normal completion owns only this queue page.
      if (job.ownsContext) await context?.close()
      else await page?.close()
    } catch {
      // Best-effort cleanup.
    }
  }

  async _pageSaysCheckoutReady(page) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(async () => page.content().catch(() => ''))
    // Keep this strict: generic Walmart pages often contain "Buy now" or
    // "your turn" in hidden/support copy while the queue is still pending.
    return /ready\s+to\s+checkout|continue\s+to\s+checkout|proceed\s+to\s+checkout|queue\s+(?:complete|admitted)/i.test(
      body
    )
  }

  async _holdQueueSpot(page, id, label) {
    const holdButton = this._getHoldButton(page)
    const count = await holdButton.count().catch(() => 0)
    if (count === 0) {
      this.emit('progress', {
        id,
        label,
        phase: 'in-queue',
        message: 'Queue page found, but the Hold my spot button is not rendered yet.'
      })
      return false
    }

    this.emit('progress', {
      id,
      label,
      phase: 'in-queue',
      message: 'Holding the Walmart queue spot…'
    })
    try {
      await holdButton.waitFor({ state: 'visible', timeout: 10000 })
      await holdButton.click({ timeout: 10000 })
      await page.waitForTimeout(750).catch(() => {})
      return true
    } catch (error) {
      this.emit('progress', {
        id,
        label,
        phase: 'in-queue',
        message: `Queue spot detected, but Walmart hold button could not be clicked: ${error.message}`
      })
      return false
    }
  }

  _getHoldButton(page) {
    return page.getByRole
      ? page.getByRole('button', { name: /Hold my spot and Keep shopping/i }).first()
      : page.locator('button:has-text("Hold my spot and Keep shopping")').first()
  }

  async _waitForHoldButton(page, ms) {
    if (ms <= 0) return false
    const holdButton = this._getHoldButton(page)
    try {
      await holdButton.waitFor({ state: 'visible', timeout: ms })
      return true
    } catch {
      return false
    }
  }

  // Rough % from the token's own ETA: elapsed / (elapsed + remaining).
  // ponytail: heuristic bar, not a real position counter; Walmart doesn't expose one.
  _percent(startedAt, st) {
    const remaining = secondsUntilTurn(st)
    if (remaining == null) return null
    const elapsed = (Date.now() - startedAt) / 1000
    const total = elapsed + remaining
    return total <= 0 ? 0 : Math.min(99, Math.round((elapsed / total) * 100))
  }
}

function toSafeQueueStatus(status = {}) {
  const safe = {}
  for (const key of [
    'state',
    'queued',
    'inQueue',
    'yourTurn',
    'ticket',
    'queueId',
    'itemId',
    'itemUrl',
    'itemName',
    'price',
    'admissionLikelihood',
    'refreshSec',
    'expectedTurnMs',
    'expiresMs'
  ]) {
    if (status[key] !== undefined && status[key] !== null) safe[key] = status[key]
  }
  return safe
}

function queueCycleIdFor(status, urlOrToken) {
  if (status?.ticket !== undefined && status?.ticket !== null) {
    return `walmart-queue:${status.ticket}`
  }
  if (status?.queueId) {
    return `walmart-queue:${status.queueId}:${status.itemId || 'unknown-item'}`
  }
  const token = qpdataToken(urlOrToken)
  if (!token) return null
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 24)
  return `walmart-queue:token:${digest}`
}

function qpdataToken(urlOrToken) {
  const value = String(urlOrToken || '')
  if (!value) return null
  if (!value.includes('qpdata=')) return value
  try {
    return new URL(value, 'https://www.walmart.com').searchParams.get('qpdata')
  } catch {
    return value.slice(value.indexOf('qpdata=') + 'qpdata='.length)
  }
}
