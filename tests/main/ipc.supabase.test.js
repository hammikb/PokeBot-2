import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handlers, pushCatalogItemToSupabase, signIn, SupabaseClient } = vi.hoisted(() => {
  const handlers = new Map()
  const pushCatalogItemToSupabase = vi.fn(async () => ({ productId: 'prod-1' }))
  const signIn = vi.fn(async () => ({}))
  const SupabaseClient = vi.fn(function () {
    return { signIn, client: { id: 'client' } }
  })
  return { handlers, pushCatalogItemToSupabase, signIn, SupabaseClient }
})

vi.mock('electron', () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }))
vi.mock('../../src/main/supabase/catalogPublish.js', () => ({ pushCatalogItemToSupabase }))
vi.mock('../../src/main/supabase/SupabaseClient.js', () => ({ SupabaseClient }))

import { registerIpcHandlers } from '../../src/main/ipc.js'
import { IPC } from '../../src/shared/constants.js'
import { encrypt, decrypt } from '../../src/main/crypto.js'

function setup() {
  handlers.clear()
  const settingsStore = {}
  const db = {
    prepare: vi.fn((sql) => ({
      run: (key, value) => {
        if (sql.includes('INSERT OR REPLACE INTO settings')) settingsStore[key] = value
      },
      get: () => ({
        id: 'cat-1',
        retailer: 'target',
        retailer_item_id: '94336414',
        product_url: 'https://www.target.com/p/A-94336414',
        title: 'Pokemon ETB'
      }),
      all: () => []
    }))
  }
  const taskManager = { on: vi.fn(), setMonitorMode: vi.fn(async () => {}) }
  const key = Buffer.alloc(32, 7)
  registerIpcHandlers({
    getDb: () => db,
    accountManager: {},
    paymentManager: {},
    shippingManager: {},
    thumbnailCache: {},
    taskManager,
    pokemonFinder: { on: vi.fn() },
    profileWarmup: {},
    configManager: null,
    getSettings: () => ({
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'k',
      supabaseEmail: 'bot@example.com',
      supabasePasswordEnc: encrypt('1234', key)
    }),
    mainWindow: { webContents: { send: vi.fn() } },
    browserPool: {},
    notificationEngine: { fire: vi.fn() },
    encryptionKey: key
  })
  return { handlers, settingsStore, taskManager, key }
}

describe('supabase IPC handlers', () => {
  beforeEach(() => {
    pushCatalogItemToSupabase.mockClear()
    signIn.mockClear()
  })

  it('MONITOR_SET_MODE saves the setting then restarts tasks', async () => {
    const { handlers, settingsStore, taskManager } = setup()
    await handlers.get(IPC.MONITOR_SET_MODE)({}, 'supabase')
    expect(JSON.parse(settingsStore.monitorMode)).toBe('supabase')
    expect(taskManager.setMonitorMode).toHaveBeenCalled()
  })

  it('SUPABASE_SET_PASSWORD stores the password encrypted (never plaintext)', async () => {
    const { handlers, settingsStore, key } = setup()
    await handlers.get(IPC.SUPABASE_SET_PASSWORD)({}, 'hunter2')
    const stored = JSON.parse(settingsStore.supabasePasswordEnc)
    expect(stored).not.toContain('hunter2')
    expect(decrypt(stored, key)).toBe('hunter2')
  })

  it('CATALOG_PUSH_SUPABASE signs in and upserts the catalog item', async () => {
    const { handlers } = setup()
    const result = await handlers.get(IPC.CATALOG_PUSH_SUPABASE)({}, 'cat-1')
    expect(signIn).toHaveBeenCalled()
    expect(pushCatalogItemToSupabase).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ retailer_item_id: '94336414' }) })
    )
    expect(result).toEqual({ productId: 'prod-1' })
  })
})
