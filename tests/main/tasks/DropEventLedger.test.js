import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb, JsonDb } from '../../../src/main/db.js'
import { createReceiptId, DropEventLedger } from '../../../src/main/tasks/DropEventLedger.js'

describe('DropEventLedger', () => {
  let directory
  let ledger

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pokebot-drop-ledger-'))
    initDb(join(directory, 'pokebot.db'))
    ledger = new DropEventLedger({ now: () => 1_700_000_000_000 })
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('claims an event once per task and rejects a replay', () => {
    const first = ledger.claim({
      taskId: 'task-1',
      eventId: 'drop-123',
      retailer: 'target',
      productId: 'product-1'
    })
    const replay = ledger.claim({
      taskId: 'task-1',
      eventId: 'drop-123',
      retailer: 'target',
      productId: 'product-1'
    })

    expect(first).toEqual({
      claimed: true,
      receiptId: createReceiptId('task-1', 'drop-123')
    })
    expect(replay).toMatchObject({
      claimed: false,
      receiptId: first.receiptId,
      status: 'claimed'
    })
  })

  it('allows the same event to drive a different task', () => {
    expect(ledger.claim({ taskId: 'task-1', eventId: 'drop-123' }).claimed).toBe(true)
    expect(ledger.claim({ taskId: 'task-2', eventId: 'drop-123' }).claimed).toBe(true)
  })

  it('uses a drop cycle when an event id is unavailable', () => {
    const first = ledger.claim({ taskId: 'task-1', dropCycleId: 'cycle-7' })
    const replay = ledger.claim({ taskId: 'task-1', dropCycleId: 'cycle-7' })

    expect(first.claimed).toBe(true)
    expect(replay.claimed).toBe(false)
  })

  it('deduplicates separate rows that belong to the same stock cycle', () => {
    const first = ledger.claim({
      taskId: 'task-1',
      eventId: 'drop-row-1',
      dropCycleId: 'stock-cycle-1'
    })
    const repeatedSignal = ledger.claim({
      taskId: 'task-1',
      eventId: 'drop-row-2',
      dropCycleId: 'stock-cycle-1'
    })

    expect(first.claimed).toBe(true)
    expect(repeatedSignal.claimed).toBe(false)
    expect(repeatedSignal.receiptId).toBe(first.receiptId)
  })

  it('does not persist manual events without a durable identity', () => {
    expect(ledger.claim({ taskId: 'task-1' })).toEqual({
      claimed: true,
      receiptId: null
    })
    expect(ledger.claim({ taskId: 'task-1' }).claimed).toBe(true)
  })

  it('records a terminal result without making the event retryable', () => {
    const claim = ledger.claim({ taskId: 'task-1', eventId: 'drop-123' })
    ledger.complete(claim.receiptId, {
      status: 'manual_required',
      detail: 'Order submission response was ambiguous'
    })

    expect(ledger.get(claim.receiptId)).toMatchObject({
      status: 'manual_required',
      completed_at: 1_700_000_000_000,
      detail: 'Order submission response was ambiguous'
    })
    expect(ledger.claim({ taskId: 'task-1', eventId: 'drop-123' }).claimed).toBe(false)
  })

  it('reclaims interrupted pre-submit work but never reclaims a submitted order', () => {
    let now = 1_700_000_000_000
    const reclaimingLedger = new DropEventLedger({
      now: () => now,
      reclaimAfterMs: 60_000
    })
    const first = reclaimingLedger.claim({ taskId: 'task-1', eventId: 'drop-reclaim' })

    now += 61_000
    expect(reclaimingLedger.claim({ taskId: 'task-1', eventId: 'drop-reclaim' })).toMatchObject({
      claimed: true,
      reclaimed: true
    })

    reclaimingLedger.markSubmissionStarted(first.receiptId, {
      accountId: 'account-1',
      orderSequence: 1
    })
    expect(reclaimingLedger.get(first.receiptId)).toMatchObject({
      status: 'submission_started',
      account_id: 'account-1',
      order_sequence: 1
    })
    now += 120_000
    expect(reclaimingLedger.claim({ taskId: 'task-1', eventId: 'drop-reclaim' })).toMatchObject({
      claimed: false,
      status: 'submission_started'
    })
  })

  it('forces the JSON fallback to disk at the irreversible boundary', () => {
    const jsonPath = join(directory, 'legacy.json')
    const jsonDb = new JsonDb(jsonPath)
    const jsonLedger = new DropEventLedger({ db: jsonDb })
    const claim = jsonLedger.claim({ taskId: 'task-json', eventId: 'drop-json' })

    jsonLedger.markSubmissionStarted(claim.receiptId)

    const reopened = new JsonDb(jsonPath)
    const persisted = new DropEventLedger({ db: reopened }).get(claim.receiptId)
    expect(persisted).toMatchObject({ status: 'submission_started' })
    jsonDb.close()
    reopened.close()
  })

  it('refuses to cross the submission boundary when durable persistence fails', () => {
    const unsafeLedger = new DropEventLedger({
      flush: () => {
        throw new Error('disk full')
      }
    })
    const claim = unsafeLedger.claim({ taskId: 'task-1', eventId: 'drop-disk-error' })

    expect(() => unsafeLedger.markSubmissionStarted(claim.receiptId)).toThrow('disk full')
  })
})
