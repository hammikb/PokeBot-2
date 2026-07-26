import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { decrypt, deriveKeyLegacy, encrypt } from '../../../src/main/crypto.js'
import { getDb, initDb } from '../../../src/main/db.js'
import { initializeVaultKey } from '../../../src/main/security/VaultKeyManager.js'

const tempDirs = []
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, '')
}

afterEach(() => {
  try {
    getDb().close()
  } catch {
    // A test may fail before the database opens.
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('VaultKeyManager', () => {
  it('migrates legacy ciphertext and reopens the same OS-protected key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb2-vault-'))
    tempDirs.push(dir)
    initDb(join(dir, 'pokebot.db'))
    const db = getDb()
    const legacyKey = deriveKeyLegacy('custom-legacy-password')
    db.prepare(
      `INSERT INTO accounts
       (id, name, retailer, username, password_enc, cvv_enc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'account-1',
      'Target',
      'target',
      'user@example.test',
      encrypt('password-value', legacyKey),
      encrypt('123', legacyKey),
      'active'
    )

    const key = initializeVaultKey({
      db,
      safeStorage,
      userDataPath: dir,
      legacyPassword: 'custom-legacy-password'
    })
    const migrated = db
      .prepare('SELECT password_enc, cvv_enc FROM accounts WHERE id = ?')
      .get('account-1')
    expect(decrypt(migrated.password_enc, key)).toBe('password-value')
    expect(decrypt(migrated.cvv_enc, key)).toBe('123')
    expect(() => decrypt(migrated.password_enc, legacyKey)).toThrow()

    const reopened = initializeVaultKey({ db, safeStorage, userDataPath: dir })
    expect(reopened.equals(key)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'vault-key.json'), 'utf8')).protectedKey).toBeTruthy()
  })
})
