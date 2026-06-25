import { EventEmitter } from 'events'
import {
  parseQp,
  extractQpdataFromText,
  secondsUntilTurn
} from './walmartQueue.js'
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

  start(id, { productUrl, label, account }) {
    if (this._jobs.has(id)) return
    const job = { context: null, page: null, ownsContext: false, stopped: false }
    this._jobs.set(id, job)
    this._run(id, job, { productUrl, label: label || id, account }).catch((err) => {
      log.error('Queue join crashed', { id, error: err.message })
      this.emit('progress', { id, label, phase: 'error', message: err.message })
      this._jobs.delete(id)
    })
  }

  async stop(id) {
    const job = this._jobs.get(id)
    if (!job) return
    job.stopped = true
    try {
      // Only close throwaway contexts. An account's persistent context is shared
      // (the pool owns it) — closing it would kill the logged-in session, so just
      // close our page.
      if (job.ownsContext) await job.context?.close()
      else await job.page?.close()
    } catch {
      /* best-effort */
    }
    this._jobs.delete(id)
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
        proxy: account.proxy
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
    const page = await context.newPage()
    job.page = page

    // Paste a normal /ip/ product URL — no /qp needed. A real browser hitting a
    // gated item IS the probe: Walmart bounces it to /qp on its own. Re-load the
    // item until that happens (or the deadline), so clicking BEFORE the queue is
    // live still auto-joins the moment it opens.
    // ponytail: reloads every ~20s for up to maxWaitMin; tighten rewatchSec if Walmart blocks.
    const watchDeadline = Date.now() + this.maxWaitMin * 60_000
    let qpUrl = null
    while (!job.stopped && Date.now() < watchDeadline) {
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      qpUrl = await this._waitForQueue(page, 8_000)
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

    this.emit('progress', { id, label, phase: 'in-queue', message: 'In line. Holding spot.' })
    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMin * 60_000

    while (!job.stopped && Date.now() < deadline) {
      const url = page.url()
      if (url.includes('qpdata=')) {
        let st = null
        try {
          st = parseQp(url)
        } catch {
          /* token not ready this tick */
        }
        if (st?.yourTurn) {
          this.emit('progress', { id, label, phase: 'turn', status: st, message: 'YOUR TURN — buy now!' })
          this.emit('turn', { id, label, status: st })
          return
        }
        if (st) {
          this.emit('progress', {
            id,
            label,
            phase: 'in-queue',
            ticket: st.ticket,
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
        // bounced off the waiting room entirely = admitted
        this.emit('progress', { id, label, phase: 'turn', message: 'Admitted — checkout open!' })
        this.emit('turn', { id, label })
        return
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
  async _waitForQueue(page, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const url = page.url()
      if (url.includes('qpdata=') || url.includes('/qp')) return url
      const body = await page.content().catch(() => '')
      const tok = extractQpdataFromText(body)
      if (tok) return `https://www.walmart.com/qp?qpdata=${tok}`
      await page.waitForTimeout(1000).catch(() => {})
    }
    return null
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
