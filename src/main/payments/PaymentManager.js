import { encrypt, decrypt } from '../crypto.js'
import { randomUUID } from 'crypto'

/**
 * PaymentManager - Manages encrypted payment methods
 * Allows reusable payment methods across multiple accounts
 */
export class PaymentManager {
  constructor(getDb, encryptionKey) {
    this.getDb = getDb
    this.key = encryptionKey
  }

  /**
   * Get all payment methods (decrypted)
   */
  getAll() {
    const rows = this.getDb()
      .prepare('SELECT * FROM payment_methods ORDER BY created_at DESC')
      .all()
    return rows.map((row) => this.decryptPaymentMethod(row))
  }

  /**
   * Return display-safe payment metadata to the renderer. Full card numbers
   * and CVVs stay in the main process and are only decrypted for checkout.
   */
  getAllSafe() {
    return this.getAll().map((payment) => ({
      id: payment.id,
      name: payment.name,
      cardLast4: payment.cardNumber.slice(-4),
      expiryMonth: payment.expiryMonth,
      expiryYear: payment.expiryYear,
      billingAddress1: payment.billingAddress1,
      billingCity: payment.billingCity,
      billingState: payment.billingState,
      billingZip: payment.billingZip,
      createdAt: payment.createdAt
    }))
  }

  /**
   * Get a single payment method by ID (decrypted)
   */
  get(id) {
    const row = this.getDb().prepare('SELECT * FROM payment_methods WHERE id = ?').get(id)
    return row ? this.decryptPaymentMethod(row) : null
  }

  /**
   * Create a new payment method
   */
  create(data) {
    const {
      name,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      billingAddress1,
      billingAddress2 = '',
      billingCity,
      billingState,
      billingZip,
      billingPhone = ''
    } = data

    if (!name || !cardNumber || !expiryMonth || !expiryYear || !cvv) {
      throw new Error('name, cardNumber, expiryMonth, expiryYear, and cvv are required')
    }

    const id = randomUUID()
    const encryptedCardNumber = encrypt(cardNumber, this.key)
    const encryptedCvv = encrypt(cvv, this.key)

    this.getDb()
      .prepare(
        `INSERT INTO payment_methods (
          id, name, card_number_enc, expiry_month, expiry_year, cvv_enc,
          billing_address1, billing_address2, billing_city, billing_state, billing_zip, billing_phone,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        encryptedCardNumber,
        expiryMonth,
        expiryYear,
        encryptedCvv,
        billingAddress1,
        billingAddress2,
        billingCity,
        billingState,
        billingZip,
        billingPhone,
        new Date().toISOString()
      )

    return id
  }

  /**
   * Update a payment method
   */
  update(id, fields) {
    const allowed = [
      'name',
      'cardNumber',
      'expiryMonth',
      'expiryYear',
      'cvv',
      'billingAddress1',
      'billingAddress2',
      'billingCity',
      'billingState',
      'billingZip',
      'billingPhone'
    ]

    const updates = {}
    for (const key of allowed) {
      if (key in fields) {
        if (key === 'cardNumber') {
          updates.card_number_enc = encrypt(fields.cardNumber, this.key)
        } else if (key === 'cvv') {
          updates.cvv_enc = encrypt(fields.cvv, this.key)
        } else if (key === 'expiryMonth') {
          updates.expiry_month = fields.expiryMonth
        } else if (key === 'expiryYear') {
          updates.expiry_year = fields.expiryYear
        } else if (key === 'billingAddress1') {
          updates.billing_address1 = fields.billingAddress1
        } else if (key === 'billingAddress2') {
          updates.billing_address2 = fields.billingAddress2
        } else if (key === 'billingCity') {
          updates.billing_city = fields.billingCity
        } else if (key === 'billingState') {
          updates.billing_state = fields.billingState
        } else if (key === 'billingZip') {
          updates.billing_zip = fields.billingZip
        } else if (key === 'billingPhone') {
          updates.billing_phone = fields.billingPhone
        } else {
          updates[key] = fields[key]
        }
      }
    }

    for (const [column, value] of Object.entries(updates)) {
      this.getDb().prepare(`UPDATE payment_methods SET ${column} = ? WHERE id = ?`).run(value, id)
    }
  }

  /**
   * Delete a payment method
   */
  delete(id) {
    this.getDb()
      .prepare('UPDATE accounts SET payment_method_id = ? WHERE payment_method_id = ?')
      .run(null, id)
    this.getDb().prepare('DELETE FROM payment_methods WHERE id = ?').run(id)
  }

  /**
   * Decrypt a payment method row
   */
  decryptPaymentMethod(row) {
    return {
      id: row.id,
      name: row.name,
      cardNumber: decrypt(row.card_number_enc, this.key),
      expiryMonth: row.expiry_month,
      expiryYear: row.expiry_year,
      cvv: decrypt(row.cvv_enc, this.key),
      billingAddress1: row.billing_address1,
      billingAddress2: row.billing_address2,
      billingCity: row.billing_city,
      billingState: row.billing_state,
      billingZip: row.billing_zip,
      billingPhone: row.billing_phone,
      createdAt: row.created_at
    }
  }

  /**
   * Get last 4 digits of card (for display)
   */
  getCardLast4(id) {
    const payment = this.get(id)
    if (!payment) return '****'
    return payment.cardNumber.slice(-4)
  }

  /**
   * Get masked card number (for display)
   */
  getMaskedCardNumber(id) {
    const payment = this.get(id)
    if (!payment) return '****-****-****-****'
    const last4 = payment.cardNumber.slice(-4)
    return `****-****-****-${last4}`
  }
}
