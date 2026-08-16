import { createHash, randomUUID } from 'crypto'
import { basename } from 'path'
import { extractProductKey } from '../products/productKey.js'
import { createModuleLogger } from '../utils/logger.js'
import {
  parseCheckoutEventMetadata,
  sanitizeCheckoutEventMetadata
} from './CheckoutEventMetadata.js'

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
const ANALYTICS_EXPERIMENT_KEYS = [
  'cart_strategy',
  'cart_strategy_actual',
  'lite_mode',
  'commit_navigation',
  'monitor_source',
  'app_version'
]
const LOCAL_ARTIFACT_KEY = '_local_artifacts'
const MAX_BUFFERED_EVENTS = 2000
const ARTIFACT_FIELDS = [
  ['trace', 'tracePath'],
  ['screenshot', 'screenshotPath'],
  ['diagnostics', 'diagnosticsPath']
]

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
    this._eventBuffer = []
    this._didWarnAboutDroppedEvents = false
    this._recoverTerminalAttempts()
  }

  beginAttempt(input) {
    try {
      return this._beginAttempt(input)
    } catch (error) {
      log.warn('Could not begin checkout telemetry', { error: error.message })
      return null
    }
  }

  _beginAttempt({ task, dropEvent, accountId }) {
    const db = this._getDb()
    const id = randomUUID()
    const startedAt = Date.now()
    const deviceId = this._getDeviceId(db)
    const userId = this._auth?.getStatus?.().user?.id || null
    const settings = this._getSettings()
    const experiment = buildExperimentProfile({ task, settings, appVersion: this._appVersion })
    const observedAt = Date.parse(dropEvent?.observedAt)
    if (Number.isFinite(observedAt)) {
      experiment.monitor_latency_ms = Math.max(0, startedAt - observedAt)
    }
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

  record(attemptId, stageOrMessage, detail = null, metadata = {}) {
    try {
      return this._record(attemptId, stageOrMessage, detail, metadata)
    } catch (error) {
      log.warn('Could not record checkout telemetry', { error: error.message })
      return false
    }
  }

  _record(attemptId, stageOrMessage, detail = null, metadata = {}) {
    const active = this._active.get(attemptId)
    if (!active) return false
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

    if (this._eventBuffer.length >= MAX_BUFFERED_EVENTS && !this._flushEventBuffer()) {
      this._eventBuffer.shift()
      if (!this._didWarnAboutDroppedEvents) {
        this._didWarnAboutDroppedEvents = true
        log.warn('Checkout telemetry event buffer reached its safety limit')
      }
    }
    this._eventBuffer.push({
      id: randomUUID(),
      attemptId,
      sequence,
      stage,
      detail: sanitizeDetail(message),
      metadataJson: serializeCheckoutEventMetadata(metadata),
      elapsedMs: Math.max(0, now - active.startedAt),
      createdAt: now
    })
    return true
  }

  recordLease(attemptId, leaseState, { ownerId, heldMs = null } = {}) {
    return this.record(attemptId, 'drop_detected', `Account lease ${leaseState}`, {
      eventType: 'account_lease',
      leaseState,
      ...(ownerId == null || ownerId === '' ? {} : { ownerRef: hashRef(ownerId) }),
      heldMs
    })
  }

  completeAttempt(attemptId, result = {}) {
    try {
      return this._completeAttempt(attemptId, result)
    } catch (error) {
      log.warn('Could not complete checkout telemetry', { error: error.message })
      return false
    }
  }

  _completeAttempt(attemptId, result = {}) {
    const active = this._active.get(attemptId)
    if (!active) return false
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
    const experiment = applyLocalArtifacts(
      applyActualCartExecution(parseJson(existingAttempt?.experiment_json), result),
      result
    )

    this.record(attemptId, finalStage, result.error || result.message || outcome)
    this._flushEventBuffer(attemptId)
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
    return true
  }

  getAnalytics(filters = {}) {
    this._flushEventBuffer()
    const db = this._getDb()
    const attempts = db.prepare('SELECT * FROM checkout_attempts').all()
    const events = db.prepare('SELECT * FROM checkout_attempt_events').all()
    return buildCheckoutAnalyticsReport(attempts, events, filters)
  }

  async flushPending({ limit = 25 } = {}) {
    if (!this._isUploadEnabled()) return { uploaded: 0, optedOut: true }
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
    if (!this._isUploadEnabled()) return false
    if (!this._auth?.getStatus?.().authenticated) return false
    const client = this._auth.getClient()
    const userId = this._auth.getStatus().user?.id
    if (!client || !userId) return false

    if (!this._flushEventBuffer(attemptId)) return false
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
      experiment: toRemoteExperiment(parseJson(attempt.experiment_json)),
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
        let terminal = [...events]
          .reverse()
          .find((event) => ['confirmed', 'manual_required', 'failed'].includes(event.stage))
        if (!terminal) {
          const lastEvent = events.at(-1)
          const submitted =
            lastEvent?.stage === 'order_submitted' || attempt.final_stage === 'order_submitted'
          terminal = {
            stage: submitted ? 'manual_required' : 'failed',
            detail: submitted
              ? 'App closed after order submission; verify retailer order history before retrying'
              : 'App closed before checkout completed',
            created_at: lastEvent?.created_at || Date.now(),
            recoveryCode: submitted ? 'submission_uncertain' : 'app_interrupted'
          }
        }

        const priorStage = [...events]
          .reverse()
          .find((event) => !['confirmed', 'manual_required', 'failed'].includes(event.stage))?.stage
        const outcome = terminal.stage === 'confirmed' ? 'confirmed' : terminal.stage
        const failure =
          outcome === 'failed' || outcome === 'manual_required'
            ? terminal.recoveryCode
              ? {
                  code: terminal.recoveryCode,
                  stage: priorStage || attempt.final_stage || terminal.stage
                }
              : classifyCheckoutFailure(terminal.detail, priorStage || terminal.stage)
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

  _isUploadEnabled() {
    return this._getSettings().checkoutTelemetryEnabled !== false
  }

  flushLocal() {
    return this._flushEventBuffer()
  }

  _flushEventBuffer(attemptId = null) {
    if (!this._eventBuffer.length) return true
    const selected = attemptId
      ? this._eventBuffer.filter((event) => event.attemptId === attemptId)
      : this._eventBuffer.slice()
    if (!selected.length) return true
    const selectedIds = new Set(selected.map((event) => event.id))
    this._eventBuffer = this._eventBuffer.filter((event) => !selectedIds.has(event.id))

    try {
      const db = this._getDb()
      const insert = db.prepare(
        `INSERT INTO checkout_attempt_events
          (id, attempt_id, sequence, stage, detail, elapsed_ms, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const writeRows = () => {
        for (const event of selected) {
          insert.run(
            event.id,
            event.attemptId,
            event.sequence,
            event.stage,
            event.detail,
            event.elapsedMs,
            event.createdAt,
            event.metadataJson
          )
        }
      }
      if (typeof db.transaction === 'function') db.transaction(writeRows)()
      else writeRows()
      this._didWarnAboutDroppedEvents = false
      return true
    } catch (error) {
      this._eventBuffer = [...selected, ...this._eventBuffer].slice(-MAX_BUFFERED_EVENTS)
      log.warn('Could not flush checkout telemetry events', { error: error.message })
      return false
    }
  }
}

export function buildExperimentProfile({ task, settings = {}, appVersion = 'unknown' }) {
  const retailer = task?.retailer || 'unknown'
  return {
    cart_strategy:
      retailer === 'target' && settings.targetCartApiEnabled === true ? 'api_preferred' : 'browser',
    lite_mode: retailer === 'target' && settings.targetCheckoutLiteMode === true,
    commit_navigation: retailer === 'target' && settings.targetCommitNavigationEnabled === true,
    browser_profile: 'persistent',
    monitor_source: 'supabase',
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

export function buildCheckoutAnalyticsReport(attemptRows = [], eventRows = [], filters = {}) {
  const limit = clampInteger(filters.limit, 1, 500, 100)
  const days = filters.days == null ? null : clampInteger(filters.days, 1, 3650, 30)
  const retailer = safeFilter(filters.retailer)
  const outcome = safeFilter(filters.outcome)
  const since = days == null ? null : Date.now() - days * 86_400_000

  const filtered = attemptRows
    .filter((attempt) => !retailer || attempt.retailer === retailer)
    .filter((attempt) => !outcome || attempt.outcome === outcome)
    .filter((attempt) => since == null || Number(attempt.started_at) >= since)
    .sort((left, right) => Number(right.started_at || 0) - Number(left.started_at || 0))
    .slice(0, limit)
  const selectedIds = new Set(filtered.map((attempt) => attempt.id))
  const eventsByAttempt = new Map()

  for (const event of eventRows) {
    if (!selectedIds.has(event.attempt_id)) continue
    const list = eventsByAttempt.get(event.attempt_id) || []
    list.push(event)
    eventsByAttempt.set(event.attempt_id, list)
  }

  const attempts = filtered.map((attempt) =>
    buildAnalyticsAttempt(attempt, eventsByAttempt.get(attempt.id) || [])
  )
  const completed = attempts.filter((attempt) => attempt.outcome !== 'running')
  const confirmed = completed.filter((attempt) => attempt.outcome === 'confirmed')
  const durations = completed.map((attempt) => attempt.durationMs).filter(Number.isFinite)

  return {
    generatedAt: Date.now(),
    filters: {
      limit,
      days,
      retailer: retailer || 'all',
      outcome: outcome || 'all'
    },
    summary: {
      total: attempts.length,
      completed: completed.length,
      running: attempts.length - completed.length,
      confirmed: confirmed.length,
      successRate: percentage(confirmed.length, completed.length),
      averageDurationMs: average(durations),
      averageMonitorLatencyMs: average(
        attempts.map((attempt) => attempt.monitorLatencyMs).filter(Number.isFinite)
      ),
      outcomes: buildCountBreakdown(attempts, (attempt) => attempt.outcome),
      failures: buildCountBreakdown(
        attempts.filter((attempt) => ['failed', 'manual_required'].includes(attempt.outcome)),
        (attempt) => attempt.failureCode || 'unknown'
      ),
      retailers: buildCountBreakdown(attempts, (attempt) => attempt.retailer)
    },
    stages: buildStageTimings(attempts),
    experiments: buildExperimentBreakdown(attempts),
    attempts
  }
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
  if (/account is busy/.test(value)) code = 'account_busy'
  else if (/target cart session rejected with http (?:401|403)\b/.test(value))
    code = 'cart_session_rejected'
  else if (/target rate limited add to cart/.test(value)) code = 'cart_rate_limited'
  else if (
    /target cart no response|target cart acquisition exhausted no-response-limit/.test(value)
  )
    code = 'cart_no_response'
  else if (/captcha|challenge/.test(value)) code = 'challenge'
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
      .replace(
        /\b(?:card\s+)?(?:ending\s+(?:in\s+)?|last\s*4(?:\s+digits)?\s*[:=]?\s*)\d{4}\b/gi,
        'card ending [redacted]'
      )
      .replace(/\b(cvv|cvc|security\s+code)\s*[:=]?\s*\d{3,4}\b/gi, '$1 [redacted]')
      .replace(/\b(?:\d[ -]?){12,19}\b/g, '[card] ')
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

function serializeCheckoutEventMetadata(value) {
  try {
    return JSON.stringify(sanitizeCheckoutEventMetadata(value))
  } catch {
    return '{}'
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}

function applyLocalArtifacts(experiment, result) {
  const artifacts = ARTIFACT_FIELDS.flatMap(([type, field]) => {
    const path = normalizeArtifactPath(result?.[field])
    return path ? [{ type, path }] : []
  })
  if (!artifacts.length) return experiment
  return { ...experiment, [LOCAL_ARTIFACT_KEY]: artifacts }
}

function normalizeArtifactPath(value) {
  if (!value) return null
  const name = basename(String(value))
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .slice(0, 180)
  return name ? `debug-traces/${name}` : null
}

function toRemoteExperiment(experiment) {
  const remote = { ...experiment }
  delete remote[LOCAL_ARTIFACT_KEY]
  return remote
}

function buildAnalyticsAttempt(row, rawEvents) {
  const experimentJson = parseJson(row.experiment_json)
  const events = rawEvents
    .slice()
    .sort(
      (left, right) =>
        Number(left.sequence || 0) - Number(right.sequence || 0) ||
        Number(left.created_at || 0) - Number(right.created_at || 0)
    )
    .map((event, index, sorted) => {
      const elapsedMs = Math.max(0, Number(event.elapsed_ms) || 0)
      const previousElapsed = index > 0 ? Math.max(0, Number(sorted[index - 1].elapsed_ms) || 0) : 0
      return {
        sequence: Number(event.sequence) || index + 1,
        stage: CHECKOUT_STAGES.includes(event.stage) ? event.stage : 'failed',
        detail: sanitizeDetail(event.detail),
        metadata: parseCheckoutEventMetadata(event.metadata_json),
        elapsedMs,
        deltaMs: Math.max(0, elapsedMs - previousElapsed),
        createdAt: Number(event.created_at) || null
      }
    })
  const firstStageEvents = firstEventsByStage(events)

  return {
    id: String(row.id || ''),
    retailer: sanitizeKey(row.retailer, 'unknown'),
    productName: sanitizeDetail(row.product_name, 140) || 'Unknown product',
    mode: sanitizeKey(row.mode, 'unknown'),
    startedAt: Number(row.started_at) || null,
    completedAt: Number(row.completed_at) || null,
    durationMs: nullableNumber(row.duration_ms),
    outcome: sanitizeKey(row.outcome, 'running'),
    finalStage: sanitizeKey(row.final_stage, 'drop_detected'),
    failureStage: row.failure_stage ? sanitizeKey(row.failure_stage, 'failed') : null,
    failureCode: row.failure_code ? sanitizeKey(row.failure_code, 'unknown') : null,
    errorSummary: sanitizeDetail(row.error_summary),
    eventCount: events.length,
    monitorLatencyMs: nullableNumber(experimentJson.monitor_latency_ms),
    experiment: sanitizeAnalyticsExperiment(experimentJson),
    artifacts: sanitizeArtifacts(experimentJson[LOCAL_ARTIFACT_KEY]),
    milestones: buildMilestones(firstStageEvents),
    cartAttempts: buildCartAttempts(events),
    leaseSummary: buildLeaseSummary(events),
    stageTimings: [...firstStageEvents.entries()].map(([stage, event]) => ({
      stage,
      reachedMs: event.elapsedMs,
      durationMs: nextStageDuration(stage, event.elapsedMs, firstStageEvents)
    })),
    events
  }
}

function buildMilestones(firstStageEvents) {
  return CHECKOUT_STAGES.map((stage) => {
    const event = firstStageEvents.get(stage)
    return {
      stage,
      reached: Boolean(event),
      reachedMs: event?.elapsedMs ?? null,
      durationMs: event ? nextStageDuration(stage, event.elapsedMs, firstStageEvents) : null
    }
  })
}

function buildCartAttempts(events) {
  return events
    .filter((event) =>
      ['cart_click', 'cart_response', 'cart_retry', 'cart_reload'].includes(
        event.metadata.eventType
      )
    )
    .map((event) => ({ elapsedMs: event.elapsedMs, ...event.metadata }))
}

function buildLeaseSummary(events) {
  const leaseEvents = events.filter((event) => event.metadata.eventType === 'account_lease')
  const latest = leaseEvents.at(-1)
  if (!latest) return null
  return {
    state: latest.metadata.leaseState || null,
    contended: leaseEvents.some((event) => event.metadata.leaseState === 'busy'),
    ownerRef: latest.metadata.ownerRef || null,
    heldMs: nullableNumber(latest.metadata.heldMs)
  }
}

function firstEventsByStage(events) {
  const byStage = new Map()
  for (const event of events) {
    if (!byStage.has(event.stage)) byStage.set(event.stage, event)
  }
  return byStage
}

function nextStageDuration(stage, elapsedMs, firstStageEvents) {
  const stageIndex = CHECKOUT_STAGES.indexOf(stage)
  let nextElapsed = null
  for (let index = stageIndex + 1; index < CHECKOUT_STAGES.length; index += 1) {
    const candidate = firstStageEvents.get(CHECKOUT_STAGES[index])
    if (candidate && candidate.elapsedMs >= elapsedMs) {
      nextElapsed = candidate.elapsedMs
      break
    }
  }
  return nextElapsed == null ? null : nextElapsed - elapsedMs
}

function buildStageTimings(attempts) {
  return CHECKOUT_STAGES.map((stage) => {
    const samples = attempts
      .flatMap((attempt) => attempt.stageTimings)
      .filter((timing) => timing.stage === stage)
    const reached = samples.map((sample) => sample.reachedMs).filter(Number.isFinite)
    const durations = samples.map((sample) => sample.durationMs).filter(Number.isFinite)
    return {
      stage,
      attemptsReached: samples.length,
      averageReachedMs: average(reached),
      medianReachedMs: median(reached),
      averageDurationMs: average(durations)
    }
  }).filter((stage) => stage.attemptsReached > 0)
}

function buildExperimentBreakdown(attempts) {
  return ANALYTICS_EXPERIMENT_KEYS.map((key) => {
    const groups = new Map()
    for (const attempt of attempts) {
      const value = experimentValue(attempt.experiment[key])
      const current = groups.get(value) || { value, attempts: 0, confirmed: 0, durations: [] }
      current.attempts += 1
      if (attempt.outcome === 'confirmed') current.confirmed += 1
      if (Number.isFinite(attempt.durationMs)) current.durations.push(attempt.durationMs)
      groups.set(value, current)
    }
    return {
      key,
      values: [...groups.values()]
        .map((group) => ({
          value: group.value,
          attempts: group.attempts,
          confirmed: group.confirmed,
          successRate: percentage(group.confirmed, group.attempts),
          averageDurationMs: average(group.durations)
        }))
        .sort((left, right) => right.attempts - left.attempts)
    }
  }).filter((experiment) => experiment.values.length > 0)
}

function buildCountBreakdown(items, keyFor) {
  const counts = new Map()
  for (const item of items) {
    const key = sanitizeKey(keyFor(item), 'unknown')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, percent: percentage(count, items.length) }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

function sanitizeAnalyticsExperiment(value) {
  return Object.fromEntries(
    ANALYTICS_EXPERIMENT_KEYS.flatMap((key) => {
      const item = value?.[key]
      if (!['string', 'number', 'boolean'].includes(typeof item)) return []
      return [[key, typeof item === 'string' ? item.slice(0, 64) : item]]
    })
  )
}

function sanitizeArtifacts(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 6).flatMap((artifact) => {
    const type = ['trace', 'screenshot', 'diagnostics'].includes(artifact?.type)
      ? artifact.type
      : null
    const path = String(artifact?.path || '')
      .replace(/\\/g, '/')
      .replace(/\.\.+/g, '')
      .replace(/[^a-z0-9_./-]+/gi, '_')
      .slice(0, 220)
    return type && path.startsWith('debug-traces/') ? [{ type, path }] : []
  })
}

function safeFilter(value) {
  const normalized = String(value || '').toLowerCase()
  if (!normalized || normalized === 'all') return null
  return normalized.replace(/[^a-z0-9_-]/g, '').slice(0, 40) || null
}

function sanitizeKey(value, fallback) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 48) || fallback
  )
}

function experimentValue(value) {
  if (value === true) return 'on'
  if (value === false) return 'off'
  if (value == null || value === '') return 'unknown'
  return String(value).slice(0, 64)
}

function nullableNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : null
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, Math.round(number)))
    : fallback
}

function percentage(value, total) {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0
}

function average(values) {
  if (!values.length) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function median(values) {
  if (!values.length) return null
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? Math.round(sorted[middle])
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
