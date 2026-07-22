import { EventEmitter } from 'events'
import { createModuleLogger } from '../utils/logger.js'
import { waitForCaptchaIfNeeded } from './captcha.js'

const log = createModuleLogger('PokemonCenterQueueJoiner')
const QUEUE_MARKERS = [
  /virtual queue to enter pok(?:e|é)mon center/i,
  /estimated wait time/i,
  /keep this window open/i,
  /do not refresh the page/i
]

export class PokemonCenterQueueJoiner extends EventEmitter {
  // UPDATED constructor
  constructor({
    browserPool,
    maxWaitMin = 180,
    openExternal = null,
    notificationEngine = null,
    capsolverApiKey = null
  }) {
    super()
    this.browserPool = browserPool
    this.maxWaitMin = maxWaitMin
    this.openExternal = openExternal
    this.notificationEngine = notificationEngine
    this.capsolverApiKey = capsolverApiKey
    this._jobs = new Map()
  }

  isJoining(id) {
    return this._jobs.has(id)
  }

  start(id, { productUrl, label, account, browserMode = 'managed' }) {
    if (this._jobs.has(id)) return
    const job = {
      accountId: account?.id || null,
      context: null,
      page: null,
      ownsContext: false,
      stopped: false
    }
    this._jobs.set(id, job)
    this._run(id, job, {
      productUrl,
      label: label || 'Pokemon Center',
      account,
      browserMode
    }).catch(async (error) => {
      log.error('Pokemon Center queue join crashed', { id, error: error.message })
      this.emit('progress', {
        id,
        retailer: 'pokemon-center',
        label,
        phase: 'error',
        message: error.message
      })
      await this._release(id, job)
    })
  }

  async stop(id) {
    const job = this._jobs.get(id)
    if (!job) return
    job.stopped = true
    await this._release(id, job)
    this.emit('progress', { id, retailer: 'pokemon-center', phase: 'stopped' })
  }

  async _release(id, job) {
    try {
      if (job.ownsContext) await job.context?.close()
      else await job.page?.close()
    } catch {
      // Best effort cleanup.
    }
    if (job.accountId && !job.external) {
      await this.browserPool.unpin(job.accountId).catch(() => {})
    }
    this._jobs.delete(id)
  }

  async stopAll() {
    for (const id of [...this._jobs.keys()]) await this.stop(id)
  }

  async _run(id, job, { productUrl, label, account, browserMode }) {
    this.emit('progress', {
      id,
      retailer: 'pokemon-center',
      label,
      phase: 'joining',
      message: account
        ? `Opening Pokemon Center as ${account.name || 'account'}...`
        : 'Opening Pokemon Center without a saved profile...'
    })

    const queueUrl = productUrl || 'https://www.pokemoncenter.com/'
    if ((browserMode === 'system' || !account?.profile_path) && this.openExternal) {
      await this.openExternal(queueUrl)
      job.external = true
      this.emit('progress', {
        id,
        retailer: 'pokemon-center',
        label,
        phase: 'external-open',
        message:
          'Queue detected. Opened one tab in your system browser; it will remain open if PokeBot exits.'
      })
      return
    }

    if (account?.profile_path) {
      job.context = await this.browserPool.pin(account.id, {
        profilePath: account.profile_path,
        proxy: account.proxy
      })
    } else {
      job.context = await this.browserPool.launchContext({
        accountId: `pokemon-center-queue-${id}`
      })
      job.ownsContext = true
    }
    job.page = await job.context.newPage()

    const dropEvent = { productName: label || 'Pokemon Center Queue' }
    const joinDeadline = Date.now() + 3 * 60_000
    let state = null
    while (!job.stopped && Date.now() < joinDeadline) {
      await job.page
        .goto(queueUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000
        })
        .catch(() => {})

      // --- CAPTCHA HANDLER CALLED HERE ---
      await waitForCaptchaIfNeeded(
        job.page,
        this.notificationEngine,
        dropEvent,
        this.capsolverApiKey
      )

      await new Promise((r) => setTimeout(r, 1500))
      state = await this._readQueueState(job.page)
      if (state.inQueue) break
      this.emit('progress', {
        id,
        retailer: 'pokemon-center',
        label,
        phase: 'joining',
        message: 'Queue signal received; waiting for this browser to be routed into line.'
      })
      await new Promise((r) => setTimeout(r, 8000))
    }
    if (job.stopped) return
    if (!state?.inQueue) {
      this.emit('progress', {
        id,
        retailer: 'pokemon-center',
        label,
        phase: 'error',
        message: 'Pokemon Center did not route this browser into the queue within 3 minutes.'
      })
      await this._release(id, job)
      return
    }

    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMin * 60_000
    let nonQueueReads = 0
    while (!job.stopped && Date.now() < deadline) {
      state = await this._readQueueState(job.page)
      if (state.inQueue) {
        nonQueueReads = 0
        this.emit('progress', {
          id,
          retailer: 'pokemon-center',
          label,
          phase: 'in-queue',
          etaSec: state.etaSec,
          message:
            state.etaSec == null
              ? 'In the Pokemon Center queue. Do not refresh.'
              : 'In line. The browser will stay open without refreshing.'
        })
      } else {
        nonQueueReads += 1
        if (nonQueueReads >= 2) {
          const payload = {
            id,
            retailer: 'pokemon-center',
            label,
            phase: 'turn',
            message: 'ADMITTED — Pokemon Center is ready. Browser left open.'
          }
          this.emit('progress', payload)
          this.emit('turn', { ...payload, context: job.context, page: job.page })
          return
        }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }

    if (!job.stopped) {
      this.emit('progress', {
        id,
        retailer: 'pokemon-center',
        label,
        phase: 'timeout',
        message: `Still queued after ${this.maxWaitMin} minutes; browser remains open.`
      })
    }
  }

  async _readQueueState(page) {
    const texts = []
    for (const frame of page.frames()) {
      const text = await frame
        .locator('body')
        .innerText()
        .catch(() => '')
      if (text) texts.push(text)
    }
    const body = texts.join('\n')
    const markerCount = QUEUE_MARKERS.filter((marker) => marker.test(body)).length
    const urlLooksQueued = /queue|waitingroom|queue-it/i.test(page.url())
    const etaMatch = body.match(/estimated wait time\s*:?\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/i)
    let etaSec = null
    if (etaMatch) {
      etaSec = Number(etaMatch[1] || 0) * 3600 + Number(etaMatch[2]) * 60 + Number(etaMatch[3])
    }
    return { inQueue: markerCount >= 2 || (urlLooksQueued && markerCount >= 1), etaSec }
  }
}
