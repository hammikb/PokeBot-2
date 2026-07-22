import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, getDb } from '../../../src/main/db.js'
import { AccountManager } from '../../../src/main/accounts/AccountManager.js'
import { deriveKey } from '../../../src/main/crypto.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'

// Mock electron app so AccountManager can derive profile paths without Electron running
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tmpdir()) } }), { virtual: true })

let dbPath, manager, key

beforeEach(() => {
  dbPath = join(tmpdir(), `pokebot-acc-test-${Date.now()}.db`)
  initDb(dbPath)
  key = deriveKey('testpass')
  manager = new AccountManager(getDb, key, tmpdir())
})
afterEach(() => {
  getDb().close()
  rmSync(dbPath)
})

describe('AccountManager', () => {
  it('creates and retrieves account', async () => {
    const id = await manager.create({
      name: 'Acc1',
      retailer: 'walmart',
      username: 'user@test.com',
      password: 'pass123',
      cvv: '123',
      proxy: '1.2.3.4:8080:user:pass'
    })
    const accounts = manager.getAll()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe('Acc1')
    expect(accounts[0].id).toBe(id)
  })

  it('stores password encrypted (not plaintext)', async () => {
    await manager.create({
      name: 'A',
      retailer: 'target',
      username: 'u',
      password: 'mypassword',
      cvv: '999'
    })
    const raw = getDb().prepare('SELECT password_enc FROM accounts').get()
    expect(raw.password_enc).not.toBe('mypassword')
  })

  it('decrypts password and cvv on getDecrypted', async () => {
    const id = await manager.create({
      name: 'A',
      retailer: 'target',
      username: 'u',
      password: 'mypassword',
      cvv: '999'
    })
    const dec = manager.getDecrypted(id)
    expect(dec.password).toBe('mypassword')
    expect(dec.cvv).toBe('999')
  })

  it('returns null from getDecrypted for unknown id', () => {
    expect(manager.getDecrypted('nonexistent')).toBeNull()
  })

  it('deletes account', async () => {
    const id = await manager.create({
      name: 'A',
      retailer: 'walmart',
      username: 'u',
      password: 'p',
      cvv: '1'
    })
    manager.delete(id)
    expect(manager.getAll()).toHaveLength(0)
  })

  it('getDecrypted does not expose encrypted columns', async () => {
    const id = await manager.create({
      name: 'A',
      retailer: 'walmart',
      username: 'u',
      password: 'secret',
      cvv: '123'
    })
    const dec = manager.getDecrypted(id)
    expect(dec.password_enc).toBeUndefined()
    expect(dec.cvv_enc).toBeUndefined()
  })

  it('updates allowed fields', async () => {
    const id = await manager.create({
      name: 'A',
      retailer: 'walmart',
      username: 'u',
      password: 'p',
      cvv: '1',
      proxy: 'old-proxy'
    })
    manager.update(id, { proxy: 'new-proxy' })
    const accounts = manager.getAll()
    expect(accounts[0].proxy).toBe('new-proxy')
  })

  it('prevents two accounts from sharing one sticky proxy', async () => {
    await manager.create({
      name: 'A',
      retailer: 'target',
      username: 'a',
      password: 'p',
      proxy: '1.2.3.4:8080:user:sticky-a'
    })

    await expect(
      manager.create({
        name: 'B',
        retailer: 'target',
        username: 'b',
        password: 'p',
        proxy: '1.2.3.4:8080:user:sticky-a'
      })
    ).rejects.toThrow('already assigned')
  })

  it('assigns a different available proxy to every account', async () => {
    await manager.create({ name: 'A', retailer: 'target', username: 'a', password: 'p' })
    await manager.create({ name: 'B', retailer: 'target', username: 'b', password: 'p' })

    const result = manager.assignUniqueProxies([
      '1.2.3.4:8080:user:sticky-a',
      '1.2.3.4:8080:user:sticky-b'
    ])
    const assigned = manager.getAll().map((account) => account.proxy)

    expect(result.unassigned).toHaveLength(0)
    expect(new Set(assigned).size).toBe(2)
    expect(assigned.every(Boolean)).toBe(true)
  })

  it('assigns a payment method to a Target account', async () => {
    const id = await manager.create({
      name: 'Target',
      retailer: 'target',
      username: 'target@test.com',
      password: 'p',
      paymentMethodId: 'payment-1'
    })

    expect(manager.getAll()[0].payment_method_id).toBe('payment-1')

    manager.update(id, { paymentMethodId: 'payment-2' })
    expect(manager.getDecrypted(id).payment_method_id).toBe('payment-2')
  })

  it('returns saved shipping details for account management', async () => {
    await manager.create({
      name: 'Ship',
      retailer: 'target',
      username: 'ship@test.com',
      password: 'p',
      shipping: {
        firstName: 'Ash',
        lastName: 'Ketchum',
        address1: '1 Pallet Town',
        city: 'Pallet',
        state: 'CA',
        zip: '90210'
      }
    })

    const accounts = manager.getAll()

    expect(JSON.parse(accounts[0].shipping_json)).toMatchObject({
      firstName: 'Ash',
      address1: '1 Pallet Town',
      zip: '90210'
    })
  })

  it('defaults status to active on create', async () => {
    await manager.create({
      name: 'A',
      retailer: 'target',
      username: 'u',
      password: 'p'
    })
    const accounts = manager.getAll()
    expect(accounts[0].status).toBe('active')
  })

  it('saves custom status on create', async () => {
    await manager.create({
      name: 'B',
      retailer: 'walmart',
      username: 'u2',
      password: 'p',
      status: 'unverified'
    })
    const accounts = manager.getAll()
    expect(accounts[0].status).toBe('unverified')
  })

  it('setStatus updates account status', async () => {
    const id = await manager.create({
      name: 'C',
      retailer: 'target',
      username: 'u3',
      password: 'p',
      status: 'unverified'
    })
    manager.setStatus(id, 'verified')
    const accounts = manager.getAll()
    expect(accounts[0].status).toBe('verified')
  })
})
