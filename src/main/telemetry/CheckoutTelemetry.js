import { createHash, randomUUID } from 'crypto'
import { extractProductKey } from '../products/productKey.js'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('CheckoutTelemetry')
const DEVICE_SETTING = 'checkoutTelemetryDeviceId'
const ACTUAL_CART_STRATEGIES = new Set([
  'api',
  'api_attempted',
  'browser',
  'browser_fallback',
  'existing_cart',
  'not_reached'
])
const CART_FALLBACK_REASONS = new Set([
  'api_cooldown',
  'api_error',
  'api_rate_limited',
  'api_rate_limited_cart_present',
  'missing_product_id',
  'purchase_limit_cart_present',
  'purchase_limit_item_missing'
])

export const CHECKOUT_STAGES = [
  'drop_detected',
  'browser_launch',
  'product_opened',
  'session_checked',
  'availability_ready',
  'cart_attempted',
  'cart_ready',
  'queue_waiting',
  'checkout_opened',
  'checkout_ready',
  'order_submitted',
  'confirmed',
  'manual_required',
  'failed'
]

export class CheckoutTelemetry {
  constructor({
    getDb,
    authSessionManager = null,
    getSettings = () => ({}),
    appVersion = 'unknown'
  }) {
    this._getDb = getDb
    this._auth = authSessionManager
    this._getSettings = getSettings
    this._appVersion = appVersion
    this._active = new Map()
    this._recoverTerminalAttempts()
  }

  beginAttempt({ task, dropEvent, accountId }) {
    const db = this._getDb()
    const id = randomUUID()
    const startedAt = Date.now()
    const deviceId = this._getDeviceId(db)
    const userId = this._auth?.getStatus?.().user?.id || null
    const settings = this._getSettings()
    const experiment = buildExperimentProfile({ task, settings, appVersion: this._appVersion })
    const productKey = safeProductKey(dropEvent?.retailer, dropEvent?.productUrl)
    const accountRef = hashRef(`${deviceId}:${accountId || 'unknown'}`)

    db.prepare(
      `
      INSERT INTO checkout_attempts
        (id, user_id, device_ref, task_id, retailer, product_key, product_name, mode,
         experiment_json, account_ref, started_at, outcome, final_stage, upload_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'drop_detected', 'pending')
    `
    ).run(
      id,
      userId,
      hashRef(deviceId),
      task?.id || null,
      dropEvent?.retailer || task?.retailer || 'unknown',
      productKey,
      sanitizeDetail(dropEvent?.productName, 140),
      task?.mode || 'auto-checkout',
      JSON.stringify(experiment),
      accountRef,
      startedAt
    )

    this._active.set(id, { startedAt, sequence: 0, lastStage: 'drop_detected' })
    this.record(id, 'drop_detected', `milestone:${dropEvent?.dropType || 'in_stock'}`)
    return id
  }

  record(attemptId, stageOrMessage, detail = null) {
    const active = this._active.get(attemptId)
    if (!active) return
    const stage = CHECKOUT_STAGES.includes(stageOrMessage)
      ? stageOrMessage
      : classifyCheckoutStage(stageOrMessage)
    const message = detail == null && stageOrMessage !== stage ? stageOrMessage : detail
    const now = Date.now()
    const sequence = ++active.sequence
    const currentRank = CHECKOUT_STAGES.indexOf(active.lastStage)
    const nextRank = CHECKOUT_STAGES.indexOf(stage)
    if (!['confirmed', 'manual_required', 'failed'].includes(stage) && nextRank >= currentRank) {
      active.lastStage = stage
    }

