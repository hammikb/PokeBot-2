import { randomBytes } from 'crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { decrypt, deriveKeyLegacy, encrypt } from '../crypto.js'

const KEY_FILE_VERSION = 1
const LEGACY_FALLBACK_PASSWORD = 'pokebot-dev-vault'

export function initializeVaultKey({
  db,
  safeStorage,
  userDataPath,
  legacyPassword = process.env.MAIN_VITE_VAULT_PASSWORD
}) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error(
      'Operating-system credential encryption is unavailable; the local vault cannot open.'
    )
  }

  const keyPath = join(userDataPath, 'vault-key.json')
  if (existsSync(keyPath)) {
    const key = readProtectedKey(keyPath, safeStorage)
    migrateLegacySecrets(db, key, legacyPassword)
    return key
  }

  const key = randomBytes(32)
  writeProtectedKey(keyPath, key, safeStorage)
  try {
    migrateLegacySecrets(db, key, legacyPassword)
  } catch (error) {
    unlinkSync(keyPath)
    throw error
  }
  return key
}

function readProtectedKey(keyPath, safeStorage) {
  try {
    const payload = JSON.parse(readFileSync(keyPath, 'utf8'))
    if (payload.version !== KEY_FILE_VERSION || !payload.protectedKey) {
      throw new Error('unsupported vault key format')
    }
    const raw = safeStorage.decryptString(Buffer.from(payload.protectedKey, 'base64'))
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32) throw new Error('invalid vault key length')
    return key
  } catch (error) {
    throw new Error(`The protected local vault key could not be opened: ${error.message}`)
  }
}

function writeProtectedKey(keyPath, key, safeStorage) {
  const tempPath = `${keyPath}.tmp`
  const protectedKey = safeStorage.encryptString(key.toString('base64')).toString('base64')
  try {
    writeFileSync(tempPath, JSON.stringify({ version: KEY_FILE_VERSION, protectedKey }, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(tempPath, keyPath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error(`The protected local vault key could not be saved: ${error.message}`)
  }
}

function migrateLegacySecrets(db, nextKey, configuredLegacyPassword) {
  const encryptedValues = collectEncryptedValues(db)
  if (encryptedValues.length === 0) {
    setMigrationVersion(db)
    return
  }

  const passwords = [
    ...new Set([configuredLegacyPassword, LEGACY_FALLBACK_PASSWORD].filter(Boolean))
  ]
  const legacyKeys = passwords.map(deriveKeyLegacy)
  let migrated
  try {
    migrated = encryptedValues.map((entry) => {
      try {
        decrypt(entry.value, nextKey)
        return null
      } catch {
        // This value still uses the legacy installation key.
      }
      const plaintext = legacyKeys
        .map((key) => {
          try {
            return decrypt(entry.value, key)
          } catch {
            return null
          }
        })
        .find((value) => value !== null)
      if (plaintext === undefined) throw new Error('legacy key did not decrypt this value')
      const nextValue = encrypt(plaintext, nextKey)
      return { ...entry, nextValue: entry.wrap ? entry.wrap(nextValue) : nextValue }
    })
  } catch {
    migrated = null
  }

  if (!migrated) {
    throw new Error(
      'Existing encrypted data could not be migrated. Restore the vault password used by the previous installation and restart.'
    )
  }

  const apply = () => {
    for (const entry of migrated.filter(Boolean)) {
      db.prepare(`UPDATE ${entry.table} SET ${entry.column} = ? WHERE ${entry.idColumn} = ?`).run(
        entry.nextValue,
        entry.id
      )
    }
    setMigrationVersion(db)
  }

  if (typeof db.transaction === 'function') db.transaction(apply)()
  else apply()
}

function collectEncryptedValues(db) {
  const values = []
  for (const row of db.prepare('SELECT id, password_enc, cvv_enc FROM accounts').all()) {
    if (row.password_enc) values.push(secret('accounts', 'password_enc', row.id, row.password_enc))
    if (row.cvv_enc) values.push(secret('accounts', 'cvv_enc', row.id, row.cvv_enc))
  }
  for (const row of db.prepare('SELECT id, card_number_enc, cvv_enc FROM payment_methods').all()) {
    if (row.card_number_enc) {
      values.push(secret('payment_methods', 'card_number_enc', row.id, row.card_number_enc))
    }
    if (row.cvv_enc) values.push(secret('payment_methods', 'cvv_enc', row.id, row.cvv_enc))
  }
  const refreshToken = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('authRefreshTokenEnc')
  if (refreshToken?.value) {
    try {
      const encrypted = JSON.parse(refreshToken.value)
      if (encrypted) {
        values.push({
          table: 'settings',
          column: 'value',
          idColumn: 'key',
          id: 'authRefreshTokenEnc',
          value: encrypted,
          wrap: (value) => JSON.stringify(value)
        })
      }
    } catch {
      // AuthSessionManager already treats a malformed token as signed out.
    }
  }
  return values
}

function secret(table, column, id, value) {
  return { table, column, idColumn: 'id', id, value }
}

function setMigrationVersion(db) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'vaultKeyVersion',
    JSON.stringify(2)
  )
}
