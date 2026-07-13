import { SupabaseClient } from './SupabaseClient.js'
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'
import { decrypt } from '../crypto.js'

let sessionPromise = null
let publicClient = null

// Unauthenticated client for data anon is allowed to read (the shared product
// catalog). No sign-in, no credentials required — this is what "hooked up to
// Supabase no matter what" means before a login screen exists.
export function getPublicClient() {
  if (!publicClient) publicClient = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY })
  return publicClient
}

// One shared, signed-in Supabase client for the whole app. Established eagerly
// at startup (see index.js) and reused everywhere — catalog browsing, task
// monitoring — instead of every caller creating its own client and signing in
// again. Returns null (not an error) when no bot credentials are configured yet.
export function getSupabaseSession({ getSettings, encryptionKey }) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const s = getSettings()
      if (!s.supabaseEmail || !s.supabasePasswordEnc) return null
      const password = decrypt(s.supabasePasswordEnc, encryptionKey)
      const client = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY })
      await client.signIn(s.supabaseEmail, password)
      return client
    })().catch((err) => {
      sessionPromise = null
      throw err
    })
  }
  return sessionPromise
}

// Force the next getSupabaseSession() call to sign in again — call after the
// bot email/password changes.
export function resetSupabaseSession() {
  sessionPromise = null
}
