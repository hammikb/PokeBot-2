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
afterEach(() => { getDb().close(); rmSync(dbPath) })

describe('AccountManager', () => {
  it('creates and retrieves account', async () => {
    const id = await manager.create({
      name: 'Acc1', retailer: 'walmart',
      username: 'user@test.com', password: 'pass123',
      cvv: '123', proxy: '1.2.3.4:8080:user:pass'
    })
    const accounts = manager.getAll()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe('Acc1')
    expect(accounts[0].id).toBe(id)
  })

  it('stores password encrypted (not plaintext)', async () => {
    await manager.create({ name: 'A', retailer: 'target', username: 'u', password: 'mypassword', cvv: '999' })
    const raw = getDb().prepare('SELECT password_enc FROM accounts').get()
    expect(raw.password_enc).not.toBe('mypassword')
  })

  it('decrypts password and cvv on getDecrypted', async () => {
    const id = await manager.create({ name: 'A', retailer: 'target', username: 'u', password: 'mypassword', cvv: '999' })
    const dec = manager.getDecrypted(id)
    expect(dec.password).toBe('mypassword')
    expect(dec.cvv).toBe('999')
  })

  it('returns null from getDecrypted for unknown id', () => {
    expect(manager.getDecrypted('nonexistent')).toBeNull()
  })

  it('deletes account', async () => {
    const id = await manager.create({ name: 'A', retailer: 'walmart', username: 'u', password: 'p', cvv: '1' })
    manager.delete(id)
    expect(manager.getAll()).toHaveLength(0)
  })

  it('getDecrypted does not expose encrypted columns', async () => {
    const id = await manager.create({ name: 'A', retailer: 'walmart', username: 'u', password: 'secret', cvv: '123' })
    const dec = manager.getDecrypted(id)
    expect(dec.password_enc).toBeUndefined()
    expect(dec.cvv_enc).toBeUndefined()
  })

  it('updates allowed fields', async () => {
    const id = await manager.create({ name: 'A', retailer: 'walmart', username: 'u', password: 'p', cvv: '1', proxy: 'old-proxy' })
    manager.update(id, { proxy: 'new-proxy' })
    const accounts = manager.getAll()
    expect(accounts[0].proxy).toBe('new-proxy')
  })
})
