import { scryptSync, createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const STATIC_SALT = 'pokebot2-salt-v1'

/**
 * Derive a 32-byte AES key from a password.
 * Uses a static salt so the same password always produces the same key,
 * which is required for decrypting previously-stored data.
 */
export function deriveKey(password, salt = STATIC_SALT) {
  return scryptSync(password, salt, 32)
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

/**
 * Alias kept for backward compatibility — identical to deriveKey() with the default salt.
 */
export function deriveKeyLegacy(password) {
  return deriveKey(password)
}
