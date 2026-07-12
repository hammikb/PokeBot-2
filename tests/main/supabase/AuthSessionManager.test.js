import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AuthSessionManager } from '../../../src/main/supabase/AuthSessionManager.js'
import { decrypt } from '../../../src/main/crypto.js'

function makeFakeClient() {
  return {
    signIn: vi.fn(async () => ({ refresh_token: 'rt-1', user: { id: 'u1', email: 'a@b.com' } })),
    signUp: vi.fn(async () => ({ refresh_token: 'rt-2', user: { id: 'u2', email: 'c@d.com' } })),
    signOut: vi.fn(async () => {}),
    restoreSession: vi.fn(async () => ({ refresh_token: 'rt-3', user: { id: 'u1', email: 'a@b.com' } })),
    client: { fakeRawClient: true }
  }
}

function makeDb() {
  const store = {}
  return {
    prepare: vi.fn((sql) => ({
      run: (...args) => {
        if (sql.includes('INSERT OR REPLACE INTO settings')) store[args[0]] = args[1]
        if (sql.includes('DELETE FROM settings')) delete store[args[0]]
      },
      get: (key) => (store[key] !== undefined ? { value: store[key] } : undefined)
    })),
    _store: store
  }
}

const KEY = Buffer.alloc(32, 9)

describe('AuthSessionManager', () => {
  let client, db, manager

  beforeEach(() => {
    client = makeFakeClient()
    db = makeDb()
    manager = new AuthSessionManager({ getDb: () => db, encryptionKey: KEY, client })
  })

  it('signIn stores the refresh token encrypted, updates status, and emits change', async () => {
    const changes = []
    manager.on('change', (s) => changes.push(s))

    await manager.signIn('a@b.com', 'pw')

    expect(client.signIn).toHaveBeenCalledWith('a@b.com', 'pw')
    const stored = JSON.parse(db._store.authRefreshTokenEnc)
    expect(decrypt(stored, KEY)).toBe('rt-1')
    expect(changes).toEqual([{ authenticated: true, user: { id: 'u1', email: 'a@b.com' } }])
    expect(manager.getStatus()).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('restoreSession with a stored token restores it and re-saves the new one', async () => {
    await manager.signIn('a@b.com', 'pw') // seeds a stored token
    client.restoreSession.mockClear()

    const ok = await manager.restoreSession()

    expect(ok).toBe(true)
    expect(client.restoreSession).toHaveBeenCalledWith('rt-1')
    expect(manager.getStatus()).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('restoreSession with no stored token reports unauthenticated without calling the client', async () => {
    const ok = await manager.restoreSession()

    expect(ok).toBe(false)
    expect(client.restoreSession).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual({ authenticated: false, user: null })
  })

  it('restoreSession clears a stale token when the client rejects it', async () => {
    await manager.signIn('a@b.com', 'pw')
    client.restoreSession.mockRejectedValueOnce(new Error('expired'))

    const ok = await manager.restoreSession()

    expect(ok).toBe(false)
    expect(db._store.authRefreshTokenEnc).toBeUndefined()
    expect(manager.getStatus()).toEqual({ authenticated: false, user: null })
  })

  it('signOut clears the stored token and reports unauthenticated', async () => {
    await manager.signIn('a@b.com', 'pw')

    await manager.signOut()

    expect(client.signOut).toHaveBeenCalled()
    expect(db._store.authRefreshTokenEnc).toBeUndefined()
    expect(manager.getStatus()).toEqual({ authenticated: false, user: null })
  })
})
