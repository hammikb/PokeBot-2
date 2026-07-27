import { createHash } from 'crypto'
import { getDb } from '../db.js'

const PERMANENT_STATUSES = new Set([
  'submission_started',
  'alerted',
  'completed',
  'manual_required',
  'ignored'
])
const DEFAULT_RECLAIM_AFTER_MS = 60_000

export class DropEventLedger {
  constructor({
    db,
    now = () => Date.now(),
    reclaimAfterMs = DEFAULT_RECLAIM_AFTER_MS,
    flush
  } = {}) {
    this._db = db || getDb()
    this._now = now
    this._reclaimAfterMs = Math.max(1, Number(reclaimAfterMs) || DEFAULT_RECLAIM_AFTER_MS)
    this._flush = flush || (() => this._db.flushNow?.())
  }

  claim({ taskId, eventId, dropCycleId, retailer, productId }) {
    const eventKey = normalizeId(dropCycleId) || normalizeId(eventId)
    if (!taskId || !eventKey) {
      return { claimed: true, receiptId: null }
    }

    const receiptId = createReceiptId(taskId, eventKey)
    const existing = this._db
      .prepare('SELECT * FROM drop_event_receipts WHERE id = ?')
      .get(receiptId)
    if (existing) {
      const ageMs = Math.max(0, this._now() - Number(existing.claimed_at || 0))
      if (!PERMANENT_STATUSES.has(existing.status) && ageMs >= this._reclaimAfterMs) {
        this._db
          .prepare(
            `UPDATE drop_event_receipts
             SET status = ?, claimed_at = ?, completed_at = ?, detail = ?
             WHERE id = ?`
          )
          .run(
            'claimed',
            this._now(),
            null,
            'Reclaimed after interrupted pre-submit work',
            receiptId
          )
        return { claimed: true, receiptId, reclaimed: true }
      }
      return {
        claimed: false,
        receiptId,
        status: existing.status,
        claimedAt: existing.claimed_at
      }
    }

    this._db
      .prepare(
        `INSERT INTO drop_event_receipts (
          id, task_id, event_id, drop_cycle_id, retailer, product_id,
          status, claimed_at, completed_at, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receiptId,
        taskId,
        normalizeId(eventId),
        normalizeId(dropCycleId),
        retailer || null,
        normalizeId(productId),
        'claimed',
        this._now(),
        null,
        null
      )

    return { claimed: true, receiptId }
  }

  markSubmissionStarted(receiptId, { accountId, orderSequence } = {}) {
    if (!receiptId) return
    const detail = [
      accountId ? `account=${String(accountId).slice(0, 128)}` : null,
      orderSequence ? `order=${Math.max(1, Number(orderSequence) || 1)}` : null
    ]
      .filter(Boolean)
      .join(' ')
    const updated = this._db
      .prepare(
        `UPDATE drop_event_receipts
         SET status = ?, completed_at = ?, account_id = ?, order_sequence = ?, detail = ?
         WHERE id = ?`
      )
      .run(
        'submission_started',
        this._now(),
        accountId || null,
        orderSequence ? Math.max(1, Number(orderSequence) || 1) : null,
        detail || null,
        receiptId
      )
    if (updated?.changes !== 1) {
      throw new Error('Could not persist the irreversible order-submission boundary')
    }
    this._flush()
  }

  complete(receiptId, { status = 'completed', detail } = {}) {
    if (!receiptId) return
    const existing = this.get(receiptId)
    let safeStatus = [...PERMANENT_STATUSES, 'failed'].includes(status) ? status : 'completed'
    if (existing?.status === 'submission_started' && safeStatus === 'failed') {
      safeStatus = 'manual_required'
    }
    this._db
      .prepare(
        'UPDATE drop_event_receipts SET status = ?, completed_at = ?, detail = ? WHERE id = ?'
      )
      .run(safeStatus, this._now(), detail ? String(detail).slice(0, 500) : null, receiptId)
  }

  get(receiptId) {
    if (!receiptId) return null
    return this._db.prepare('SELECT * FROM drop_event_receipts WHERE id = ?').get(receiptId) || null
  }
}

export function createReceiptId(taskId, eventKey) {
  return createHash('sha256').update(`${taskId}:${eventKey}`).digest('hex')
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}
