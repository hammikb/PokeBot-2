import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { runWalmartFlow } from '../automation/flows/walmart.js'
import { runTargetFlow } from '../automation/flows/target.js'
import { runPokemonCenterFlow } from '../automation/flows/pokemon-center.js'
import { runCostcoFlow } from '../automation/flows/costco.js'
import { runSamsClubFlow } from '../automation/flows/samsclub.js'
import { RetryManager } from '../utils/retryManager.js'
import { extractProductKey } from '../products/productKey.js'
import { SupabaseMonitorSource } from '../monitor/SupabaseMonitorSource.js'
import { DROP_TYPES } from '../../shared/constants.js'
import { createModuleLogger } from '../utils/logger.js'
import { RetailerCircuitBreaker } from './RetailerCircuitBreaker.js'
import { OrderSubmissionGate } from './OrderSubmissionGate.js'
import { DropEventLedger } from './DropEventLedger.js'

const log = createModuleLogger('TaskManager')
const POKEMON_CENTER_AUTO_JOIN_ID = 'pokemon-center-auto-join'
const POKEMON_CENTER_QUEUE_URL = 'https://www.pokemoncenter.com/'
const POKEMON_CENTER_QUEUE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000
const WALMART_AUTO_QUEUE_PREFIX = 'walmart-auto-queue:'
const QUEUE_CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000
const REALTIME_RECOVERY_DELAY_MS = 1500

const FLOWS = {
  walmart: runWalmartFlow,
  target: runTargetFlow,
  'pokemon-center': runPokemonCenterFlow,
  costco: runCostcoFlow,
  samsclub: runSamsClubFlow
}

export class TaskManager extends EventEmitter {
  constructor({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings = () => ({}),
    authSessionManager = null,
    createSupabaseSource = null,
    queueJoiner = null,
    pokemonCenterQueueJoiner = null,
    checkoutTelemetry = null,
    paymentManager = null,
    retailerCircuit = new RetailerCircuitBreaker(),
    dropEventLedger = null,
    queueCheckoutTimeoutMs = QUEUE_CHECKOUT_TIMEOUT_MS
  }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._queueJoiner = queueJoiner
    this._pokemonCenterQueueJoiner = pokemonCenterQueueJoiner
    this._checkoutTelemetry = checkoutTelemetry
    this._paymentManager = paymentManager
    this._retailerCircuit = retailerCircuit
    this._getDb = getDb
    this._dropEventLedger = dropEventLedger || new DropEventLedger({ db: getDb() })
    this._queueCheckoutTimeoutMs = Math.max(
      1,
      Number(queueCheckoutTimeoutMs) || QUEUE_CHECKOUT_TIMEOUT_MS
    )
    this._getSettings = getSettings
    this._authSessionManager = authSessionManager
    this._tasks = new Map()
    this._warmAccountsByTask = new Map()
    this._warmAccountRefs = new Map()
    this._activeCheckoutRuns = new Set()
    this._activeAccountCheckoutRuns = new Set()
    this._accountCheckoutLeases = new Map()
    this._manualReviewAccounts = new Set()
    this._productOperations = new Map()
    this._taskStartPromises = new Map()
    this._unsubscribeRetryTimer = null
    this._unsubscribeRetryAttempt = 0
    this._realtimeHeartbeatStatus = 'unknown'
    this._realtimeHeartbeatAt = null
    this._realtimeHeartbeatFailures = 0
    this._realtimeRecoveryTimer = null
    this._monitorRefreshPromise = null
    this._pokemonCenterAutoJoinEnabled = false
    this._pokemonCenterQueueAlertedAt = 0
    this._walmartJoinAllQueuesEnabled = false
    this._walmartAutoQueueJobIds = new Set()
    this._walmartQueueAccountId = null
    this._recoverUncertainAccountHolds()

    this._supabaseSource = null
    this._supabaseSourcePromise = null
    this._supabaseSourceUserId = null
    this._lastSupabaseUserId = this._currentSupabaseUserId()
    this._supabaseSourceGeneration = 0
    this._createSupabaseSource = createSupabaseSource || (() => this._buildSupabaseSource())
    this._queueJoiner?.on('turn', (payload) => {
      this._onQueueTurn(payload).catch((err) => {
        this.emit('drop', {
          retailer: 'walmart',
          productName: `Queue checkout error: ${err.message}`,
          dropType: 'supabase_notice'
        })
      })
    })
    this._queueJoiner?.on('progress', (payload) => {
      if (
        this._walmartAutoQueueJobIds.has(payload?.id) &&
        ['stopped', 'timeout', 'error', 'no-queue'].includes(payload?.phase)
      ) {
        this._walmartAutoQueueJobIds.delete(payload.id)
      }
    })
  }

  async _buildSupabaseSource() {
    if (!this._authSessionManager?.getStatus().authenticated) {
      throw new Error('Not signed in to Supabase yet')
    }
    return new SupabaseMonitorSource({ client: this._authSessionManager.getClient() })
  }

