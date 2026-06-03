import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { MonitorEngine } from '../monitor/MonitorEngine.js'
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
  constructor({ accountManager, notificationEngine, browserPool, getDb }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._getDb = getDb
    this._monitor = new MonitorEngine()
    this._monitor.on('drop', (event) => this._onDrop(event))
    this._tasks = new Map()
  }

  startTask(taskRow) {
    if (this._tasks.has(taskRow.id)) return
    const PollerClass = POLLERS[taskRow.retailer]
    if (!PollerClass) {
      this._emitStatus(taskRow.id, 'error')
      return
    }
    const poller = new PollerClass({ productUrl: taskRow.product_url, maxPrice: taskRow.max_price })
    this._tasks.set(taskRow.id, { ...taskRow, poller })
    this._monitor.addTask({ id: taskRow.id, poller, intervalMs: taskRow.interval_ms || 4000 })
    this._emitStatus(taskRow.id, 'monitoring')
  }

  stopTask(id) {
    this._monitor.removeTask(id)
    this._tasks.delete(id)
    this._emitStatus(id, 'idle')
  }

  stopAll() {
    for (const id of [...this._tasks.keys()]) this.stopTask(id)
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
    this.emit('drop', dropEvent)
    await this._notify.fire(dropEvent)

    const task = [...this._tasks.values()].find((t) => t.product_url === dropEvent.productUrl)
    if (!task) return

    const flow = FLOWS[dropEvent.retailer]
    if (!flow) return

    await this._runFlowsForTask(task, dropEvent)
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

    try {
      const context = await this._pool.launch(accountId, {
        profilePath: account.profile_path,
        proxy: account.proxy
      })
      const result = await flow(context, {
        productUrl: dropEvent.productUrl,
        cvv: account.cvv,
        account,
        notificationEngine: this._notify,
        dropEvent,
        mode: task.mode,
        buyLimit: task.buy_limit,
        onStep: (message) => this._emitCheckoutStep(dropEvent, account, message)
      })
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
