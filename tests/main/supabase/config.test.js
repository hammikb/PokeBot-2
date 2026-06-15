import { describe, expect, it } from 'vitest'
import { SUPABASE_URL, SUPABASE_KEY } from '../../../src/main/supabase/config.js'

describe('supabase config', () => {
  it('ships baked-in defaults so users only need to log in', () => {
    expect(SUPABASE_URL).toMatch(/\.supabase\.co/)
    expect(SUPABASE_KEY).toMatch(/^sb_publishable_/)
  })
})