  async _getSupabaseSource() {
    const userId = this._currentSupabaseUserId()
    if (!userId) throw new Error('Sign in before using central monitoring')
    if (this._supabaseSource && this._supabaseSourceUserId === userId) {
      return this._supabaseSource
    }
    if (this._supabaseSource && this._supabaseSourceUserId !== userId) {
      await this._supabaseSource.stop?.().catch(() => {})
      this._supabaseSource = null
      this._supabaseSourcePromise = null
      this._supabaseSourceUserId = null
      this._supabaseSourceGeneration += 1
    }
    if (!this._supabaseSourcePromise) {
      const generation = this._supabaseSourceGeneration
      const sourcePromise = Promise.resolve(this._createSupabaseSource())
        .then(async (source) => {
          if (
            generation !== this._supabaseSourceGeneration ||
            userId !== this._currentSupabaseUserId()
          ) {
            await source.stop?.().catch(() => {})
            throw new Error('Supabase account changed while the monitor was connecting')
          }
          source.on('drop', (event) => {
            this._onDrop(event).catch((error) => {
              log.error('Could not process Supabase drop event', {
                eventId: event?.eventId || null,
                productId: event?.productId || null,
                error: error.message
              })
              this.emit('drop', {
                retailer: event?.retailer || 'catalog',
                productName: `Drop processing error: ${error.message}`,
                productUrl: event?.productUrl,
                dropType: 'supabase_notice'
              })
            })
          })
          source.on('notice', (notice) =>
            this.emit('drop', {
              retailer: 'catalog',
              productName: `ℹ️ ${notice.message}`,
              productUrl: notice.productUrl,
              dropType: 'supabase_notice'
            })
          )
          source.on('health', ({ productId, status, error }) => {
            if (status === 'SUBSCRIBED') {
              log.info('Supabase monitor channel ready', { productId })
            } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
              log.warn('Supabase monitor channel interrupted', {
                productId,
                status,
                error: error?.message
              })
            }
          })
          this._supabaseSource = source
          this._supabaseSourceUserId = userId
          this._lastSupabaseUserId = userId
          await this._flushPendingUnsubscribes(source, userId).catch((error) => {
            log.warn('Some pending central monitor stops still need retrying', {
              error: error.message
            })
            this._schedulePendingUnsubscribeRetry()
          })
          return source
        })
        .catch((error) => {
          if (this._supabaseSourcePromise === sourcePromise) {
            this._supabaseSourcePromise = null
          }
          throw error
        })
      this._supabaseSourcePromise = sourcePromise
    }
    return this._supabaseSourcePromise
  }

  startTask(taskRow) {
    if (this._tasks.has(taskRow.id)) {
      this._emitStatus(taskRow.id, 'monitoring')
      return this._taskStartPromises.get(taskRow.id) || Promise.resolve(true)
    }
    const taskProductKey = taskProductIdentity(taskRow)
    const duplicate = [...this._tasks.values()].find(
      (entry) => entry.id !== taskRow.id && taskProductIdentity(entry) === taskProductKey
    )
    if (duplicate) {
      const error = new Error(
        `This ${taskRow.retailer} product is already monitored by task ${duplicate.id}`
      )
      this._emitStatus(taskRow.id, 'error')
      return Promise.reject(error)
    }
    const activeTask = { ...taskRow, source: 'supabase' }
    this._tasks.set(taskRow.id, activeTask)
    this._emitStatus(taskRow.id, 'monitoring')
    // Pre-warm proxy accounts — the Pi handles monitoring but checkout runs
    // locally, and proxy browser launch is slow.
    this._retainTaskAccounts(taskRow)
    const startPromise = this._enqueueProductOperation(taskRow, () =>
      this._startSupabaseTask(taskRow)
    )
      .then(() => true)
      .catch((err) => {
        log.error('Failed to start Supabase monitor task', {
          taskId: taskRow.id,
          retailer: taskRow.retailer,
          productUrl: taskRow.product_url,
          error: err.message
        })
        if (this._tasks.get(taskRow.id) === activeTask) {
          this._tasks.delete(taskRow.id)
          this._releaseTaskAccounts(taskRow.id)
          this._emitStatus(taskRow.id, 'error')
        }
        this.emit('drop', {
          retailer: taskRow.retailer,
          productName: `Supabase monitor error: ${err.message}`,
          productUrl: taskRow.product_url,
          dropType: 'supabase_notice'
        })
        throw err
      })
      .finally(() => {
        if (this._taskStartPromises.get(taskRow.id) === startPromise) {
          this._taskStartPromises.delete(taskRow.id)
        }
      })
    this._taskStartPromises.set(taskRow.id, startPromise)
    return startPromise
  }

  async _startSupabaseTask(taskRow) {
    const source = await this._getSupabaseSource()
    const userId = this._supabaseSourceUserId
    const pendingStop = this._getDb()
      .prepare('SELECT * FROM monitor_unsubscribe_outbox WHERE id = ? AND user_id = ?')
      .get(pendingUnsubscribeIdentity(taskRow, userId), userId)
    if (pendingStop) {
      throw new Error(
        'A previous central monitor stop is still pending; retry Stop before starting this task'
      )
    }
    const result = await source.addProduct({
      productUrl: taskRow.product_url,
      retailer: taskRow.retailer,
      productKey: extractProductKey(taskRow.retailer, taskRow.product_url),
      productName: taskRow.product_name || null,
      maxPrice: taskRow.max_price ?? null
    })
    if (result?.subscribed !== true) {
      throw new Error('The central monitor did not create a product subscription')
    }
    return result
  }

  stopTask(id, { unsubscribe = true } = {}) {
    const entry = this._tasks.get(id)
    if (!entry) {
      this.releaseAccountCheckoutsForTask(id)
      return Promise.resolve(false)
    }
    this.releaseAccountCheckoutsForTask(id)
    this._releaseTaskAccounts(id)
    this._tasks.delete(id)
    this._emitStatus(id, 'idle')
    return this._enqueueProductOperation(entry, async () => {
      if (unsubscribe) {
        this._queuePendingUnsubscribe(entry)
        try {
          const source = this._supabaseSource || (await this._getSupabaseSource())
          await source.unsubscribe(buildMonitorIdentity(entry))
          this._clearPendingUnsubscribe(entry)
          return true
        } catch (error) {
          this._markPendingUnsubscribeFailure(entry, error)
          this._schedulePendingUnsubscribeRetry()
          this._emitStatus(id, 'error')
          throw error
        }
      } else {
        await this._supabaseSource?.releaseChannel(entry.product_url)
      }
      return true
    })
  }

  async stopAll({ unsubscribe = true } = {}) {
    await Promise.allSettled(
      [...this._tasks.keys()].map((id) => this.stopTask(id, { unsubscribe }))
    )
  }

  async shutdown() {
    if (this._unsubscribeRetryTimer) clearTimeout(this._unsubscribeRetryTimer)
    this._unsubscribeRetryTimer = null
    if (this._realtimeRecoveryTimer) clearTimeout(this._realtimeRecoveryTimer)
    this._realtimeRecoveryTimer = null
    await this.stopAll({ unsubscribe: false })
    await this._supabaseSource?.stop?.().catch(() => {})
    this._checkoutTelemetry?.flushLocal?.()
    this._supabaseSource = null
    this._supabaseSourcePromise = null
    this._supabaseSourceUserId = null
  }

  handleRealtimeHeartbeat(status) {
    const normalized = ['ok', 'timeout', 'disconnected'].includes(status) ? status : 'unknown'
    this._realtimeHeartbeatStatus = normalized
    this._realtimeHeartbeatAt = Date.now()

    if (normalized === 'ok') {
      this._realtimeHeartbeatFailures = 0
      if (this._realtimeRecoveryTimer) clearTimeout(this._realtimeRecoveryTimer)
      this._realtimeRecoveryTimer = null
      return
    }

    this._realtimeHeartbeatFailures += 1
    if (
      (this._tasks.size === 0 &&
        !this._walmartJoinAllQueuesEnabled &&
        !this._pokemonCenterAutoJoinEnabled) ||
      this._realtimeRecoveryTimer ||
      (normalized === 'timeout' && this._realtimeHeartbeatFailures < 2)
    ) {
      return
    }

    this._realtimeRecoveryTimer = setTimeout(() => {
      this._realtimeRecoveryTimer = null
      this.refreshMonitorConnections(`realtime-${normalized}`).catch((error) => {
        log.warn('Could not recover Supabase monitor channels after heartbeat failure', {
          status: normalized,
          error: error.message
        })
      })
    }, REALTIME_RECOVERY_DELAY_MS)
    this._realtimeRecoveryTimer.unref?.()
  }

  async refreshMonitorConnections(reason = 'manual') {
    if (this._monitorRefreshPromise) return this._monitorRefreshPromise
    const state = this._authSessionManager?.getStatus?.()
    if (!state?.authenticated) return { authenticated: false, rebound: 0 }

    log.info('Refreshing Supabase monitor channels', {
      reason,
      activeTasks: this._tasks.size
    })
    this._monitorRefreshPromise = this.handleAuthChange(state).finally(() => {
      this._monitorRefreshPromise = null
    })
    return this._monitorRefreshPromise
  }

  async handleSystemResume() {
    const accountIds = [...this._warmAccountRefs.keys()]
    const browserResults = await Promise.allSettled(
      accountIds.map(async (accountId) => {
        const account = this._accountManager.getDecrypted(accountId)
        if (!account?.profile_path) return false
        await this._pool.pin(accountId, {
          profilePath: account.profile_path,
          proxy: account.proxy,
          retailer: account.retailer,
          priority: 10
        })
        return true
      })
    )
    const monitorResult = await this.refreshMonitorConnections('system-resume')
    return {
      browsersRecovered: browserResults.filter(
        (result) => result.status === 'fulfilled' && result.value === true
      ).length,
      monitorResult
    }
  }

  async handleAuthChange(state) {
    const nextUserId = state?.authenticated ? state.user?.id || null : null
    this._supabaseSourceGeneration += 1
    const source = this._supabaseSource
    this._supabaseSource = null
    this._supabaseSourcePromise = null
    this._supabaseSourceUserId = null
    await source?.stop?.().catch((error) => {
      log.warn('Could not close the previous Supabase monitor source', {
        error: error.message
      })
    })

    if (!nextUserId) return { authenticated: false, rebound: 0 }
    this._lastSupabaseUserId = nextUserId

    const tasks = [...this._tasks.values()]
    const results = await Promise.allSettled(
      tasks.map((taskRow) =>
        this._enqueueProductOperation(taskRow, () => this._startSupabaseTask(taskRow))
      )
    )
    results.forEach((result, index) => {
      const task = tasks[index]
      if (!task) return
      this._emitStatus(task.id, result.status === 'fulfilled' ? 'monitoring' : 'error')
      if (result.status === 'rejected') {
        log.warn('Could not rebind monitor task after account change', {
          taskId: task.id,
          error: result.reason?.message
        })
      }
    })
    await this.retryPendingUnsubscribes().catch((error) => {
      log.warn('Could not drain this user’s pending central monitor stops', {
        error: error.message
      })
    })
    let walmartQueueFeedConnected = false
    if (this._walmartJoinAllQueuesEnabled) {
      const queueFeed = await this.setWalmartJoinAllQueues(true)
      walmartQueueFeedConnected = queueFeed.connected === true
    }
    return {
      authenticated: true,
      rebound: results.filter((result) => result.status === 'fulfilled').length,
      walmartQueueFeedConnected
    }
  }

  async unsubscribeCentral(taskRow) {
    return this._enqueueProductOperation(taskRow, async () => {
      this._queuePendingUnsubscribe(taskRow)
      try {
        const source = await this._getSupabaseSource()
        await source.unsubscribe(buildMonitorIdentity(taskRow))
        this._clearPendingUnsubscribe(taskRow)
        return true
      } catch (error) {
        this._markPendingUnsubscribeFailure(taskRow, error)
        this._schedulePendingUnsubscribeRetry()
        throw error
      }
    })
  }

  async _flushPendingUnsubscribes(source, userId = this._supabaseSourceUserId) {
    if (!userId) return 0
    const rows = this._getDb()
      .prepare('SELECT * FROM monitor_unsubscribe_outbox WHERE user_id = ?')
      .all(userId)
    const failures = []
    for (const row of rows) {
      try {
        await source.unsubscribe(buildMonitorIdentity(row))
        this._clearPendingUnsubscribe(row)
      } catch (error) {
        failures.push(error)
        this._markPendingUnsubscribeFailure(row, error)
      }
    }
    if (failures.length) {
      this._schedulePendingUnsubscribeRetry()
      throw new Error(`${failures.length} central monitor stop request(s) could not be confirmed`)
    }
    this._unsubscribeRetryAttempt = 0
    if (this._unsubscribeRetryTimer) clearTimeout(this._unsubscribeRetryTimer)
    this._unsubscribeRetryTimer = null
    return rows.length
  }

  async retryPendingUnsubscribes() {
    const userId = this._currentSupabaseUserId()
    if (!userId) return { pending: 0, cleared: 0 }
    const rows = this._getDb()
      .prepare('SELECT * FROM monitor_unsubscribe_outbox WHERE user_id = ?')
      .all(userId)
    if (!rows.length) return { pending: 0, cleared: 0 }
    try {
      const source = await this._getSupabaseSource()
      const cleared = await this._flushPendingUnsubscribes(source, userId)
      return { pending: 0, cleared }
    } catch (error) {
      this._schedulePendingUnsubscribeRetry()
      throw error
    }
  }

  _schedulePendingUnsubscribeRetry() {
    if (this._unsubscribeRetryTimer) return
    this._unsubscribeRetryAttempt += 1
    const delayMs = Math.min(5000 * 2 ** (this._unsubscribeRetryAttempt - 1), 5 * 60_000)
    this._unsubscribeRetryTimer = setTimeout(() => {
      this._unsubscribeRetryTimer = null
      this.retryPendingUnsubscribes().catch((error) => {
        log.warn('Pending central monitor stop retry failed', { error: error.message })
      })
    }, delayMs)
    this._unsubscribeRetryTimer.unref?.()
  }

  _queuePendingUnsubscribe(taskRow) {
    const userId =
      this._currentSupabaseUserId() || this._supabaseSourceUserId || this._lastSupabaseUserId
    if (!userId) {
      throw new Error('Sign in with the account that owns this central monitor before stopping it')
    }
    this._getDb()
      .prepare(
        `INSERT INTO monitor_unsubscribe_outbox
          (id, user_id, retailer, product_url, product_key, created_at, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          retailer = excluded.retailer,
          product_url = excluded.product_url,
          product_key = excluded.product_key`
      )
      .run(
        pendingUnsubscribeIdentity(taskRow, userId),
        userId,
        taskRow.retailer,
        taskRow.product_url,
        extractProductKey(taskRow.retailer, taskRow.product_url),
        Date.now(),
        0,
        null
      )
  }

  _clearPendingUnsubscribe(taskRow) {
    const id =
      taskRow.id && taskRow.user_id
        ? taskRow.id
        : pendingUnsubscribeIdentity(
            taskRow,
            this._currentSupabaseUserId() || this._supabaseSourceUserId || this._lastSupabaseUserId
          )
    this._getDb().prepare('DELETE FROM monitor_unsubscribe_outbox WHERE id = ?').run(id)
  }

  _markPendingUnsubscribeFailure(taskRow, error) {
    const id =
      taskRow.id && taskRow.user_id
        ? taskRow.id
        : pendingUnsubscribeIdentity(
            taskRow,
            this._currentSupabaseUserId() || this._supabaseSourceUserId || this._lastSupabaseUserId
          )
    this._getDb()
      .prepare(
        `UPDATE monitor_unsubscribe_outbox
         SET attempts = attempts + 1, last_error = ?
         WHERE id = ?`
      )
      .run(String(error?.message || error || 'unknown error').slice(0, 500), id)
  }

  _currentSupabaseUserId() {
    const status = this._authSessionManager?.getStatus?.()
    if (!this._authSessionManager) return 'local-source'
    return status?.authenticated ? status.user?.id || null : null
  }

  _enqueueProductOperation(taskRow, operation) {
    const productKey = taskProductIdentity(taskRow)
    const previous = this._productOperations.get(productKey) || Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(operation)
      .finally(() => {
        if (this._productOperations.get(productKey) === current) {
          this._productOperations.delete(productKey)
        }
      })
    this._productOperations.set(productKey, current)
    return current
  }

  async setPokemonCenterAutoJoin(enabled) {
    const next = enabled === true
    this._pokemonCenterAutoJoinEnabled = next
    if (!next) {
      await this._pokemonCenterQueueJoiner?.stop(POKEMON_CENTER_AUTO_JOIN_ID)
      const queueIdentity = {
        id: POKEMON_CENTER_AUTO_JOIN_ID,
        product_url: POKEMON_CENTER_QUEUE_URL,
        retailer: 'pokemon-center',
        product_key: 'site-queue'
      }
      await this.unsubscribeCentral(queueIdentity)
      return { enabled: false, connected: false }
    }

    if (this._authSessionManager && !this._authSessionManager.getStatus().authenticated) {
      log.warn('Pokemon Center auto-join armed; waiting for Supabase authentication')
      return { enabled: true, connected: false, reason: 'auth-pending' }
    }

    try {
      const source = await this._getSupabaseSource()
      const result = await source.addProduct({
        productUrl: POKEMON_CENTER_QUEUE_URL,
        retailer: 'pokemon-center',
        productKey: 'site-queue',
        productName: 'Pokemon Center Queue',
        maxPrice: null
      })
      if (result?.subscribed === false) {
        log.warn('Pokemon Center auto-join armed; queue signal subscription is pending')
        return { enabled: true, connected: false, reason: 'subscription-pending' }
      }
      return { enabled: true, connected: true }
    } catch (error) {
      log.warn('Pokemon Center auto-join armed; connection will retry', {
        error: error.message
      })
      return { enabled: true, connected: false, reason: error.message }
    }
  }

  isPokemonCenterAutoJoinEnabled() {
    return this._pokemonCenterAutoJoinEnabled
  }

  async setWalmartJoinAllQueues(enabled) {
    const next = enabled === true
    this._walmartJoinAllQueuesEnabled = next
    if (!next) {
      await this._supabaseSource?.unsubscribeWalmartQueueFeed?.()
      await Promise.allSettled(
        [...this._walmartAutoQueueJobIds].map((id) => this._queueJoiner?.stop(id))
      )
      this._walmartAutoQueueJobIds.clear()
      if (this._walmartQueueAccountId) {
        await Promise.resolve(
          this._pool?.unpin?.(this._walmartQueueAccountId, { close: true })
        ).catch(() => {})
        this._walmartQueueAccountId = null
      }
      return { enabled: false, connected: false }
    }

    if (this._authSessionManager && !this._authSessionManager.getStatus().authenticated) {
      log.warn('Walmart join-all-queues is armed; waiting for Supabase authentication')
      return { enabled: true, connected: false, reason: 'auth-pending' }
    }

    try {
      const source = await this._getSupabaseSource()
      const result = await source.subscribeWalmartQueueFeed()
      await this._warmWalmartQueueAccount()
      return { enabled: true, connected: result?.subscribed === true }
    } catch (error) {
      log.warn('Walmart join-all-queues is armed; connection will retry', {
        error: error.message
      })
      return { enabled: true, connected: false, reason: error.message }
    }
  }

  isWalmartJoinAllQueuesEnabled() {
    return this._walmartJoinAllQueuesEnabled
  }

  async _warmWalmartQueueAccount() {
    if (!this._pool?.pin) return false
    const account = this._getWalmartQueueAccount()
    if (!account?.id || !account.profile_path) return false
    if (this._walmartQueueAccountId === account.id && this._pool.isPinned?.(account.id)) {
      return true
    }

    if (this._walmartQueueAccountId && this._walmartQueueAccountId !== account.id) {
      await Promise.resolve(
        this._pool.unpin?.(this._walmartQueueAccountId, { close: true })
      ).catch(() => {})
      this._walmartQueueAccountId = null
    }

    try {
      await this._pool.pin(account.id, {
        profilePath: account.profile_path,
        proxy: account.proxy,
        retailer: 'walmart'
      })
      this._walmartQueueAccountId = account.id
      log.info('Pre-warmed Walmart Join All Queues account', { accountId: account.id })
      return true
    } catch (error) {
      log.warn('Could not pre-warm Walmart Join All Queues account; queue alerts will launch it on demand', {
        accountId: account.id,
        error: error.message
      })
      return false
    }
  }

  clearAccountManualReview(accountId) {
    this._manualReviewAccounts.delete(accountId)
  }

  acquireAccountCheckout(accountId, owner = {}) {
    if (!accountId || !owner.ownerId) return { acquired: false, reason: 'invalid-owner' }
    const existing = this._accountCheckoutLeases.get(accountId)
    if (existing && existing.ownerId !== owner.ownerId) {
      return { acquired: false, reason: 'account-busy', owner: { ...existing } }
    }
    this._accountCheckoutLeases.set(accountId, { ...owner, accountId, acquiredAt: Date.now() })
    return { acquired: true }
  }

  releaseAccountCheckout(accountId, ownerId) {
    const existing = this._accountCheckoutLeases.get(accountId)
    if (!existing || existing.ownerId !== ownerId) return false
    this._accountCheckoutLeases.delete(accountId)
    return true
  }

  releaseAccountCheckoutsForTask(taskId) {
    let released = 0
    for (const [accountId, lease] of this._accountCheckoutLeases) {
      if (lease.taskId !== taskId) continue
      if (this.releaseAccountCheckout(accountId, lease.ownerId)) {
        released += 1
        Promise.resolve(this._pool.unpin?.(accountId, { close: true })).catch(() => {})
      }
    }
    return released
  }

  _getPokemonCenterAccount() {
    const account = this._accountManager
      .getAll?.()
      ?.find((entry) => entry.retailer === 'pokemon-center')
    return account ? this._accountManager.getDecrypted(account.id) : null
  }

  async testTask(taskRow) {
    const flow = FLOWS[taskRow.retailer]
    if (!flow) {
      this._emitStatus(taskRow.id, 'error')
      return {
        success: false,
        results: [
          { success: false, error: `Test checkout is not supported for ${taskRow.retailer}` }
        ]
      }
    }

    this._emitStatus(taskRow.id, 'testing')
    const dropEvent = {
      retailer: taskRow.retailer,
      productName: taskRow.product_name || 'Test checkout product',
      productUrl: taskRow.product_url,
      dropType: 'test_checkout',
      price: taskRow.max_price ?? null
    }

    const result = await this._runFlowsForTask({ ...taskRow, mode: 'test-checkout' }, dropEvent)
    this._emitStatus(taskRow.id, result.success ? 'idle' : 'error')
    return result
  }

  getActiveTasks() {
    return [...this._tasks.keys()]
  }

  getMonitorHealthSnapshot() {
    const channelHealth = this._supabaseSource?.getHealth?.() || {}
    const channels = Object.values(channelHealth)
    const interruptedStatuses = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])

    return {
      activeTaskCount: this._tasks.size,
      sourceState: this._supabaseSource
        ? 'connected'
        : this._supabaseSourcePromise
          ? 'connecting'
          : 'idle',
      heartbeat: {
        status: this._realtimeHeartbeatStatus,
        lastAt: this._realtimeHeartbeatAt
      },
      channels: {
        total: channels.length,
        subscribed: channels.filter((channel) => channel.status === 'SUBSCRIBED').length,
        connecting: channels.filter((channel) =>
          ['CONNECTING', 'CATCH_UP_COMPLETE'].includes(channel.status)
        ).length,
        interrupted: channels.filter((channel) => interruptedStatuses.has(channel.status)).length,
        catchingUp: channels.filter((channel) => channel.catchingUp === true).length,
        catchUpErrors: channels.filter((channel) => Boolean(channel.catchUpError)).length
      },
      openCircuits: Object.values(this._retailerCircuit?.snapshot?.() || {}).filter(
        (state) => state?.open === true || (state?.open === undefined && Boolean(state?.openedAt))
      ).length
    }
  }

  async _onDrop(dropEvent) {
    const task = [...this._tasks.values()].find((t) => t.product_url === dropEvent.productUrl)
    const receipt =
      task && dropEvent.dropType !== DROP_TYPES.QUEUE_OPEN
        ? this._dropEventLedger.claim({
            taskId: task.id,
            eventId: dropEvent.eventId,
            dropCycleId: dropEvent.dropCycleId,
            retailer: dropEvent.retailer,
            productId: dropEvent.productId
          })
        : { claimed: true, receiptId: null }

    if (!receipt.claimed) {
      log.info('Ignoring a previously handled durable drop event', {
        taskId: task.id,
        eventId: dropEvent.eventId || null,
        dropCycleId: dropEvent.dropCycleId || null,
        receiptStatus: receipt.status || null
      })
      return
    }
    if (receipt.receiptId) {
      dropEvent = { ...dropEvent, receiptId: receipt.receiptId }
    }

    // Queue went live: auto-join with the task's account (joiner dedupes on its
    // own). No checkout — the joiner gets you to the front, you finish the buy.
    if (dropEvent.dropType === DROP_TYPES.QUEUE_OPEN) {
      if (dropEvent.retailer === 'pokemon-center') {
        const now = Date.now()
        if (now - this._pokemonCenterQueueAlertedAt < POKEMON_CENTER_QUEUE_ALERT_COOLDOWN_MS) {
          log.info('Suppressing duplicate Pokemon Center queue signal', {
            lastAlertedAt: new Date(this._pokemonCenterQueueAlertedAt).toISOString()
          })
          return
        }
        this._pokemonCenterQueueAlertedAt = now
      }
      this.emit('drop', dropEvent)
      await this._notify.fire(dropEvent)
      const joiner =
        dropEvent.retailer === 'pokemon-center'
          ? this._pokemonCenterQueueJoiner
          : dropEvent.retailer === 'walmart'
            ? this._queueJoiner
            : null
      if (dropEvent.retailer === 'pokemon-center' && this._pokemonCenterAutoJoinEnabled && joiner) {
        joiner.start(POKEMON_CENTER_AUTO_JOIN_ID, {
          productUrl: POKEMON_CENTER_QUEUE_URL,
          label: 'Pokemon Center Queue',
          account: this._getPokemonCenterAccount(),
          browserMode: this._getSettings().pokemonCenterQueueBrowser || 'managed'
        })
      } else if (dropEvent.retailer === 'walmart' && this._walmartJoinAllQueuesEnabled && joiner) {
        const taskAccountIds = task ? parseAccountIds(task.account_ids) : []
        const account = taskAccountIds.length
          ? this._accountManager.getDecrypted(taskAccountIds[0])
          : this._getWalmartQueueAccount()
        if (!account) {
          this.emit('drop', {
            retailer: 'walmart',
            productName:
              'Walmart queue detected, but no active Walmart account is configured for Join All Queues.',
            productUrl: dropEvent.productUrl,
            dropType: 'supabase_notice'
          })
        } else {
          const id = task?.id || walmartAutoQueueJobId(dropEvent)
          if (!task) this._walmartAutoQueueJobIds.add(id)
          joiner.start(id, {
            productUrl: dropEvent.productUrl,
            label: dropEvent.productName || dropEvent.productUrl,
            account
          })
        }
      } else if (task && joiner) {
        const accountIds = parseAccountIds(task.account_ids)
        const account = accountIds.length ? this._accountManager.getDecrypted(accountIds[0]) : null
        joiner.start(task.id, {
          productUrl: task.product_url,
          label: task.product_name || task.product_url,
          account,
          browserMode: this._getSettings().pokemonCenterQueueBrowser || 'managed'
        })
      }
      this._dropEventLedger.complete(receipt.receiptId, { status: 'queue_joined' })
      return
    }

    // Alert-only mode: fire a single enriched notification and stop — no checkout.
    if (task?.mode === 'alert-only') {
      const alertEvent = {
        ...dropEvent,
        productName: `🔔 ${dropEvent.productName} is in stock!`
      }
      this.emit('drop', alertEvent)
      await this._notify.fire(alertEvent)
      this._dropEventLedger.complete(receipt.receiptId, { status: 'alerted' })
      return
    }

    // All other modes: emit the raw drop event and fire the notification.
    this.emit('drop', dropEvent)
    await this._notify.fire(dropEvent)

    if (!task) return

    const flow = FLOWS[dropEvent.retailer]
    if (!flow) {
      this._dropEventLedger.complete(receipt.receiptId, {
        status: 'ignored',
        detail: `No checkout flow for ${dropEvent.retailer}`
      })
      return
    }

    let result
    if (task.mode === 'test-checkout') {
      result = await this._runFlowsForTask({ ...task, mode: 'test-checkout' }, dropEvent)
    } else {
      result = await this._runFlowsForTask(task, dropEvent)
    }
    const receiptResult = classifyDropReceiptResult(result)
    this._dropEventLedger.complete(receipt.receiptId, {
      status: receiptResult.status,
      detail: receiptResult.detail
    })
  }

  async _onQueueTurn({ id, label, status, context }) {
    const task =
      this._tasks.get(id) || this._getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!task || !context || task.retailer !== 'walmart') return
    if (!['auto-checkout', 'monitor-and-buy', 'test-checkout'].includes(task.mode)) return

    const accountIds = parseAccountIds(task.account_ids)
    const account = accountIds.length ? this._accountManager.getDecrypted(accountIds[0]) : null
    if (!account) return
    if (account.status === 'manual_review' || this._manualReviewAccounts.has(account.id)) {
      this._emitStatus(id, 'manual_required')
      await this._notify.fire({
        retailer: 'walmart',
        productName: `QUEUE READY - MANUAL CHECKOUT NEEDED [${account.name}]: clear the account's previous uncertain-order hold first`,
        productUrl: task.product_url,
        dropType: DROP_TYPES.PRICE_DROP
      })
      return
    }

    if (this._activeAccountCheckoutRuns.has(account.id)) {
      this._emitStatus(id, 'manual_required')
      await this._notify.fire({
        retailer: 'walmart',
        productName: `QUEUE READY - MANUAL CHECKOUT NEEDED [${account.name}]: account is already checking out another item`,
        productUrl: task.product_url,
        dropType: DROP_TYPES.PRICE_DROP
      })
      return
    }

    const stableQueueCycle = status?.queueCycleId || status?.ticket || null
    if (!stableQueueCycle) {
      this._emitStatus(id, 'manual_required')
      await this._notify.fire({
        retailer: 'walmart',
        productName: `QUEUE READY - MANUAL CHECKOUT NEEDED [${account.name}]: the queue ticket could not be verified safely`,
        productUrl: task.product_url,
        dropType: DROP_TYPES.PRICE_DROP
      })
      return
    }

    this._activeAccountCheckoutRuns.add(account.id)
    try {
      const queueCycleId = String(stableQueueCycle).startsWith('walmart-queue:')
        ? String(stableQueueCycle)
        : `walmart-queue:${stableQueueCycle}`
      const receipt = this._dropEventLedger.claim({
        taskId: task.id,
        dropCycleId: queueCycleId,
        retailer: 'walmart'
      })
      if (!receipt.claimed) {
        log.info('Skipping a Walmart queue checkout already handled for this queue cycle', {
          taskId: task.id,
          queueCycleId,
          receiptStatus: receipt.status || null
        })
        if (receipt.status === 'submission_started') {
          await this._notify.fire({
            retailer: 'walmart',
            productName: `ORDER STATUS UNCERTAIN - MANUAL REVIEW [${account.name}]: ${task.product_name || label || 'Walmart product'}`,
            productUrl: task.product_url,
            dropType: DROP_TYPES.PRICE_DROP
          })
        }
        return
      }

      const dropEvent = {
        retailer: 'walmart',
        productName: status?.itemName || task.product_name || label || 'Walmart product',
        productUrl: task.product_url,
        dropType: DROP_TYPES.IN_STOCK,
        price: status?.price || task.max_price || null,
        receiptId: receipt.receiptId,
        dropCycleId: queueCycleId
      }
      this._emitStatus(id, 'checkout')
      this.emit('drop', dropEvent)
      await this._notify.fire(dropEvent)

      const attemptId = this._checkoutTelemetry?.beginAttempt({
        task,
        dropEvent,
        accountId: account.id
      })
      this._checkoutTelemetry?.record(attemptId, 'queue_waiting', 'Walmart queue admitted')
      let timeout
      let deadlineExpired = false
      let orderSubmissionAttempted = false
      const checkout = runWalmartFlow(context, {
        productUrl: dropEvent.productUrl,
        cvv: account.cvv,
        account,
        notificationEngine: this._notify,
        dropEvent,
        mode: task.mode,
        buyLimit: task.buy_limit,
        maxPrice: task.max_price,
        requireRetailerSeller: this._getSettings().walmartRequireRetailerSeller !== false,
        recordCheckoutTrace: this._getSettings().recordCheckoutTraces === true,
        onBeforeSubmit: () => {
          if (deadlineExpired) {
            throw new Error('Walmart queue checkout deadline expired before order submission')
          }
          this._dropEventLedger.markSubmissionStarted(receipt.receiptId, {
            accountId: account.id,
            orderSequence: 1
          })
          orderSubmissionAttempted = true
        },
        onStep: (message) => {
          this._emitCheckoutStep(dropEvent, account, message)
          this._checkoutTelemetry?.record(attemptId, message)
        },
        onMilestone: (stage, detail, metadata = {}) => {
          this._checkoutTelemetry?.record(attemptId, stage, `milestone:${detail}`, metadata)
        }
      })
      const deadline = new Promise((resolve) => {
        timeout = setTimeout(() => {
          deadlineExpired = true
          resolve(
            orderSubmissionAttempted
              ? {
                  success: false,
                  terminal: true,
                  orderSubmissionAttempted: true,
                  submissionUncertain: true,
                  requiresManualCheckout: true,
                  error:
                    'Walmart order submission exceeded the safety deadline. Do not retry; verify the order history and cart manually.'
                }
              : {
                  success: false,
                  deadlineExpired: true,
                  error: 'Walmart queue checkout exceeded the 10-minute safety deadline'
                }
          )
        }, this._queueCheckoutTimeoutMs)
      })
      let result
      try {
        result = await Promise.race([checkout, deadline])
      } catch (error) {
        result = orderSubmissionAttempted
          ? {
              success: false,
              terminal: true,
              orderSubmissionAttempted: true,
              submissionUncertain: true,
              requiresManualCheckout: true,
              error:
                'Walmart checkout failed after order submission started. Do not retry; verify the order history and cart manually.',
              cause: error.message
            }
          : { success: false, error: error.message }
      }
      clearTimeout(timeout)
      if (result.deadlineExpired) {
        // Promise.race does not cancel the flow. The shared flag makes any later
        // onBeforeSubmit fail closed, while this observer prevents a detached
        // rejection after the page is stopped below.
        checkout.catch((error) => {
          log.info('Walmart queue checkout stopped after its safety deadline', {
            taskId: id,
            error: error.message
          })
        })
      }
      if (result.submissionUncertain) {
        this._holdAccountForManualReview(account, result.error)
      }
      if (/safety deadline/.test(result.error || '') && !result.submissionUncertain) {
        await this._queueJoiner?.stop(id)
        await Promise.resolve(this._pool.close(account.id)).catch(() => {})
      }
      this._checkoutTelemetry?.completeAttempt(attemptId, result)
      this._logHistory(dropEvent, result, account.id)
      this._dropEventLedger.complete(receipt.receiptId, {
        status: result.requiresManualCheckout
          ? 'manual_required'
          : result.success
            ? 'completed'
            : 'failed',
        detail: result.error || result.message
      })
      this._emitStatus(id, result.success ? 'idle' : 'error')
      const queueResultLabel = result.testMode
        ? 'TEST CHECKOUT READY'
        : result.submissionUncertain
          ? 'ORDER STATUS UNCERTAIN - MANUAL REVIEW'
          : result.success
            ? 'ORDER CONFIRMED'
            : 'ORDER FAILED'
      await this._notify.fire({
        ...dropEvent,
        productName: `${queueResultLabel} [${account.name}]: ${dropEvent.productName}`,
        dropType: result.success ? DROP_TYPES.IN_STOCK : DROP_TYPES.PRICE_DROP
      })
      await this._queueJoiner?.stop(id)
    } finally {
      this._activeAccountCheckoutRuns.delete(account.id)
    }
  }

  async _runFlowsForTask(task, dropEvent) {
    const flow = FLOWS[dropEvent.retailer]
    if (!flow) return { success: false, results: [] }
    const circuit = this._retailerCircuit.allow(dropEvent.retailer)
    if (!circuit.allowed) {
      log.warn('Retailer checkout circuit is temporarily open', {
        retailer: dropEvent.retailer,
        remainingMs: circuit.remainingMs,
        reason: circuit.reason
      })
      await this._notify.fire({
        ...dropEvent,
        productName: `CHECKOUT PAUSED (${dropEvent.retailer}): repeated ${circuit.reason || 'systemic'} failures; waiting for a fresh stock signal after cooldown`,
        dropType: 'price_drop'
      })
      return {
        success: false,
        circuitOpen: true,
        retryAfterMs: circuit.remainingMs,
        results: []
      }
    }

    const runKey = task.id || `${dropEvent.retailer}:${dropEvent.productUrl}`
    if (this._activeCheckoutRuns.has(runKey)) {
      log.info('Ignoring duplicate drop while checkout is already running', { runKey })
      return { success: false, duplicate: true, results: [] }
    }
    this._activeCheckoutRuns.add(runKey)

    try {
      const accountIds = parseAccountIds(task.account_ids)
      if (accountIds.length === 0) {
        const result = { success: false, error: 'No accounts selected for this task' }
        await this._notify.fire({
          ...dropEvent,
          productName: `ERROR: ${result.error}`,
          dropType: 'price_drop'
        })
        return { success: false, results: [result] }
      }

      const orderSubmissionGate =
        task.retailer === 'target'
          ? new OrderSubmissionGate(
              task.mode === 'test-checkout' ? accountIds.length : task.orders_per_drop
            )
          : null
      const settled = await Promise.allSettled(
        accountIds.map((accountId) =>
          this._runOrdersForAccount(flow, task, dropEvent, accountId, orderSubmissionGate)
        )
      )
      const results = settled.map((entry) =>
        entry.status === 'fulfilled'
          ? entry.value
          : { success: false, error: entry.reason?.message }
      )
      const success = results.some((result) => result.success)
      if (success) {
        this._retailerCircuit.recordSuccess(dropEvent.retailer)
      } else {
        for (const result of results) {
          this._retailerCircuit.recordFailure(
            dropEvent.retailer,
            result.error || result.message || ''
          )
        }
      }
      return { success, results }
    } finally {
      this._activeCheckoutRuns.delete(runKey)
    }
  }

  async _runOrdersForAccount(flow, task, dropEvent, accountId, orderSubmissionGate = null) {
    const account = this._accountManager.getDecrypted(accountId)
    if (account?.status === 'manual_review' || this._manualReviewAccounts.has(accountId)) {
      return {
        accountId,
        success: false,
        manualReviewRequired: true,
        requiresManualCheckout: true,
        error: 'Account is paused until the previous uncertain order is reviewed',
        ordersRequested: 0,
        ordersCompleted: 0,
        orderResults: []
      }
    }
    if (this._activeAccountCheckoutRuns.has(accountId)) {
      log.info('Skipping checkout because the account is already handling another product', {
        accountId,
        retailer: task.retailer,
        productUrl: dropEvent.productUrl
      })
      return {
        accountId,
        success: false,
        accountBusy: true,
        error: 'Account already has an active checkout for another product',
        ordersRequested: 0,
        ordersCompleted: 0,
        orderResults: []
      }
    }

    this._activeAccountCheckoutRuns.add(accountId)
    try {
      return await this._runOrdersForAccountUnlocked(
        flow,
        task,
        dropEvent,
        accountId,
        orderSubmissionGate
      )
    } finally {
      this._activeAccountCheckoutRuns.delete(accountId)
    }
  }

  async _runOrdersForAccountUnlocked(flow, task, dropEvent, accountId, orderSubmissionGate = null) {
    const ordersRequested =
      task.retailer === 'target' &&
      task.mode !== 'test-checkout' &&
      Number(task.orders_per_drop) === 2
        ? 2
        : 1
    const orderResults = []

    for (let orderNumber = 1; orderNumber <= ordersRequested; orderNumber += 1) {
      if (orderNumber > 1) {
        const account = this._accountManager.getDecrypted(accountId)
        if (account) {
          this._emitCheckoutStep(
            dropEvent,
            account,
            `Order 1 confirmed - starting separate order ${orderNumber} of ${ordersRequested}`
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 750))
      }

      const result = await this._runFlowForAccount(
        flow,
        { ...task, order_sequence: orderNumber, orders_per_drop: ordersRequested },
        dropEvent,
        accountId,
        orderSubmissionGate
      )
      orderResults.push(result)
      if (!result.success || result.testMode || result.requiresManualCheckout) break
    }

    const completed = orderResults.filter((result) => result.success && !result.testMode).length
    const lastResult = orderResults.at(-1) || { accountId, success: false }
    return {
      ...lastResult,
      success: completed > 0 || lastResult.success === true,
      ordersRequested,
      ordersCompleted: completed,
      orderResults
    }
  }

  async _runFlowForAccount(flow, task, dropEvent, accountId, orderSubmissionGate = null) {
    const account = this._accountManager.getDecrypted(accountId)
    if (!account) return { accountId, success: false, error: 'Account not found' }
    if (account.status === 'manual_review' || this._manualReviewAccounts.has(accountId)) {
      return {
        accountId,
        success: false,
        requiresManualCheckout: true,
        manualReviewRequired: true,
        error: 'Account is paused until the previous uncertain order is reviewed'
      }
    }
    const ownerId = `${task.id || dropEvent.productUrl}:${accountId}`
    const attemptId = this._checkoutTelemetry?.beginAttempt({ task, dropEvent, accountId })
    const lease = this.acquireAccountCheckout(accountId, {
      ownerId,
      taskId: task.id || null,
      productName: dropEvent.productName,
      mode: task.mode
    })
    if (!lease.acquired) {
      const result = {
        accountId,
        success: false,
        accountBusy: true,
        error: `Account is busy with ${lease.owner?.productName || 'another checkout'}`
      }
      this._checkoutTelemetry?.recordLease(attemptId, 'busy', {
        ownerId: lease.owner?.ownerId
      })
      this._checkoutTelemetry?.completeAttempt(attemptId, result)
      return result
    }
    const leaseAcquiredAt = this._accountCheckoutLeases.get(accountId)?.acquiredAt ?? Date.now()
    let leaseReleased = false
    const releaseLease = () => {
      if (leaseReleased) return false
      const currentLease = this._accountCheckoutLeases.get(accountId)
      if (!currentLease || currentLease.ownerId !== ownerId) return false
      this._checkoutTelemetry?.recordLease(attemptId, 'released', {
        ownerId,
        heldMs: Math.max(0, Date.now() - leaseAcquiredAt)
      })
      leaseReleased = this.releaseAccountCheckout(accountId, ownerId)
      return leaseReleased
    }
    this._checkoutTelemetry?.recordLease(attemptId, 'acquired', { ownerId })
    let preserveLease = false
    let ownsPin = false
    if (!this._pool.isPinned?.(accountId) && this._pool.pin) {
      try {
        await this._pool.pin(accountId, {
          profilePath: account.profile_path,
          proxy: account.proxy,
          retailer: task.retailer,
          priority: 100
        })
        ownsPin = true
      } catch (error) {
        const result = {
          accountId,
          success: false,
          error: `Could not reserve checkout browser: ${error.message}`
        }
        releaseLease()
        this._checkoutTelemetry?.completeAttempt(attemptId, result)
        return result
      }
    }
    let submissionStarted = false

    const retryManager = new RetryManager({
      maxRetries: 3,
      initialDelay: 2000,
      maxDelay: 10000
    })

    try {
      const result = await retryManager.retry(
        async (attempt) => {
          if (attempt > 1) {
            this._emitCheckoutStep(dropEvent, account, `Retry attempt ${attempt}/3`)
            this._checkoutTelemetry?.record(
              attemptId,
              'browser_launch',
              `Retry attempt ${attempt}/3`
            )
          }

          this._checkoutTelemetry?.record(
            attemptId,
            'browser_launch',
            `Launching browser attempt ${attempt}`
          )
          const context = await this._pool.launch(accountId, {
            profilePath: account.profile_path,
            proxy: account.proxy,
            retailer: task.retailer,
            priority: 100
          })
          context.once?.('close', () => {
            if (preserveLease) {
              this.releaseAccountCheckout(accountId, ownerId)
              if (ownsPin) {
                Promise.resolve(this._pool.unpin?.(accountId, { close: false })).catch(() => {})
              }
            }
          })
          this._checkoutTelemetry?.record(
            attemptId,
            'browser_launch',
            `milestone:Browser context ready for attempt ${attempt}`
          )

          try {
            const checkoutSettings = this._getSettings()
            const assignedPaymentMethodId = account.payment_method_id
            const assignedPayment = assignedPaymentMethodId
              ? this._paymentManager?.get(assignedPaymentMethodId)
              : null
            let flowResult = await flow(context, {
              productUrl: dropEvent.productUrl,
              payment: assignedPayment,
              cvv: assignedPayment?.cvv || account.cvv || '',
              cardNumber: assignedPayment?.cardNumber || null,
              cardLast4: assignedPayment?.cardNumber?.slice(-4) || null,
              account,
              notificationEngine: this._notify,
              dropEvent,
              mode: task.mode,
              buyLimit: task.buy_limit,
              maxPrice: task.max_price,
              requireRetailerSeller:
                task.retailer === 'walmart'
                  ? checkoutSettings.walmartRequireRetailerSeller !== false
                  : false,
              useTargetCartApi: checkoutSettings.targetCartApiEnabled === true,
              targetCheckoutLiteMode: checkoutSettings.targetCheckoutLiteMode === true,
              targetCommitNavigationEnabled:
                checkoutSettings.targetCommitNavigationEnabled === true,
              recordCheckoutTrace: checkoutSettings.recordCheckoutTraces === true,
              orderSubmissionGate,
              orderSubmissionKey: `${accountId}:${task.order_sequence || 1}`,
              onBeforeSubmit: () => {
                this._dropEventLedger.markSubmissionStarted(dropEvent.receiptId, {
                  accountId,
                  orderSequence: task.order_sequence || 1
                })
                submissionStarted = true
              },
              onStep: (message) => {
                this._emitCheckoutStep(dropEvent, account, message)
                this._checkoutTelemetry?.record(attemptId, message)
              },
              onMilestone: (stage, detail, metadata = {}) => {
                this._checkoutTelemetry?.record(attemptId, stage, `milestone:${detail}`, metadata)
              },
              browserPool: this._pool,
              accountId: accountId
            })
            if (
              submissionStarted &&
              !flowResult?.success &&
              !flowResult?.testMode &&
              !flowResult?.submissionUncertain
            ) {
              flowResult = {
                ...flowResult,
                success: false,
                terminal: true,
                orderSubmissionAttempted: true,
                submissionUncertain: true,
                requiresManualCheckout: true,
                error:
                  flowResult?.error ||
                  'Checkout ended after order submission started. Do not retry; verify order history manually.'
              }
            }
            if (isRetryableCheckoutResult(flowResult)) {
              throw new Error(flowResult.error || flowResult.message)
            }
            return flowResult
          } catch (err) {
            if (submissionStarted) {
              return {
                success: false,
                terminal: true,
                orderSubmissionAttempted: true,
                submissionUncertain: true,
                requiresManualCheckout: true,
                error:
                  'Checkout failed after order submission started. Do not retry; verify retailer order history manually.',
                cause: err.message
              }
            }
            await this._closeAccountContext(accountId)
            throw err
          }
        },
        {
          onRetry: ({ delay, error }) => {
            this._emitCheckoutStep(
              dropEvent,
              account,
              `Checkout failed (${error}), retrying in ${delay}ms...`
            )
          },
          shouldRetry: (err) => {
            return isRetryableCheckoutError(err.message, err.code)
          }
        }
      )
      const resultLabel = result.testMode
        ? 'TEST CHECKOUT READY'
        : result.submissionUncertain
          ? 'ORDER STATUS UNCERTAIN - MANUAL REVIEW'
          : result.success
            ? 'ORDER CONFIRMED'
            : 'ORDER FAILED'
      const orderLabel =
        task.orders_per_drop > 1 ? ` ${task.order_sequence || 1}/${task.orders_per_drop}` : ''
      if (result.tracePath) {
        this._emitCheckoutStep(dropEvent, account, `Trace saved: ${result.tracePath}`)
      }
      if (result.screenshotPath) {
        this._emitCheckoutStep(dropEvent, account, `Screenshot saved: ${result.screenshotPath}`)
      }
      if (result.diagnosticsPath) {
        this._emitCheckoutStep(dropEvent, account, `Diagnostics saved: ${result.diagnosticsPath}`)
      }
      if (result.submissionUncertain) {
        this._holdAccountForManualReview(account, result.error)
      }
      await this._notify.fire({
        ...dropEvent,
        productName: `${resultLabel}${orderLabel} [${account.name}]: ${dropEvent.productName}`,
        dropType: result.success ? 'in_stock' : 'price_drop'
      })
      this._logHistory(dropEvent, result, accountId)
      preserveLease = Boolean(result.testMode || result.requiresManualCheckout)
      if (!preserveLease) {
        await this._closeAccountContext(accountId)
        releaseLease()
      }
      this._checkoutTelemetry?.completeAttempt(attemptId, result)
      return { accountId, ...result }
    } catch (err) {
      await this._closeAccountContext(accountId)
      releaseLease()
      await this._notify.fire({
        ...dropEvent,
        productName: `ERROR [${account.name}]: ${err.message}`,
        dropType: 'price_drop'
      })
      this._logHistory(dropEvent, { success: false }, accountId)
      this._checkoutTelemetry?.completeAttempt(attemptId, {
        success: false,
        error: err.message
      })
      return { accountId, success: false, error: err.message }
    } finally {
      if (!preserveLease) releaseLease()
      if (ownsPin && !preserveLease) {
        await Promise.resolve(this._pool.unpin?.(accountId, { close: false })).catch(() => {})
      }
    }
  }

  _holdAccountForManualReview(account, reason) {
    if (!account?.id) return
    this._manualReviewAccounts.add(account.id)
    try {
      this._accountManager.setStatus?.(account.id, 'manual_review')
      this._getDb().flushNow?.()
    } catch (error) {
      log.error('Could not durably persist the account checkout hold', {
        accountId: account.id,
        error: error.message
      })
    }
    log.warn('Account paused after uncertain order submission', {
      accountId: account.id,
      retailer: account.retailer,
      reason: String(reason || 'unknown').slice(0, 200)
    })
  }

  _recoverUncertainAccountHolds() {
    try {
      const rows = this._getDb()
        .prepare('SELECT * FROM drop_event_receipts WHERE status = ?')
        .all('submission_started')
      let recovered = 0
      for (const row of rows) {
        const accountId = row.account_id || String(row.detail || '').match(/account=([^\s]+)/)?.[1]
        if (!accountId) continue
        this._manualReviewAccounts.add(accountId)
        this._accountManager.setStatus?.(accountId, 'manual_review')
        recovered += 1
      }
      if (recovered) {
        this._getDb().flushNow?.()
        log.warn('Recovered account holds from uncertain order submissions', { count: recovered })
      }
    } catch (error) {
      log.error('Could not recover uncertain-order account holds', { error: error.message })
    }
  }

  async _closeAccountContext(accountId) {
    if (this._queueJoiner?.isUsingAccount(accountId)) return
    if (this._pool.isPinned?.(accountId)) return
    await this._pool.close(accountId)
  }

  // Trip the retailer circuit from outside a checkout run (the keepalive). Uses the
  // same classifier as a real checkout failure, so a 403/429/challenge opens the
  // circuit and blocks checkouts for the cooldown instead of racing into the block.
  reportRetailerBlocked(retailer, reason) {
    if (!retailer) return null
    const outcome = this._retailerCircuit.trip(retailer, reason)
    log.error('Retailer reported blocked outside a checkout run; circuit opened', {
      retailer,
      reason
    })
    return outcome
  }

  _retainTaskAccounts(task) {
    if (!FLOWS[task.retailer] || task.mode === 'alert-only' || !this._pool?.pin) return
    const accountIds = parseAccountIds(task.account_ids)
    if (accountIds.length === 0) return

    this._warmAccountsByTask.set(task.id, accountIds)
    for (const accountId of accountIds) {
      const references = (this._warmAccountRefs.get(accountId) || 0) + 1
      this._warmAccountRefs.set(accountId, references)
      if (references > 1) continue

      const account = this._accountManager.getDecrypted(accountId)
      if (!account?.profile_path) continue

      // Pre-warm regardless of proxy. Proxied sessions need it most (slow connect plus
      // Shape cookie hydration), but a direct session still pays ~3.8s of browser launch
      // and ~1.7s of page load + sign-in verification at drop time, which is the bulk of
      // the gap between a drop firing and the add-to-cart click.

      const startedAt = Date.now()
      this._pool
        .pin(accountId, {
          profilePath: account.profile_path,
          proxy: account.proxy,
          retailer: task.retailer,
          priority: 10
        })
        .then(() => {
          log.info('Checkout browser pre-warmed', {
            accountId,
            retailer: task.retailer,
            elapsedMs: Date.now() - startedAt
          })
        })
        .catch((err) => {
          log.warn('Could not pre-warm checkout browser; drop will retry normally', {
            accountId,
            retailer: task.retailer,
            error: err.message
          })
        })
    }
  }

  _releaseTaskAccounts(taskId) {
    const accountIds = this._warmAccountsByTask.get(taskId) || []
    this._warmAccountsByTask.delete(taskId)
    for (const accountId of accountIds) {
      const references = Math.max(0, (this._warmAccountRefs.get(accountId) || 1) - 1)
      if (references > 0) {
        this._warmAccountRefs.set(accountId, references)
        continue
      }
      this._warmAccountRefs.delete(accountId)
      this._pool.unpin?.(accountId, { close: true }).catch(() => {})
    }
  }

  _logHistory(dropEvent, result, accountId) {
    try {
      this._getDb()
        .prepare(
          `
        INSERT INTO drop_history (id, retailer, product_name, product_url, drop_type, price, result, account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          randomUUID(),
          dropEvent.retailer,
          dropEvent.productName,
          dropEvent.productUrl,
          dropEvent.dropType,
          dropEvent.price,
          result.testMode ? 'test' : result.success ? 'win' : 'fail',
          accountId
        )
    } catch {
      // History is helpful but should not break checkout execution.
    }
  }

  _emitStatus(taskId, status) {
    this.emit('taskStatus', { taskId, status })
  }

  _emitCheckoutStep(dropEvent, account, message) {
    const event = {
      ...dropEvent,
      id: randomUUID(),
      timestamp: Date.now(),
      productName: `TEST [${account.name}]: ${message}`,
      dropType: 'checkout_step'
    }
    log.info('Checkout step', {
      retailer: dropEvent.retailer,
      account: account.name,
      productName: dropEvent.productName,
      message
    })
    this.emit('drop', event)
  }

  _getWalmartQueueAccount() {
    const accounts =
      this._accountManager.getAll?.().filter((entry) => entry.retailer === 'walmart') || []
    const account =
      accounts.find((entry) => entry.status === 'active') ||
      accounts.find((entry) => entry.status !== 'manual_review')
    return account ? this._accountManager.getDecrypted(account.id) : null
  }
}

function parseAccountIds(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function taskProductIdentity(taskRow) {
  return [
    taskRow?.retailer || 'unknown',
    extractProductKey(taskRow?.retailer, taskRow?.product_url) ||
      String(taskRow?.product_url || 'unknown')
        .trim()
        .toLowerCase()
  ].join(':')
}

function pendingUnsubscribeIdentity(taskRow, userId) {
  return `${userId || 'unbound'}:${taskProductIdentity(taskRow)}`
}

function buildMonitorIdentity(taskRow) {
  return {
    productUrl: taskRow?.product_url,
    retailer: taskRow?.retailer,
    productKey: taskRow?.product_key || extractProductKey(taskRow?.retailer, taskRow?.product_url)
  }
}

function walmartAutoQueueJobId(dropEvent) {
  const identity =
    dropEvent?.productId ||
    dropEvent?.productKey ||
    extractProductKey('walmart', dropEvent?.productUrl) ||
    String(dropEvent?.productUrl || 'unknown')
  return `${WALMART_AUTO_QUEUE_PREFIX}${identity}`
}

export function isRetryableCheckoutError(message = '', code = '') {
  const value = `${message || ''} ${code || ''}`.toLowerCase()
  return [
    'network',
    'timeout',
    'econnrefused',
    'econnreset',
    'etimedout',
    'target page, context or browser has been closed',
    'target fulfillment is still loading',
    'target availability did not settle',
    'target cart quantity could not be verified',
    "sam's club add to cart is not active yet",
    "sam's club cart does not contain requested item",
    "sam's club cart quantity could not be verified",
    "sam's club cart quantity did not update",
    "sam's club checkout button is disabled",
    "sam's club add to cart did not appear",
    "sam's club traffic gate did not clear",
    "sam's club cart was emptied before checkout",
    "sam's club checkout request failed temporarily",
    "sam's club checkout did not reach order review"
  ].some((keyword) => value.includes(keyword))
}

export function isRetryableCheckoutResult(result) {
  if (!result || result.success) return false
  if (
    result.requiresManualCheckout ||
    result.submissionUncertain ||
    result.orderSubmissionAttempted ||
    result.terminal
  ) {
    return false
  }
  return isRetryableCheckoutError(result.error || result.message, result.code)
}

function classifyDropReceiptResult(result) {
  const accountResults = Array.isArray(result?.results) ? result.results : []
  const manual = accountResults.find(
    (entry) => entry?.requiresManualCheckout || entry?.submissionUncertain
  )
  const failed = accountResults.find((entry) => entry?.error || entry?.message)
  if (manual) {
    return {
      status: 'manual_required',
      detail: manual.error || manual.message || 'Manual checkout review required'
    }
  }
  if (result?.success) return { status: 'completed', detail: null }
  return {
    status: 'failed',
    detail: result?.error || result?.message || failed?.error || failed?.message || null
  }
}
