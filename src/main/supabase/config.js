// Supabase project connection for the central monitor (PokeAlert).
// The publishable key is a CLIENT key (RLS-protected), so it is safe to bake into
// the app — users only sign in with email + password, never paste URL/keys.
// Override at build/dev time via MAIN_VITE_SUPABASE_URL / MAIN_VITE_SUPABASE_KEY
// (see .env.example); electron-vite inlines these into the main bundle at build.
export const SUPABASE_URL =
  import.meta.env.MAIN_VITE_SUPABASE_URL || 'https://jbnnouwhesexfllninwb.supabase.co'

export const SUPABASE_KEY =
  import.meta.env.MAIN_VITE_SUPABASE_KEY || 'sb_publishable_ISHuDgo14iTtTsRdJFnkYQ__6e9nYlx'
