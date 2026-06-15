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
})
