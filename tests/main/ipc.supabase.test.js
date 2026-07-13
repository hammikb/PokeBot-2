import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handlers, signIn, SupabaseClient, catalogSelect } = vi.hoisted(() => {
  const handlers = new Map()
  const signIn = vi.fn(async () => ({}))
  const catalogSelect = vi.fn(() => ({
    order: async () => ({
      data: [
        {
          id: 'cat-1',
          product_key: '94336414',
          name: 'Pokemon ETB',
          image: null,
          category: 'tcg',
          upc: '196214112568',
          regular_price: 49.99,
          current_price: 44.99,
          price_checked_at: '2026-07-11T12:00:00.000Z'
        }
      ],
      error: null
    })
  }))
  const SupabaseClient = vi.fn(function () {
    return { signIn, client: { from: () => ({ select: catalogSelect }) } }
  })
  return { handlers, signIn, SupabaseClient, catalogSelect }
})

vi.mock('electron', () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }))
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
    queueJoiner: { on: vi.fn() },
    encryptionKey: key
  })
  return { handlers, settingsStore, taskManager, key }
}

describe('supabase IPC handlers', () => {
  beforeEach(() => {
    catalogSelect.mockClear()
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

  it('SUPABASE_CATALOG_LIST reads the target_catalog reference list anonymously — no sign-in required', async () => {
    const { handlers } = setup()
    const result = await handlers.get(IPC.SUPABASE_CATALOG_LIST)({})
    expect(signIn).not.toHaveBeenCalled()
    expect(catalogSelect).toHaveBeenCalledWith(
      'id, product_key, name, image, category, upc, regular_price, current_price, price_checked_at'
    )
    expect(result).toEqual([
      {
        id: 'cat-1',
        retailer: 'target',
        product_key: '94336414',
        product_url: 'https://www.target.com/p/-/A-94336414',
        name: 'Pokemon ETB',
        image: null,
        category: 'tcg',
        upc: '196214112568',
        regular_price: 49.99,
        current_price: 44.99,
        price_checked_at: '2026-07-11T12:00:00.000Z'
      }
    ])
  })

  it('SUPABASE_CLEAR_CREDENTIALS deletes stored email/password (real removal, unlike blanking the field)', async () => {
    const { handlers } = setup()
    const deleted = []
    const db = {
      prepare: vi.fn((sql) => ({
        run: (...args) => {
          if (sql.includes('DELETE FROM settings')) deleted.push(...args)
        }
      }))
    }
    // Re-register with a db we can inspect for the delete call.
    const taskManager = { on: vi.fn(), setMonitorMode: vi.fn(async () => {}) }
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
      getSettings: () => ({}),
      mainWindow: { webContents: { send: vi.fn() } },
      browserPool: {},
      notificationEngine: { fire: vi.fn() },
      queueJoiner: { on: vi.fn() },
      encryptionKey: Buffer.alloc(32, 7)
    })
    const result = await handlers.get(IPC.SUPABASE_CLEAR_CREDENTIALS)({})
    expect(deleted).toEqual(['supabaseEmail', 'supabasePasswordEnc'])
    expect(result).toBe(true)
  })
})
