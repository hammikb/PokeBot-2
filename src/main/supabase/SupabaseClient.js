import { createClient } from '@supabase/supabase-js'

// Thin wrapper around supabase-js for the Electron main process. Disables session
// persistence (no browser localStorage in main) and pushes the access token into
// the Realtime socket so private channels (drops:product:{id}) authorize.
export class SupabaseClient {
  constructor({ url, key }) {
    this._client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: true }
    })
  }

  get client() {
    return this._client
  }

  async signIn(email, password) {
    const { data, error } = await this._client.auth.signInWithPassword({ email, password })
    if (error) throw new Error(`Supabase sign-in failed: ${error.message}`)
    await this._client.realtime.setAuth(data.session.access_token)
    return data.session
  }

  async signUp(email, password) {
    const { data, error } = await this._client.auth.signUp({ email, password })
    if (error) throw new Error(`Supabase sign-up failed: ${error.message}`)
    if (!data.session) {
      throw new Error(
        'Supabase sign-up succeeded but returned no session — check that email confirmation is disabled for this project'
      )
    }
    await this._client.realtime.setAuth(data.session.access_token)
    return data.session
  }

  async restoreSession(refreshToken) {
    const { data, error } = await this._client.auth.refreshSession({ refresh_token: refreshToken })
    if (error) throw new Error(`Supabase session restore failed: ${error.message}`)
    await this._client.realtime.setAuth(data.session.access_token)
    return data.session
  }

  async signOut() {
    const { error } = await this._client.auth.signOut()
    if (error) throw new Error(`Supabase sign-out failed: ${error.message}`)
  }
}
