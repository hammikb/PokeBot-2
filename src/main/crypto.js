import { scryptSync, createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// Generate a unique salt per encryption operation for better security
// Note: For account passwords, we still use a user-specific salt stored in the database
export function deriveKey(password, salt = null) {
  // If no salt provided, generate a random one (32 bytes for scrypt)
  const actualSalt = salt || randomBytes(32)
  return { key: scryptSync(password, actualSalt, 32), salt: actualSalt }
}

export function encrypt(plaintext, key) {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(ciphertext, key) {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv = buf.subarray(0, 16)
  const tag = buf.subarray(16, 32)
  const encrypted = buf.subarray(32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

// Legacy function for backward compatibility with existing encrypted data
export function deriveKeyLegacy(password) {
  const SALT_STATIC = 'pokebot2-salt-v1'
  return scryptSync(password, SALT_STATIC, 32)
}
