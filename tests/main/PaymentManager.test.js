import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
import { initDb, getDb } from '../../src/main/db.js'
import { deriveKey } from '../../src/main/crypto.js'
import { PaymentManager } from '../../src/main/payments/PaymentManager.js'

let dbPath
let manager

beforeEach(() => {
  dbPath = join(tmpdir(), `pokebot-payment-test-${Date.now()}-${Math.random()}.db`)
  initDb(dbPath)
  manager = new PaymentManager(getDb, deriveKey('testpass'))
})

afterEach(() => {
  getDb().close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}.json`, { force: true })
})

describe('PaymentManager renderer safety', () => {
  it('returns masked metadata without card number or CVV', () => {
    manager.create({
      name: 'Target Visa',
      cardNumber: '4111111111111111',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '456'
    })

    expect(manager.getAllSafe()).toEqual([
      expect.objectContaining({ name: 'Target Visa', cardLast4: '1111' })
    ])
    expect(manager.getAllSafe()[0]).not.toHaveProperty('cardNumber')
    expect(manager.getAllSafe()[0]).not.toHaveProperty('cvv')
  })

  it('clears account assignments when a payment method is deleted', async () => {
    const paymentId = manager.create({
      name: 'Target Visa',
      cardNumber: '4111111111111111',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '456'
    })
    getDb()
      .prepare(
        `INSERT INTO accounts
          (id, name, retailer, username, password_enc, payment_method_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('account-1', 'Target', 'target', 'target@test.com', 'encrypted', paymentId, 'active')

    manager.delete(paymentId)

    expect(getDb().prepare('SELECT * FROM accounts WHERE id = ?').get('account-1')).toMatchObject({
      payment_method_id: null
    })
  })
})
