import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  CheckoutTelemetry,
  applyActualCartExecution,
  buildCheckoutAnalyticsReport,
  buildExperimentProfile,
  classifyCheckoutFailure,
  classifyCheckoutStage,
  sanitizeDetail
} from '../../../src/main/telemetry/CheckoutTelemetry.js'
import { JsonDb } from '../../../src/main/db.js'

const tempPaths = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    if (existsSync(path)) rmSync(path, { force: true })
  }
})

describe('CheckoutTelemetry', () => {
  it('never lets local telemetry storage failures abort checkout', () => {
    const telemetry = new CheckoutTelemetry({
      getDb: () => ({
        prepare: () => {
          throw new Error('disk unavailable')
        }
      })
    })

    expect(
      telemetry.beginAttempt({
        task: { id: 'task-1', retailer: 'target' },
        dropEvent: { retailer: 'target', productName: 'Pokemon item' },
        accountId: 'account-1'
      })
    ).toBeNull()

    telemetry._active.set('attempt-1', {
      startedAt: Date.now(),
      sequence: 0,
      lastStage: 'drop_detected'
    })
    expect(telemetry.record('attempt-1', 'cart_ready', 'Cart ready')).toBe(true)
    expect(telemetry.completeAttempt('attempt-1', { success: true })).toBe(false)
  })

  it('builds a controlled Target experiment profile', () => {
    expect(
      buildExperimentProfile({
        task: { retailer: 'target' },
        settings: {
          targetCartApiEnabled: true,
          targetCheckoutLiteMode: true,
          targetCommitNavigationEnabled: true,
          monitorMode: 'supabase'
        },
        appVersion: '1.2.3'
      })
    ).toEqual({
      cart_strategy: 'api_preferred',
      lite_mode: true,
      commit_navigation: true,
      browser_profile: 'persistent',
      monitor_source: 'supabase',
      app_version: '1.2.3',
      order_sequence: 1,
      orders_per_drop: 1
    })
  })

  it('records the sanitized cart path that actually executed', () => {
    expect(
      applyActualCartExecution(
        { cart_strategy: 'api_preferred', lite_mode: true },
        {
          cartStrategyActual: 'browser_fallback',
          cartFallbackReason: 'api_rate_limited',
          cartQuantityRequested: 2,
          cartQuantityActual: 1
        }
      )
    ).toEqual({
      cart_strategy: 'api_preferred',
      cart_strategy_actual: 'browser_fallback',
      cart_fallback_reason: 'api_rate_limited',
      cart_quantity_requested: 2,
      cart_quantity_actual: 1,
      lite_mode: true
    })

    expect(
      applyActualCartExecution(
        { cart_strategy: 'browser' },
        { cartStrategyActual: 'untrusted-value', cartFallbackReason: 'anything' }
      )
    ).toEqual({ cart_strategy: 'browser' })
  })

  it('normalizes checkout steps and failures', () => {
    expect(classifyCheckoutStage('Opening Target checkout')).toBe('checkout_opened')
    expect(classifyCheckoutStage('Adding 2 item(s) to cart via API...')).toBe('cart_attempted')
    expect(classifyCheckoutStage('Waiting for order confirmation')).toBe('order_submitted')
    expect(
      classifyCheckoutFailure('Target high-demand item caused a delay', 'checkout_ready')
    ).toEqual({
      code: 'high_demand',
      stage: 'checkout_ready'
    })
    expect(classifyCheckoutStage('Target fulfillment is still loading')).toBe('product_opened')
    expect(classifyCheckoutFailure('Target availability did not settle', 'product_opened')).toEqual(
      { code: 'availability', stage: 'product_opened' }
    )
  })

  it('classifies precise Target cart failures before generic checkout failures', () => {
    expect(
      classifyCheckoutFailure('Target cart session rejected with HTTP 401', 'cart_attempted')
    ).toEqual({ code: 'cart_session_rejected', stage: 'cart_attempted' })
    expect(
      classifyCheckoutFailure('Target cart session rejected with HTTP 403', 'cart_attempted')
    ).toEqual({ code: 'cart_session_rejected', stage: 'cart_attempted' })
    expect(
      classifyCheckoutFailure('Target rate limited Add to cart; HTTP 429', 'cart_attempted')
    ).toEqual({ code: 'cart_rate_limited', stage: 'cart_attempted' })
    expect(
      classifyCheckoutFailure(
        'Target rate limited Add to cart; Target cart acquisition exhausted retry-limit',
        'cart_attempted'
      )
    ).toEqual({ code: 'cart_rate_limited', stage: 'cart_attempted' })
    expect(
      classifyCheckoutFailure(
        'Target cart acquisition exhausted no-response-limit',
        'cart_attempted'
      )
    ).toEqual({ code: 'cart_no_response', stage: 'cart_attempted' })
    expect(
      classifyCheckoutFailure(
        'Target cart no response; Target cart acquisition exhausted reload-limit',
        'cart_attempted'
      )
    ).toEqual({ code: 'cart_no_response', stage: 'cart_attempted' })
    expect(classifyCheckoutFailure('Requested item is out of stock', 'availability_ready')).toEqual(
      { code: 'inventory', stage: 'availability_ready' }
    )
    expect(classifyCheckoutFailure('Target captcha challenge detected', 'session_checked')).toEqual(
      { code: 'challenge', stage: 'session_checked' }
    )
    expect(classifyCheckoutFailure('Browser context closed', 'checkout_opened')).toEqual({
      code: 'browser_closed',
      stage: 'checkout_opened'
    })
  })

  it('recovers terminal attempts left incomplete by older JSON database builds', () => {
    const dbPath = join(tmpdir(), `pokebot-telemetry-${Date.now()}-${Math.random()}.json`)
    tempPaths.push(dbPath)
    const db = new JsonDb(dbPath)
    db.prepare(
      `INSERT INTO checkout_attempts
       (id, started_at, outcome, final_stage, upload_status)
       VALUES (?, ?, ?, ?, ?)`
    ).run('attempt-1', 1000, 'running', 'cart_attempted', 'pending')
    db.prepare(
      `INSERT INTO checkout_attempt_events
       (id, attempt_id, sequence, stage, detail, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('event-1', 'attempt-1', 1, 'cart_attempted', 'Adding to cart', 100, 1100)
    db.prepare(
      `INSERT INTO checkout_attempt_events
       (id, attempt_id, sequence, stage, detail, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'event-2',
      'attempt-1',
      2,
      'failed',
      'Item is out of stock (Add to cart button is disabled)',
      500,
      1500
    )

    new CheckoutTelemetry({ getDb: () => db })

    expect(
      db.prepare('SELECT * FROM checkout_attempts WHERE id = ?').get('attempt-1')
    ).toMatchObject({
      completed_at: 1500,
      duration_ms: 500,
      outcome: 'failed',
      final_stage: 'failed',
      failure_stage: 'cart_attempted',
      failure_code: 'inventory',
      event_count: 2,
      upload_status: 'pending'
    })
  })

  it('finalizes crash-interrupted attempts and quarantines post-submit uncertainty in analytics', () => {
    const dbPath = join(tmpdir(), `pokebot-telemetry-recovery-${Date.now()}-${Math.random()}.json`)
    tempPaths.push(dbPath)
    const db = new JsonDb(dbPath)
    const insertAttempt = db.prepare(
      `INSERT INTO checkout_attempts
       (id, started_at, outcome, final_stage, upload_status)
       VALUES (?, ?, ?, ?, ?)`
    )
    const insertEvent = db.prepare(
      `INSERT INTO checkout_attempt_events
       (id, attempt_id, sequence, stage, detail, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insertAttempt.run('before-submit', 1000, 'running', 'cart_ready', 'pending')
    insertEvent.run('event-before', 'before-submit', 1, 'cart_ready', 'Cart ready', 100, 1100)
    insertAttempt.run('after-submit', 2000, 'running', 'order_submitted', 'pending')
    insertEvent.run(
      'event-after',
      'after-submit',
      1,
      'order_submitted',
      'Waiting for confirmation',
      100,
      2100
    )

    new CheckoutTelemetry({ getDb: () => db })

    expect(
      db.prepare('SELECT * FROM checkout_attempts WHERE id = ?').get('before-submit')
    ).toMatchObject({
      outcome: 'failed',
      final_stage: 'failed',
      failure_code: 'app_interrupted',
      failure_stage: 'cart_ready'
    })
    expect(
      db.prepare('SELECT * FROM checkout_attempts WHERE id = ?').get('after-submit')
    ).toMatchObject({
      outcome: 'manual_required',
      final_stage: 'manual_required',
      failure_code: 'submission_uncertain',
      failure_stage: 'order_submitted'
    })
  })

  it('redacts URLs, paths, email, card, last-four, and CVV details', () => {
    const value = sanitizeDetail(
      'user@example.com https://target.com/item C:\\Users\\person\\trace.zip 4111 1111 1111 1111 card ending in 4242 CVV 123'
    )
    expect(value).toBe('[email] [url] [path] [card] card ending [redacted] CVV [redacted]')
  })

  it('keeps telemetry local when checkout analytics is disabled', async () => {
    const dbPath = join(tmpdir(), `pokebot-telemetry-optout-${Date.now()}.json`)
    tempPaths.push(dbPath)
    const db = new JsonDb(dbPath)
    const telemetry = new CheckoutTelemetry({
      getDb: () => db,
      getSettings: () => ({ checkoutTelemetryEnabled: false }),
      authSessionManager: {
        getStatus: () => ({ authenticated: true, user: { id: 'user-1' } }),
        getClient: () => {
          throw new Error('remote client must not be accessed after opt-out')
        }
      }
    })

    await expect(telemetry.flushPending()).resolves.toEqual({ uploaded: 0, optedOut: true })
    await expect(telemetry.uploadAttempt('attempt-1')).resolves.toBe(false)
  })

  it('keeps sanitized event metadata locally and omits it from remote event rows', async () => {
    const dbPath = join(tmpdir(), `pokebot-telemetry-metadata-${Date.now()}.json`)
    tempPaths.push(dbPath)
    const db = new JsonDb(dbPath)
    const remoteRows = []
    const telemetry = new CheckoutTelemetry({
      getDb: () => db,
      authSessionManager: {
        getStatus: () => ({ authenticated: true, user: { id: 'user-1' } }),
        getClient: () => ({
          from: (table) => ({
            upsert: async (rows) => {
              remoteRows.push({ table, rows })
              return { error: null }
            }
          })
        })
      }
    })
    const attemptId = telemetry.beginAttempt({
      task: { id: 'task-1', retailer: 'target' },
      dropEvent: { retailer: 'target', productName: 'Pokemon item' },
      accountId: 'account-1'
    })

    telemetry.record(attemptId, 'cart_attempted', 'Target response', {
      eventType: 'cart_response',
      requestType: 'cart_mutation',
      responseKind: 'rate_limit',
      httpStatus: 429,
      productUrl: 'https://www.target.com/private'
    })
    telemetry.completeAttempt(attemptId, { success: true })
    await telemetry.uploadAttempt(attemptId)

    const event = db
      .prepare(
        "SELECT * FROM checkout_attempt_events WHERE attempt_id = ? AND stage = 'cart_attempted'"
      )
      .get(attemptId)
    expect(JSON.parse(event.metadata_json)).toEqual({
      eventType: 'cart_response',
      requestType: 'cart_mutation',
      responseKind: 'rate_limit',
      httpStatus: 429
    })
    const eventPayloads = remoteRows.filter((entry) => entry.table === 'checkout_attempt_events')
    expect(eventPayloads.at(-1).rows.every((row) => !Object.hasOwn(row, 'metadata_json'))).toBe(
      true
    )
  })

  it('anonymizes account leases and projects structured checkout diagnostics', () => {
    const dbPath = join(tmpdir(), `pokebot-telemetry-lease-${Date.now()}.json`)
    tempPaths.push(dbPath)
    const db = new JsonDb(dbPath)
    const telemetry = new CheckoutTelemetry({ getDb: () => db })
    const attemptId = telemetry.beginAttempt({
      task: { id: 'task-1', retailer: 'target' },
      dropEvent: { retailer: 'target', productName: 'Pokemon item' },
      accountId: 'account-1'
    })

    telemetry.recordLease(attemptId, 'busy', { ownerId: 'account-owner-1', heldMs: 1200 })
    telemetry.flushLocal()

    const leaseEvent = db
      .prepare("SELECT * FROM checkout_attempt_events WHERE detail = 'Account lease busy'")
      .get()
    const leaseMetadata = JSON.parse(leaseEvent.metadata_json)
    expect(leaseMetadata.ownerRef).toMatch(/^[a-f0-9]{20}$/)
    expect(leaseMetadata.ownerRef).not.toBe('account-owner-1')

    const now = Date.now()
    const report = buildCheckoutAnalyticsReport(
      [
        {
          id: 'structured-attempt',
          retailer: 'target',
          product_name: 'Pokemon item',
          mode: 'auto-checkout',
          started_at: now - 2_000,
          outcome: 'failed',
          final_stage: 'failed'
        },
        {
          id: 'legacy-attempt',
          retailer: 'target',
          product_name: 'Legacy item',
          mode: 'auto-checkout',
          started_at: now - 4_000,
          outcome: 'failed',
          final_stage: 'failed'
        }
      ],
      [
        {
          attempt_id: 'structured-attempt',
          sequence: 1,
          stage: 'drop_detected',
          detail: 'Stock detected',
          elapsed_ms: 0,
          created_at: now - 2_000
        },
        {
          attempt_id: 'structured-attempt',
          sequence: 2,
          stage: 'cart_attempted',
          detail: 'Target response',
          elapsed_ms: 1_200,
          created_at: now - 800,
          metadata_json:
            '{"eventType":"cart_response","requestType":"cart_mutation","responseKind":"rate_limit","httpStatus":429,"retryNumber":1}'
        },
        {
          attempt_id: 'structured-attempt',
          sequence: 3,
          stage: 'drop_detected',
          detail: 'Account lease busy',
          elapsed_ms: 1_300,
          created_at: now - 700,
          metadata_json:
            '{"eventType":"account_lease","leaseState":"busy","ownerRef":"a94a8fe5ccb19ba61c4c","heldMs":1200}'
        },
        {
          attempt_id: 'legacy-attempt',
          sequence: 1,
          stage: 'drop_detected',
          detail: 'Stock detected',
          elapsed_ms: 0,
          created_at: now - 4_000
        }
      ],
      { days: 7 }
    )

    expect(report.attempts[0].cartAttempts).toEqual([
      expect.objectContaining({ responseKind: 'rate_limit', httpStatus: 429, retryNumber: 1 })
    ])
    expect(report.attempts[0].leaseSummary).toMatchObject({ contended: true, state: 'busy' })
    expect(
      report.attempts[0].milestones.find((item) => item.stage === 'cart_attempted')
    ).toMatchObject({ reached: true, reachedMs: 1200 })
    expect(report.attempts[1]).toMatchObject({ cartAttempts: [], leaseSummary: null })
  })

  it('preserves a text event when malformed metadata cannot be sanitized', () => {
    const dbPath = join(tmpdir(), `pokebot-telemetry-malformed-metadata-${Date.now()}.json`)
    tempPaths.push(dbPath)
    const db = new JsonDb(dbPath)
    const telemetry = new CheckoutTelemetry({ getDb: () => db })
    const attemptId = telemetry.beginAttempt({
      task: { id: 'task-1', retailer: 'target' },
      dropEvent: { retailer: 'target', productName: 'Pokemon item' },
      accountId: 'account-1'
    })
    const malformedMetadata = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('bad metadata')
        }
      }
    )

    expect(
      telemetry.record(attemptId, 'cart_attempted', 'Target response', malformedMetadata)
    ).toBe(true)
    telemetry.flushLocal()

    const event = db
      .prepare(
        "SELECT * FROM checkout_attempt_events WHERE attempt_id = ? AND stage = 'cart_attempted'"
      )
      .get(attemptId)
    expect(event).toMatchObject({ detail: 'Target response', metadata_json: '{}' })
  })

  it('builds a safe local analytics report with breakdowns and stage timings', () => {
    const now = Date.now()
    const attempts = [
      {
        id: 'confirmed-attempt',
        account_ref: 'must-not-leak',
        device_ref: 'must-not-leak',
        retailer: 'target',
        product_name: 'Pokemon Day Collection',
        mode: 'auto-checkout',
        experiment_json: JSON.stringify({
          cart_strategy: 'api_preferred',
          cart_strategy_actual: 'browser_fallback',
          lite_mode: true,
          commit_navigation: false,
          monitor_latency_ms: 240,
          secret: 'must-not-leak',
          _local_artifacts: [
            { type: 'trace', path: 'debug-traces/target-checkout.zip' },
            { type: 'unknown', path: 'C:/Users/private/secret.txt' }
          ]
        }),
        started_at: now - 10_000,
        completed_at: now - 5_000,
        duration_ms: 5_000,
        outcome: 'confirmed',
        final_stage: 'confirmed',
        event_count: 3
      },
      {
        id: 'failed-attempt',
        retailer: 'target',
        product_name: 'Booster Bundle',
        mode: 'auto-checkout',
        experiment_json: JSON.stringify({
          cart_strategy: 'browser',
          lite_mode: false,
          commit_navigation: false,
          monitor_latency_ms: 360
        }),
        started_at: now - 20_000,
        completed_at: now - 17_000,
        duration_ms: 3_000,
        outcome: 'failed',
        final_stage: 'failed',
        failure_stage: 'cart_attempted',
        failure_code: 'inventory',
        error_summary: 'Item is out of stock',
        event_count: 2
      }
    ]
    const events = [
      {
        attempt_id: 'confirmed-attempt',
        sequence: 1,
        stage: 'drop_detected',
        detail: 'milestone:in_stock',
        elapsed_ms: 0,
        created_at: now - 10_000
      },
      {
        attempt_id: 'confirmed-attempt',
        sequence: 2,
        stage: 'cart_ready',
        detail: 'Cart ready',
        elapsed_ms: 1_500,
        created_at: now - 8_500
      },
      {
        attempt_id: 'confirmed-attempt',
        sequence: 3,
        stage: 'confirmed',
        detail: 'Order confirmed',
        elapsed_ms: 5_000,
        created_at: now - 5_000
      },
      {
        attempt_id: 'failed-attempt',
        sequence: 1,
        stage: 'drop_detected',
        detail: 'milestone:in_stock',
        elapsed_ms: 0,
        created_at: now - 20_000
      },
      {
        attempt_id: 'failed-attempt',
        sequence: 2,
        stage: 'failed',
        detail: 'Item is out of stock',
        elapsed_ms: 3_000,
        created_at: now - 17_000
      }
    ]

    const report = buildCheckoutAnalyticsReport(attempts, events, {
      retailer: 'target',
      days: 7
    })

    expect(report.summary).toMatchObject({
      total: 2,
      completed: 2,
      confirmed: 1,
      successRate: 50,
      averageDurationMs: 4000,
      averageMonitorLatencyMs: 300
    })
    expect(report.summary.failures).toEqual([{ key: 'inventory', count: 1, percent: 100 }])
    expect(report.stages.find((stage) => stage.stage === 'cart_ready')).toMatchObject({
      attemptsReached: 1,
      averageReachedMs: 1500,
      averageDurationMs: 3500
    })
    expect(
      report.experiments
        .find((experiment) => experiment.key === 'lite_mode')
        .values.map((value) => value.value)
    ).toEqual(['on', 'off'])
    expect(report.attempts[0].artifacts).toEqual([
      { type: 'trace', path: 'debug-traces/target-checkout.zip' }
    ])
    expect(report.attempts[0].experiment).not.toHaveProperty('secret')
    expect(report.attempts[0].monitorLatencyMs).toBe(240)
    expect(report.attempts[0]).not.toHaveProperty('account_ref')
    expect(report.attempts[0]).not.toHaveProperty('device_ref')
  })
})
