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
  constructor({
    getDb,
    encryptionKey,
    client = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY })
  }) {
    super()
    this._getDb = getDb
    this._key = encryptionKey
    this._client = client
    this._authenticated = false
    this._user = null
    // Whether the current session should be persisted across restarts ("stay signed
    // in"). Defaults true so restoreSession() and the refresh-token rotation below
    // behave as before for the common case.
    this._remember = true

    // supabase-js auto-refreshes the access token in the background and rotates the
    // refresh token on every refresh. Without this subscription the encrypted token we
    // persist goes stale after the first refresh, breaking "session survives restart"
    // once the app has been open long enough for one. Optional chaining throughout so
    // test fixtures that pass a bare fake client (no .client.auth) don't throw.
    this._client.client?.auth?.onAuthStateChange?.((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.refresh_token && this._remember) {
        this._saveRefreshToken(session.refresh_token)
      }
    })
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
    const row = this._getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(REFRESH_TOKEN_KEY)
    if (!row) return null
    try {
      return decrypt(JSON.parse(row.value), this._key)
    } catch {
      return null
    }
  }

  async signIn(email, password, remember = true) {
    const session = await this._client.signIn(email, password)
    this._remember = remember
    if (remember) this._saveRefreshToken(session.refresh_token)
    this._setState(true, session.user ?? null)
    return session
  }

  async signUp(email, password, remember = true) {
    const session = await this._client.signUp(email, password)
    this._remember = remember
    if (remember) this._saveRefreshToken(session.refresh_token)
    this._setState(true, session.user ?? null)
    return session
  }

  async signOut() {
    try {
      await this._client.signOut()
    } catch {
      // Best-effort remote sign-out — clear local session state regardless, so the user
      // isn't stuck "signed in" locally just because the network call failed.
    }
    this._remember = true
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
      this._remember = true
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
