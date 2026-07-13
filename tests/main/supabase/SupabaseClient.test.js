import { describe, expect, it, vi, beforeEach } from 'vitest'

const { signInWithPassword, setAuth, createClient } = vi.hoisted(() => {
  const signInWithPassword = vi.fn()
  const setAuth = vi.fn()
  const createClient = vi.fn(() => ({
    auth: { signInWithPassword },
    realtime: { setAuth }
  }))
  return { signInWithPassword, setAuth, createClient }
})

vi.mock('@supabase/supabase-js', () => ({ createClient }))

import { SupabaseClient } from '../../../src/main/supabase/SupabaseClient.js'

describe('SupabaseClient', () => {
  beforeEach(() => {
    createClient.mockClear()
    signInWithPassword.mockReset()
    setAuth.mockReset()
  })

  it('signs in and sets the realtime auth token for private channels', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'jwt-123' } },
      error: null
    })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'sb_publishable_abc' })

    await sc.signIn('bot@example.com', '1234')

    expect(createClient).toHaveBeenCalledWith(
      'https://x.supabase.co',
      'sb_publishable_abc',
      expect.objectContaining({ auth: expect.objectContaining({ persistSession: false }) })
    )
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'bot@example.com', password: '1234' })
    expect(setAuth).toHaveBeenCalledWith('jwt-123')
  })

  it('throws a clear error when sign-in fails', async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'invalid login' } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })
    await expect(sc.signIn('a', 'b')).rejects.toThrow('Supabase sign-in failed: invalid login')
  })

  it('signs up and sets the realtime auth token when a session is returned', async () => {
    const signUp = vi.fn(async () => ({
      data: { session: { access_token: 'jwt-signup', refresh_token: 'rt-signup' } },
      error: null
    }))
    createClient.mockReturnValueOnce({ auth: { signInWithPassword, signUp }, realtime: { setAuth } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    const session = await sc.signUp('new@example.com', 'pw123')

    expect(signUp).toHaveBeenCalledWith({ email: 'new@example.com', password: 'pw123' })
    expect(setAuth).toHaveBeenCalledWith('jwt-signup')
    expect(session).toEqual({ access_token: 'jwt-signup', refresh_token: 'rt-signup' })
  })

  it('signUp throws when Supabase returns no session (e.g. email confirmation still required)', async () => {
    const signUp = vi.fn(async () => ({ data: { session: null }, error: null }))
    createClient.mockReturnValueOnce({ auth: { signInWithPassword, signUp }, realtime: { setAuth } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    await expect(sc.signUp('new@example.com', 'pw123')).rejects.toThrow(
      'Supabase sign-up succeeded but returned no session'
    )
  })

  it('restores a session from a stored refresh token', async () => {
    const refreshSession = vi.fn(async () => ({
      data: { session: { access_token: 'jwt-restored', refresh_token: 'rt-restored' } },
      error: null
    }))
    createClient.mockReturnValueOnce({
      auth: { signInWithPassword, refreshSession },
      realtime: { setAuth }
    })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    const session = await sc.restoreSession('rt-old')

    expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'rt-old' })
    expect(setAuth).toHaveBeenCalledWith('jwt-restored')
    expect(session).toEqual({ access_token: 'jwt-restored', refresh_token: 'rt-restored' })
  })

  it('restoreSession throws a clear error when the token is rejected', async () => {
    const refreshSession = vi.fn(async () => ({ data: {}, error: { message: 'invalid token' } }))
    createClient.mockReturnValueOnce({
      auth: { signInWithPassword, refreshSession },
      realtime: { setAuth }
    })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    await expect(sc.restoreSession('rt-old')).rejects.toThrow(
      'Supabase session restore failed: invalid token'
    )
  })

  it('signs out', async () => {
    const signOut = vi.fn(async () => ({ error: null }))
    createClient.mockReturnValueOnce({ auth: { signInWithPassword, signOut }, realtime: { setAuth } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    await sc.signOut()

    expect(signOut).toHaveBeenCalled()
  })
})
