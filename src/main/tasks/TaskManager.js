import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { MonitorEngine } from '../monitor/MonitorEngine.js'
import { MonitorBrowserContext } from '../monitor/MonitorBrowserContext.js'
import { runWalmartFlow } from '../automation/flows/walmart.js'
import { runTargetFlow } from '../automation/flows/target.js'
import { runPokemonCenterFlow } from '../automation/flows/pokemon-center.js'
import { runCostcoFlow } from '../automation/flows/costco.js'
import { runSamsClubFlow } from '../automation/flows/samsclub.js'
import { WalmartPoller } from '../monitor/retailers/walmart.js'
import { TargetPoller } from '../monitor/retailers/target.js'
import { PokemonCenterPoller } from '../monitor/retailers/pokemon-center.js'
import { BestBuyPoller } from '../monitor/retailers/bestbuy.js'
import { CostcoPoller } from '../monitor/retailers/costco.js'
import { GameStopPoller } from '../monitor/retailers/gamestop.js'
import { SamsClubPoller } from '../monitor/retailers/samsclub.js'
import { RetryManager } from '../utils/retryManager.js'
import { extractProductKey } from '../products/productKey.js'
import { SupabaseMonitorSource } from '../monitor/SupabaseMonitorSource.js'
import { DROP_TYPES } from '../../shared/constants.js'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('TaskManager')
const POKEMON_CENTER_AUTO_JOIN_ID = 'pokemon-center-auto-join'
const POKEMON_CENTER_QUEUE_URL = 'https://www.pokemoncenter.com/'
const POKEMON_CENTER_QUEUE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000

