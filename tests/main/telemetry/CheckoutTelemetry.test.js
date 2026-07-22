import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  CheckoutTelemetry,
  applyActualCartExecution,
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
  it('builds a controlled Target experiment profile', () => {
    expect(
      buildExperimentProfile({
        task: { retailer: 'target' },
        settings: {
          targetCartApiEnabled: true,
          targetCheckoutLiteMode: true,
          monitorMode: 'supabase'
        },
        appVersion: '1.2.3'
      })
    ).toEqual({
      cart_strategy: 'api_preferred',
      lite_mode: true,
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

  it('redacts URLs, email addresses, paths, and long numbers', () => {
    const value = sanitizeDetail(
      'user@example.com https://target.com/item C:\\Users\\person\\trace.zip 123456789012'
    )
    expect(value).toBe('[email] [url] [path] [number]')
  })
})