    this._getDb()
      .prepare(
        `
      INSERT INTO checkout_attempt_events
        (id, attempt_id, sequence, stage, detail, elapsed_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        randomUUID(),
        attemptId,
        sequence,
        stage,
        sanitizeDetail(message),
        Math.max(0, now - active.startedAt),
        now
      )
  }

  completeAttempt(attemptId, result = {}) {
    const active = this._active.get(attemptId)
    if (!active) return
    const db = this._getDb()
    const completedAt = Date.now()
    const outcome = result.testMode
      ? 'test_ready'
      : result.success
        ? 'confirmed'
        : result.requiresManualCheckout
          ? 'manual_required'
          : 'failed'
    const finalStage =
      outcome === 'confirmed'
        ? 'confirmed'
        : outcome === 'manual_required' || outcome === 'test_ready'
          ? 'manual_required'
          : 'failed'
    const failure =
      outcome === 'failed' || outcome === 'manual_required'
        ? classifyCheckoutFailure(result.error || result.message, active.lastStage)
        : { code: null, stage: null }
    const existingAttempt = db
      .prepare('SELECT experiment_json FROM checkout_attempts WHERE id = ?')
      .get(attemptId)
    const experiment = applyActualCartExecution(parseJson(existingAttempt?.experiment_json), result)

    this.record(attemptId, finalStage, result.error || result.message || outcome)
    db.prepare(
      `
      UPDATE checkout_attempts
      SET completed_at = ?, duration_ms = ?, outcome = ?, final_stage = ?, failure_stage = ?,
          failure_code = ?, error_summary = ?, event_count = ?, experiment_json = ?,
          upload_status = 'pending'
      WHERE id = ?
    `
    ).run(
      completedAt,
      Math.max(0, completedAt - active.startedAt),
      outcome,
      finalStage,
      failure.stage,
      failure.code,
      sanitizeDetail(result.error || result.message),
      active.sequence,
      JSON.stringify(experiment),
      attemptId
    )
    this._active.delete(attemptId)
    this.uploadAttempt(attemptId).catch((error) => {
      log.warn('Checkout telemetry upload deferred', { attemptId, error: error.message })
    })
  }

  async flushPending({ limit = 25 } = {}) {
    if (!this._auth?.getStatus?.().authenticated) return { uploaded: 0 }
    const rows = this._getDb()
      .prepare(
        "SELECT * FROM checkout_attempts WHERE upload_status = 'pending' AND completed_at IS NOT NULL ORDER BY completed_at LIMIT ?"
      )
      .all(limit)
    let uploaded = 0
    for (const row of rows) {
      if (
        await this.uploadAttempt(row.id)
          .then(() => true)
          .catch(() => false)
      )
        uploaded += 1
    }
    return { uploaded }
  }

  async uploadAttempt(attemptId) {
    if (!this._auth?.getStatus?.().authenticated) return false
    const client = this._auth.getClient()
    const userId = this._auth.getStatus().user?.id
    if (!client || !userId) return false

    const db = this._getDb()
    const attempt = db.prepare('SELECT * FROM checkout_attempts WHERE id = ?').get(attemptId)
    if (!attempt?.completed_at) return false
    const events = db
      .prepare('SELECT * FROM checkout_attempt_events WHERE attempt_id = ? ORDER BY sequence')
      .all(attemptId)

    const attemptPayload = {
      id: attempt.id,
      user_id: userId,
      device_ref: attempt.device_ref,
      task_ref: hashRef(attempt.task_id || attempt.id),
      retailer: attempt.retailer,
      product_key: attempt.product_key,
      product_name: attempt.product_name,
      mode: attempt.mode,
      experiment: parseJson(attempt.experiment_json),
      account_ref: attempt.account_ref,
      started_at: new Date(attempt.started_at).toISOString(),
      completed_at: new Date(attempt.completed_at).toISOString(),
      duration_ms: attempt.duration_ms,
      outcome: attempt.outcome,
      final_stage: attempt.final_stage,
      failure_stage: attempt.failure_stage,
      failure_code: attempt.failure_code,
      error_summary: attempt.error_summary,
      event_count: attempt.event_count
    }
    const { error: attemptError } = await client
      .from('checkout_attempts')
      .upsert(attemptPayload, { onConflict: 'id' })
    if (attemptError) throw attemptError

    if (events.length) {
      const eventPayload = events.map((event) => ({
        id: event.id,
        attempt_id: attempt.id,
        user_id: userId,
        sequence: event.sequence,
        stage: event.stage,
        detail: event.detail,
        elapsed_ms: event.elapsed_ms,
        created_at: new Date(event.created_at).toISOString()
      }))
      const { error: eventError } = await client
        .from('checkout_attempt_events')
        .upsert(eventPayload, { onConflict: 'id' })
      if (eventError) throw eventError
    }

    db.prepare(
      "UPDATE checkout_attempts SET user_id = ?, upload_status = 'uploaded', uploaded_at = ? WHERE id = ?"
    ).run(userId, Date.now(), attempt.id)
    return true
  }

  _recoverTerminalAttempts() {
    try {
      const db = this._getDb()
      const incomplete = db
        .prepare('SELECT * FROM checkout_attempts')
        .all()
        .filter((attempt) => !attempt.completed_at)
      let recovered = 0

      for (const attempt of incomplete) {
        const events = db
          .prepare('SELECT * FROM checkout_attempt_events WHERE attempt_id = ? ORDER BY sequence')
          .all(attempt.id)
        const terminal = [...events]
          .reverse()
          .find((event) => ['confirmed', 'manual_required', 'failed'].includes(event.stage))
        if (!terminal) continue

        const priorStage = [...events]
          .reverse()
          .find((event) => !['confirmed', 'manual_required', 'failed'].includes(event.stage))?.stage
        const outcome = terminal.stage === 'confirmed' ? 'confirmed' : terminal.stage
        const failure =
          outcome === 'failed' || outcome === 'manual_required'
            ? classifyCheckoutFailure(terminal.detail, priorStage || terminal.stage)
            : { code: null, stage: null }
        const completedAt = Number(terminal.created_at) || Number(attempt.started_at) || Date.now()
        const startedAt = Number(attempt.started_at) || completedAt

        db.prepare(
          `
          UPDATE checkout_attempts
          SET completed_at = ?, duration_ms = ?, outcome = ?, final_stage = ?, failure_stage = ?,
              failure_code = ?, error_summary = ?, event_count = ?, upload_status = 'pending'
          WHERE id = ?
        `
        ).run(
          completedAt,
          Math.max(0, completedAt - startedAt),
          outcome,
          terminal.stage,
          failure.stage,
          failure.code,
          sanitizeDetail(terminal.detail),
          events.length,
          attempt.id
        )
        recovered += 1
      }

      if (recovered) log.info('Recovered completed checkout telemetry', { count: recovered })
    } catch (error) {
      log.warn('Could not recover checkout telemetry', { error: error.message })
    }
  }

  _getDeviceId(db) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_SETTING)
    if (row?.value) {
      try {
        return JSON.parse(row.value)
      } catch {
        /* replace malformed value */
      }
    }
    const value = randomUUID()
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      DEVICE_SETTING,
      JSON.stringify(value)
    )
    return value
  }
}

export function buildExperimentProfile({ task, settings = {}, appVersion = 'unknown' }) {
  const retailer = task?.retailer || 'unknown'
  return {
    cart_strategy:
      retailer === 'target' && settings.targetCartApiEnabled === true ? 'api_preferred' : 'browser',
    lite_mode: retailer === 'target' && settings.targetCheckoutLiteMode === true,
    browser_profile: 'persistent',
    monitor_source: settings.monitorMode || 'local',
    app_version: String(appVersion || 'unknown').slice(0, 32),
    order_sequence: Math.max(1, Number(task?.order_sequence) || 1),
    orders_per_drop: Math.max(1, Number(task?.orders_per_drop) || 1)
  }
}

export function applyActualCartExecution(experiment = {}, result = {}) {
  const next = { ...experiment }
  const actual = String(result?.cartStrategyActual || '')
  if (!ACTUAL_CART_STRATEGIES.has(actual)) return next

  next.cart_strategy_actual = actual
  const reason = String(result?.cartFallbackReason || '')
  if (CART_FALLBACK_REASONS.has(reason)) next.cart_fallback_reason = reason
  else delete next.cart_fallback_reason
  const requestedQuantity = Number(result?.cartQuantityRequested)
  const actualQuantity = Number(result?.cartQuantityActual)
  if (Number.isInteger(requestedQuantity) && requestedQuantity > 0) {
    next.cart_quantity_requested = requestedQuantity
  }
  if (Number.isInteger(actualQuantity) && actualQuantity > 0) {
    next.cart_quantity_actual = actualQuantity
  }
  return next
}

export function classifyCheckoutStage(message = '') {
  const value = String(message).toLowerCase()
  if (/confirmed|order placed|thank/.test(value)) return 'confirmed'
  if (/place your order|place order|submitt|order confirmation/.test(value))
    return 'order_submitted'
  if (/order review|cvv|payment/.test(value)) return 'checkout_ready'
  if (/opening .*checkout|checkout page/.test(value)) return 'checkout_opened'
  if (/queue|waitlist|waiting room|in line/.test(value)) return 'queue_waiting'
  if (/added to cart|cart to update|cart contains/.test(value)) return 'cart_ready'
  if (/add.*cart|cart api|purchase limit/.test(value)) return 'cart_attempted'
  if (/signed in|sign-in|sign in|session/.test(value)) return 'session_checked'
  if (/fulfillment|availability|still loading/.test(value)) return 'product_opened'
  if (/product page|opening product/.test(value)) return 'product_opened'
  if (/browser|context/.test(value)) return 'browser_launch'
  if (/manual|test mode/.test(value)) return 'manual_required'
  if (/error|failed|timeout|closed/.test(value)) return 'failed'
  return 'browser_launch'
}

export function classifyCheckoutFailure(message = '', lastStage = 'failed') {
  const value = String(message || '').toLowerCase()
  let code = 'unknown'
  if (/captcha|challenge/.test(value)) code = 'challenge'
  else if (/not signed|logged out|login|sign-in/.test(value)) code = 'session'
  else if (/out of stock|unavailable|sold out|empty cart/.test(value)) code = 'inventory'
  else if (/fulfillment|availability did not settle|still loading/.test(value))
    code = 'availability'
  else if (/high.?demand|busy|rate limit|429/.test(value)) code = 'high_demand'
  else if (/payment|cvv|card|billing/.test(value)) code = 'payment'
  else if (/timeout|timed out/.test(value)) code = 'timeout'
  else if (/network|econn|socket|fetch/.test(value)) code = 'network'
  else if (/closed|destroyed|detached/.test(value)) code = 'browser_closed'
  return { code, stage: CHECKOUT_STAGES.includes(lastStage) ? lastStage : 'failed' }
}

export function sanitizeDetail(value, maxLength = 180) {
  if (value == null) return null
  return (
    String(value)
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[A-Z]:\\[^\s]+/gi, '[path]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/\b\d{8,}\b/g, '[number]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength) || null
  )
}

function safeProductKey(retailer, productUrl) {
  try {
    const key = extractProductKey(retailer, productUrl)
    return key
      ? String(key)
          .replace(/[^a-z0-9_.:-]/gi, '')
          .slice(0, 100) || null
      : null
  } catch {
    return null
  }
}

function hashRef(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}
