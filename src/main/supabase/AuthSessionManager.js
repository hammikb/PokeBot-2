import { EventEmitter } from 'events'
import { SupabaseClient } from './SupabaseClient.js'
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'
import { encrypt, decrypt } from '../crypto.js'

const REFRESH_TOKEN_KEY = 'authRefreshTokenEnc'

// Owns the one Supabase session for the app's lifetime. Persists the session's refresh
// token encrypted in `settings` (same local vault key used for account/payment secrets)
// so a signed-in user stays signed in across app restarts. Replaces the old shared
// "bot account" mechanism (session.js's getSupabaseSession) with real per-user identity.
export class AuthSessionManager extends EventEmitter {
  constructor({ getDb, encryptionKey, client = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY }) }) {
    super()
    this._getDb = getDb
    this._key = encryptionKey
    this._client = client
    this._authenticated = false
    this._user = null
  }

  getClient() {
    return this._client.client
  }

  getStatus() {
    return { authenticated: this._authenticated, user: this._user }
  }

  _setState(authenticated, user) {
    this._authenticated = authenticated
    this._user = user
    this.emit('change', { authenticated, user })
  }

  _saveRefreshToken(token) {
    const enc = encrypt(token, this._key)
    this._getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(REFRESH_TOKEN_KEY, JSON.stringify(enc))
  }

  _clearRefreshToken() {
    this._getDb().prepare('DELETE FROM settings WHERE key = ?').run(REFRESH_TOKEN_KEY)
  }

  _readRefreshToken() {
    const row = this._getDb().prepare('SELECT value FROM settings WHERE key = ?').get(REFRESH_TOKEN_KEY)
    if (!row) return null
    try {
      return decrypt(JSON.parse(row.value), this._key)
    } catch {
      return null
    }
  }

  async signIn(email, password) {
    const session = await this._client.signIn(email, password)
    this._saveRefreshToken(session.refresh_token)
    this._setState(true, session.user ?? null)
    return session
  }

  async signUp(email, password) {
    const session = await this._client.signUp(email, password)
    this._saveRefreshToken(session.refresh_token)
    this._setState(true, session.user ?? null)
    return session
  }

  async signOut() {
    await this._client.signOut()
    this._clearRefreshToken()
    this._setState(false, null)
  }

  async restoreSession() {
    const token = this._readRefreshToken()
    if (!token) {
      this._setState(false, null)
      return false
    }
    try {
      const session = await this._client.restoreSession(token)
      this._saveRefreshToken(session.refresh_token)
      this._setState(true, session.user ?? null)
      return true
    } catch {
      this._clearRefreshToken()
      this._setState(false, null)
      return false
    }
  }
}