const POLLERS = {
  walmart: WalmartPoller,
  target: TargetPoller,
  'pokemon-center': PokemonCenterPoller,
  bestbuy: BestBuyPoller,
  costco: CostcoPoller,
  gamestop: GameStopPoller,
  samsclub: SamsClubPoller
}

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
    paymentManager = null
  }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._queueJoiner = queueJoiner
    this._pokemonCenterQueueJoiner = pokemonCenterQueueJoiner
    this._checkoutTelemetry = checkoutTelemetry
    this._paymentManager = paymentManager
    this._getDb = getDb
    this._getSettings = getSettings
    this._authSessionManager = authSessionManager
    this._monitor = new MonitorEngine()
    this._monitor.on('drop', (event) => this._onDrop(event))
    this._tasks = new Map()
    this._warmAccountsByTask = new Map()
    this._warmAccountRefs = new Map()
    this._activeCheckoutRuns = new Set()
    this._pokemonCenterAutoJoinEnabled = false
    this._pokemonCenterQueueAlertedAt = 0

    // One shared browser context per retailer — Guppy's exact approach:
    // one Chrome window (off-screen) with one tab per monitored product.
    // All tabs share the same Akamai cookies → trust accumulates faster.
    this._monitorContexts = new Map() // retailer → MonitorBrowserContext
    this._supabaseSource = null
    this._supabaseSourcePromise = null
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
  }

  _getMonitorContext(retailer) {
    if (!this._pool) return null
    if (!this._monitorContexts.has(retailer)) {
      this._monitorContexts.set(
        retailer,
        new MonitorBrowserContext({ browserPool: this._pool, retailer })
      )
    }
    return this._monitorContexts.get(retailer)
  }

  async _buildSupabaseSource() {
    if (!this._authSessionManager?.getStatus().authenticated) {
      throw new Error('Not signed in to Supabase yet')
    }
    return new SupabaseMonitorSource({ client: this._authSessionManager.getClient() })
  }

  async _getSupabaseSource() {
    if (this._supabaseSource) return this._supabaseSource
    if (!this._supabaseSourcePromise) {
      this._supabaseSourcePromise = Promise.resolve(this._createSupabaseSource())
        .then((source) => {
          source.on('drop', (event) => this._onDrop(event))
          source.on('notice', (notice) =>
            this.emit('drop', {
              retailer: 'catalog',
              productName: `ℹ️ ${notice.message}`,
              productUrl: notice.productUrl,
              dropType: 'supabase_notice'
            })
          )
          this._supabaseSource = source
          return source
        })
        .catch((error) => {
          // Do not cache a rejected connection forever. Authentication may finish
          // or the network may recover before the next attempt.
          this._supabaseSourcePromise = null
          throw error
        })
    }
    return this._supabaseSourcePromise
  }

  startTask(taskRow) {
    if (this._tasks.has(taskRow.id)) {
      // The renderer may have mounted after startup auto-resume emitted its first
      // status event. Re-emit the real state when Start is clicked instead of
      // silently returning and leaving the task looking stuck on idle.
      this._emitStatus(taskRow.id, 'monitoring')
      return
    }
    this._retainTaskAccounts(taskRow)
    const mode = this._getSettings().monitorMode || 'local'
    const productKey = extractProductKey(taskRow.retailer, taskRow.product_url)
    const isPokemonCenterQueueTask =
      taskRow.retailer === 'pokemon-center' && productKey === 'site-queue'
    const isCentralOnlyRetailer = taskRow.retailer === 'samsclub' || isPokemonCenterQueueTask
    const needsLocalRetailerPoller =
      taskRow.retailer === 'pokemon-center' && !isPokemonCenterQueueTask

    // Pokemon Center's site-wide queue and Sam's Club stock are detected
    // centrally by the Pi even when other retailers use local monitoring.
    // Checkout still runs locally in the signed-in account browser after a drop.
    if ((mode === 'supabase' && !needsLocalRetailerPoller) || isCentralOnlyRetailer) {
      this._tasks.set(taskRow.id, { ...taskRow, source: 'supabase' })
      this._emitStatus(taskRow.id, 'monitoring')
      this._startSupabaseTask(taskRow).catch((err) => {
        log.error('Failed to start Supabase monitor task', {
          taskId: taskRow.id,
          retailer: taskRow.retailer,
          productUrl: taskRow.product_url,
          error: err.message
        })
        this._emitStatus(taskRow.id, 'error')
        this.emit('drop', {
          retailer: taskRow.retailer,
          productName: `Supabase monitor error: ${err.message}`,
          productUrl: taskRow.product_url,
          dropType: 'supabase_notice'
        })
      })
      return
    }

    const PollerClass = POLLERS[taskRow.retailer]
    if (!PollerClass) {
      this._emitStatus(taskRow.id, 'error')
      return
    }

    // Target uses the shared MonitorBrowserContext (one window, one tab per product).
    // Other retailers fall back to browserPool (one context per product) until
    // they are updated to support monitorContext.
    const monitorContext = ['target', 'pokemon-center', 'samsclub'].includes(taskRow.retailer)
      ? this._getMonitorContext(taskRow.retailer)
      : null

    const settings = this._getSettings()
    const walmartMonitorMethod = settings.walmartMonitorMethod || 'axios'
    const poller = new PollerClass({
      productUrl: taskRow.product_url,
      maxPrice: taskRow.max_price,
      monitorContext,
      // browserPool is still passed as fallback for retailers that don't yet
      // use monitorContext, and for the TargetPoller legacy path.
      // Browser interception is much more expensive than Walmart's lightweight
      // HTTP check. Opt into it only for listings that reject the HTTP path.
      browserPool:
        taskRow.retailer === 'walmart' && walmartMonitorMethod !== 'browser' ? null : this._pool
    })

    this._tasks.set(taskRow.id, { ...taskRow, poller, source: 'local' })
    this._monitor.addTask({ id: taskRow.id, poller, intervalMs: taskRow.interval_ms || 4000 })
    this._emitStatus(taskRow.id, 'monitoring')
  }

  async _startSupabaseTask(taskRow) {
    const source = await this._getSupabaseSource()
    await source.addProduct({
      productUrl: taskRow.product_url,
      retailer: taskRow.retailer,
      productKey: extractProductKey(taskRow.retailer, taskRow.product_url),
      productName: taskRow.product_name || null,
      maxPrice: taskRow.max_price ?? null
    })
  }

  stopTask(id, { unsubscribe = true } = {}) {
    const entry = this._tasks.get(id)
    if (entry?.source === 'supabase') {
      if (unsubscribe) {
        // Explicit stop = this user stops watching: decrement the central
        // ref count so the Pi drops the product once nobody else watches it.
        this._supabaseSource
          ?.unsubscribe({
            productUrl: entry.product_url,
            retailer: entry.retailer,
            productKey: extractProductKey(entry.retailer, entry.product_url)
          })
          .catch(() => {})
      } else {
        // App shutdown: close the realtime channel but keep the subscription —
        // quitting the app is not "stop watching this product".
        this._supabaseSource?.releaseChannel(entry.product_url).catch(() => {})
      }
    } else {
      this._monitor.removeTask(id)
    }
    this._releaseTaskAccounts(id)
    this._tasks.delete(id)
    this._emitStatus(id, 'idle')
  }

  stopAll({ unsubscribe = true } = {}) {
    for (const id of [...this._tasks.keys()]) this.stopTask(id, { unsubscribe })
  }

  async shutdown() {
    // Keep central subscriptions, but await every local monitor context so no
    // managed browser survives after the Electron window closes.
    this.stopAll({ unsubscribe: false })
    const monitorContexts = [...this._monitorContexts.values()]
    this._monitorContexts.clear()
    await Promise.allSettled([
      ...monitorContexts.map((context) => context.closeAll()),
      this._supabaseSource?.stop?.()
    ])
    this._supabaseSource = null
    this._supabaseSourcePromise = null
  }

  // Remove this user's central subscription for a task regardless of whether it
  // is currently running — deleting a stopped task must still tell Supabase, or
  // the Pi keeps monitoring a product nobody is watching. No-op in local mode.
  async unsubscribeCentral(taskRow) {
    if (
      (this._getSettings().monitorMode || 'local') !== 'supabase' &&
      taskRow.retailer !== 'pokemon-center'
    )
      return
    const source = await this._getSupabaseSource()
    await source.unsubscribe({
      productUrl: taskRow.product_url,
      retailer: taskRow.retailer,
      productKey: extractProductKey(taskRow.retailer, taskRow.product_url)
    })
  }

  async setMonitorMode() {
    // Restart every active task under whatever monitorMode getSettings() now
    // returns. Caller persists the setting before invoking this.
    const activeIds = [...this._tasks.keys()]
    this.stopAll()
    if (this._supabaseSource) {
      await this._supabaseSource.stop().catch(() => {})
      this._supabaseSource = null
      this._supabaseSourcePromise = null
    }
    for (const id of activeIds) {
      const task = this._getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      if (task) this.startTask(task)
    }
  }

  async setPokemonCenterAutoJoin(enabled) {
    const next = enabled === true
    this._pokemonCenterAutoJoinEnabled = next
    if (!next) {
      await this._pokemonCenterQueueJoiner?.stop(POKEMON_CENTER_AUTO_JOIN_ID)
      await this._supabaseSource
        ?.unsubscribe({
          productUrl: POKEMON_CENTER_QUEUE_URL,
          retailer: 'pokemon-center',
          productKey: 'site-queue'
        })
        .catch(() => {})
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
      // Keep the durable armed state. AuthSessionManager's change listener retries
      // after sign-in, and the cleared source promise makes that retry possible.
      log.warn('Pokemon Center auto-join armed; connection will retry', {
        error: error.message
      })
      return { enabled: true, connected: false, reason: error.message }
    }
  }

  isPokemonCenterAutoJoinEnabled() {
    return this._pokemonCenterAutoJoinEnabled
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

  async _onDrop(dropEvent) {
    const task = [...this._tasks.values()].find((t) => t.product_url === dropEvent.productUrl)

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
      return
    }

    // All other modes: emit the raw drop event and fire the notification.
    this.emit('drop', dropEvent)
    await this._notify.fire(dropEvent)

    if (!task) return

    const flow = FLOWS[dropEvent.retailer]
    if (!flow) return

    // For test-checkout mode, ensure mode is passed through
    if (task.mode === 'test-checkout') {
      await this._runFlowsForTask({ ...task, mode: 'test-checkout' }, dropEvent)
    } else {
      // auto-checkout / monitor-and-buy mode
      await this._runFlowsForTask(task, dropEvent)
    }
  }

  async _onQueueTurn({ id, label, status, context }) {
    const task =
      this._tasks.get(id) || this._getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!task || !context || task.retailer !== 'walmart') return
    if (!['auto-checkout', 'test-checkout'].includes(task.mode)) return

    const accountIds = parseAccountIds(task.account_ids)
    const account = accountIds.length ? this._accountManager.getDecrypted(accountIds[0]) : null
    if (!account) return

    const dropEvent = {
      retailer: 'walmart',
      productName: status?.itemName || task.product_name || label || 'Walmart product',
      productUrl: task.product_url,
      dropType: DROP_TYPES.IN_STOCK,
      price: status?.price || task.max_price || null
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
    const result = await runWalmartFlow(context, {
      productUrl: dropEvent.productUrl,
      cvv: account.cvv,
      account,
      notificationEngine: this._notify,
      dropEvent,
      mode: task.mode,
      buyLimit: task.buy_limit,
      onStep: (message) => {
        this._emitCheckoutStep(dropEvent, account, message)
        this._checkoutTelemetry?.record(attemptId, message)
      }
    })
    this._checkoutTelemetry?.completeAttempt(attemptId, result)
    this._logHistory(dropEvent, result, account.id)
    this._emitStatus(id, result.success ? 'idle' : 'error')
    await this._notify.fire({
      ...dropEvent,
      productName: `${result.testMode ? 'TEST CHECKOUT READY' : result.success ? 'ORDER CONFIRMED' : 'ORDER FAILED'} [${account.name}]: ${dropEvent.productName}`,
      dropType: result.success ? DROP_TYPES.IN_STOCK : DROP_TYPES.PRICE_DROP
    })
    await this._queueJoiner?.stop(id)
  }

  async _runFlowsForTask(task, dropEvent) {
    const flow = FLOWS[dropEvent.retailer]
    if (!flow) return { success: false, results: [] }

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

      const settled = await Promise.allSettled(
        accountIds.map((accountId) => this._runOrdersForAccount(flow, task, dropEvent, accountId))
      )
      const results = settled.map((entry) =>
        entry.status === 'fulfilled'
          ? entry.value
          : { success: false, error: entry.reason?.message }
      )
      return { success: results.some((result) => result.success), results }
    } finally {
      this._activeCheckoutRuns.delete(runKey)
    }
  }

  async _runOrdersForAccount(flow, task, dropEvent, accountId) {
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
        accountId
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

  async _runFlowForAccount(flow, task, dropEvent, accountId) {
    const account = this._accountManager.getDecrypted(accountId)
    if (!account) return { accountId, success: false, error: 'Account not found' }
    const attemptId = this._checkoutTelemetry?.beginAttempt({ task, dropEvent, accountId })

    // Create retry manager for this checkout
    const retryManager = new RetryManager({
      maxRetries: 3,
      initialDelay: 2000,
      maxDelay: 10000
    })

    try {
      // Wrap the entire checkout flow in retry logic
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
            proxy: account.proxy
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
            const flowResult = await flow(context, {
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
              useTargetCartApi: checkoutSettings.targetCartApiEnabled === true,
              targetCheckoutLiteMode: checkoutSettings.targetCheckoutLiteMode === true,
              onStep: (message) => {
                this._emitCheckoutStep(dropEvent, account, message)
                this._checkoutTelemetry?.record(attemptId, message)
              },
              onMilestone: (stage, detail) => {
                this._checkoutTelemetry?.record(attemptId, stage, `milestone:${detail}`)
              }
            })
            if (
              !flowResult?.success &&
              !flowResult?.requiresManualCheckout &&
              isRetryableCheckoutError(flowResult?.error || flowResult?.message)
            ) {
              throw new Error(flowResult.error || flowResult.message)
            }
            return flowResult
          } catch (err) {
            // Close context on error before retrying
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
            // Retry on network errors and timeouts, but not on validation errors
            return isRetryableCheckoutError(err.message, err.code)
          }
        }
      )
      const resultLabel = result.testMode
        ? 'TEST CHECKOUT READY'
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
      await this._notify.fire({
        ...dropEvent,
        productName: `${resultLabel}${orderLabel} [${account.name}]: ${dropEvent.productName}`,
        dropType: result.success ? 'in_stock' : 'price_drop'
      })
      this._logHistory(dropEvent, result, accountId)
      this._checkoutTelemetry?.completeAttempt(attemptId, result)
      if (!result.requiresManualCheckout) {
        await this._closeAccountContext(accountId)
      }
      return { accountId, ...result }
    } catch (err) {
      await this._closeAccountContext(accountId)
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
    }
  }

  // Queue pages ride the same persistent account context. Never tear that
  // context down from a checkout retry/error while a queue is still active.
  async _closeAccountContext(accountId) {
    if (this._queueJoiner?.isUsingAccount(accountId)) return
    if (this._pool.isPinned?.(accountId)) return
    await this._pool.close(accountId)
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
      const startedAt = Date.now()
      this._pool
        .pin(accountId, { profilePath: account.profile_path, proxy: account.proxy })
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
}

function parseAccountIds(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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
    'target security challenge did not clear',
    "sam's club add to cart is not active yet",
    "sam's club cart does not contain requested item",
    "sam's club cart quantity could not be verified",
    "sam's club cart quantity did not update",
    "sam's club checkout button is disabled",
    "sam's club add to cart did not appear",
    "sam's club traffic gate did not clear",
    "sam's club cart was emptied before checkout",
    "sam's club checkout request failed temporarily",
    "sam's club checkout did not reach order review",
    'http 403'
  ].some((keyword) => value.includes(keyword))
}
