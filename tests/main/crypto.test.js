import { describe, it, expect } from 'vitest'
import { deriveKey, encrypt, decrypt } from '../../src/main/crypto.js'

describe('crypto', () => {
  it('derives 32-byte key from password', () => {
    const key = deriveKey('mypassword', 'somesalt')
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })
  it('encrypt then decrypt returns original', () => {
    const key = deriveKey('pass', 'salt')
    const ciphertext = encrypt('secret-cvv-123', key)
    expect(ciphertext).not.toBe('secret-cvv-123')
    expect(decrypt(ciphertext, key)).toBe('secret-cvv-123')
  })
  it('different passwords produce different keys', () => {
    const k1 = deriveKey('pass1', 'salt')
    const k2 = deriveKey('pass2', 'salt')
    expect(k1.toString('hex')).not.toBe(k2.toString('hex'))
  })
  it('decrypt with wrong key throws', () => {
    const k1 = deriveKey('pass1', 'salt')
    const k2 = deriveKey('pass2', 'salt')
    const cipher = encrypt('data', k1)
    expect(() => decrypt(cipher, k2)).toThrow()
  })
})
