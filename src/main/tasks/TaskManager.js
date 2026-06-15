import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { MonitorEngine } from '../monitor/MonitorEngine.js'
import { MonitorBrowserContext } from '../monitor/MonitorBrowserContext.js'
import { runWalmartFlow } from '../automation/flows/walmart.js'
import { runTargetFlow } from '../automation/flows/target.js'
import { runPokemonCenterFlow } from '../automation/flows/pokemon-center.js'
import { runCostcoFlow } from '../automation/flows/costco.js'
import { WalmartPoller } from '../monitor/retailers/walmart.js'
import { TargetPoller } from '../monitor/retailers/target.js'
import { PokemonCenterPoller } from '../monitor/retailers/pokemon-center.js'
import { BestBuyPoller } from '../monitor/retailers/bestbuy.js'
import { CostcoPoller } from '../monitor/retailers/costco.js'
import { GameStopPoller } from '../monitor/retailers/gamestop.js'
import { SamsClubPoller } from '../monitor/retailers/samsclub.js'
import { RetryManager } from '../utils/retryManager.js'
import { extractProductKey } from '../products/productKey.js'
import { SupabaseClient } from '../supabase/SupabaseClient.js'
import { SupabaseMonitorSource } from '../monitor/SupabaseMonitorSource.js'
import { SUPABASE_URL, SUPABASE_KEY } from '../supabase/config.js'
import { decrypt } from '../crypto.js'

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
  costco: runCostcoFlow
}

export class TaskManager extends EventEmitter {
  constructor({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings = () => ({}),
    encryptionKey = null,
    createSupabaseSource = null
  }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._getDb = getDb
    this._getSettings = getSettings
    this._encryptionKey = encryptionKey
    this._monitor = new MonitorEngine()
    this._monitor.on('drop', (event) => this._onDrop(event))
    this._tasks = new Map()

    // One shared browser context per retailer — Guppy's exact approach:
    // one Chrome window (off-screen) with one tab per monitored product.
    // All tabs share the same Akamai cookies → trust accumulates faster.
    this._monitorContexts = new Map() // retailer → MonitorBrowserContext
    this._supabaseSource = null
    this._supabaseSourcePromise = null
    this._createSupabaseSource = createSupabaseSource || (() => this._buildSupabaseSource())
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
    const s = this._getSettings()
    const password = s.supabasePasswordEnc
      ? decrypt(s.supabasePasswordEnc, this._encryptionKey)
      : ''
    const sc = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY })
    await sc.signIn(s.supabaseEmail, password)
    return new SupabaseMonitorSource({ client: sc.client })
  }

  async _getSupabaseSource() {
    if (this._supabaseSource) return this._supabaseSource
    if (!this._supabaseSourcePromise) {
      this._supabaseSourcePromise = Promise.resolve(this._createSupabaseSource()).then((source) => {
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
    }
    return this._supabaseSourcePromise
  }

  startTask(taskRow) {
    if (this._tasks.has(taskRow.id)) return
    const mode = this._getSettings().monitorMode || 'local'

    if (mode === 'supabase') {
      this._tasks.set(taskRow.id, { ...taskRow, source: 'supabase' })
      this._emitStatus(taskRow.id, 'monitoring')
      this._startSupabaseTask(taskRow).catch((err) => {
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
    const monitorContext = taskRow.retailer === 'target' ? this._getMonitorContext('target') : null

    const poller = new PollerClass({
      productUrl: taskRow.product_url,
      maxPrice: taskRow.max_price,
      monitorContext,
      // browserPool is still passed as fallback for retailers that don't yet
      // use monitorContext, and for the TargetPoller legacy path.
      browserPool: this._pool
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
      maxPrice: taskRow.max_price ?? null
    })
  }

  stopTask(id) {
    const entry = this._tasks.get(id)
    if (entry?.source === 'supabase') {
      this._supabaseSource?.removeProduct(entry.product_url).catch(() => {})
    } else {
      this._monitor.removeTask(id)
    }
    this._tasks.delete(id)
    this._emitStatus(id, 'idle')
  }

  stopAll() {
    for (const id of [...this._tasks.keys()]) this.stopTask(id)
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

  async _runFlowsForTask(task, dropEvent) {
    const flow = FLOWS[dropEvent.retailer]
    if (!flow) return { success: false, results: [] }

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
      accountIds.map((accountId) => this._runFlowForAccount(flow, task, dropEvent, accountId))
    )
    const results = settled.map((entry) =>
      entry.status === 'fulfilled' ? entry.value : { success: false, error: entry.reason?.message }
    )
    return { success: results.some((result) => result.success), results }
  }

  async _runFlowForAccount(flow, task, dropEvent, accountId) {
    const account = this._accountManager.getDecrypted(accountId)
    if (!account) return { accountId, success: false, error: 'Account not found' }

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
          }

          const context = await this._pool.launch(accountId, {
            profilePath: account.profile_path,
            proxy: account.proxy
          })

          try {
            return await flow(context, {
              productUrl: dropEvent.productUrl,
              cvv: account.cvv,
              account,
              notificationEngine: this._notify,
              dropEvent,
              mode: task.mode,
              buyLimit: task.buy_limit,
              onStep: (message) => this._emitCheckoutStep(dropEvent, account, message)
            })
          } catch (err) {
            // Close context on error before retrying
            await this._pool.close(accountId)
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
            const retryableErrors = [
              'network',
              'timeout',
              'ECONNREFUSED',
              'ECONNRESET',
              'ETIMEDOUT',
              'Target page, context or browser has been closed'
            ]
            return retryableErrors.some(
              (keyword) =>
                err.message?.toLowerCase().includes(keyword.toLowerCase()) ||
                err.code?.includes(keyword)
            )
          }
        }
      )
      const resultLabel = result.testMode
        ? 'TEST CHECKOUT READY'
        : result.success
          ? 'ORDER CONFIRMED'
          : 'ORDER FAILED'
      if (result.tracePath) {
        this._emitCheckoutStep(dropEvent, account, `Trace saved: ${result.tracePath}`)
      }
      if (result.screenshotPath) {
        this._emitCheckoutStep(dropEvent, account, `Screenshot saved: ${result.screenshotPath}`)
      }
      await this._notify.fire({
        ...dropEvent,
        productName: `${resultLabel} [${account.name}]: ${dropEvent.productName}`,
        dropType: result.success ? 'in_stock' : 'price_drop'
      })
      this._logHistory(dropEvent, result, accountId)
      if (!result.requiresManualCheckout) {
        await this._pool.close(accountId)
      }
      return { accountId, ...result }
    } catch (err) {
      await this._pool.close(accountId)
      await this._notify.fire({
        ...dropEvent,
        productName: `ERROR [${account.name}]: ${err.message}`,
        dropType: 'price_drop'
      })
      this._logHistory(dropEvent, { success: false }, accountId)
      return { accountId, success: false, error: err.message }
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
    console.log(`[${dropEvent.retailer}-checkout] [${account.name}] ${message}`)
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
