import { SupabaseClient } from './SupabaseClient.js'
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'

let publicClient = null

// Unauthenticated client for data anon is allowed to read (the shared product
// catalog). No sign-in, no credentials required.
export function getPublicClient() {
  if (!publicClient) publicClient = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY })
  return publicClient
}
