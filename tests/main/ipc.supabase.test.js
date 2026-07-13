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

function makeAuthSessionManager() {
  return {
    getStatus: vi.fn(() => ({ authenticated: false, user: null })),
    getClient: vi.fn(() => ({ fakeClient: true })),
    signIn: vi.fn(async () => {}),
    signUp: vi.fn(async () => {}),
    signOut: vi.fn(async () => {})
  }
}

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
  const authSessionManager = makeAuthSessionManager()
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
    authSessionManager
  })
  return { handlers, settingsStore, taskManager, authSessionManager }
}

describe('supabase catalog IPC handlers', () => {
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

})

describe('auth IPC handlers', () => {
  it("AUTH_GET_STATUS returns the manager's current status", async () => {
    const { handlers, authSessionManager } = setup()
    authSessionManager.getStatus.mockReturnValue({
      authenticated: true,
      user: { id: 'u1', email: 'a@b.com' }
    })
    const result = await handlers.get(IPC.AUTH_GET_STATUS)({})
    expect(result).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('AUTH_SIGN_IN signs in with the given credentials and returns the resulting status', async () => {
    const { handlers, authSessionManager } = setup()
    authSessionManager.getStatus.mockReturnValue({
      authenticated: true,
      user: { id: 'u1', email: 'a@b.com' }
    })
    const result = await handlers.get(IPC.AUTH_SIGN_IN)({}, { email: 'a@b.com', password: 'pw' })
    expect(authSessionManager.signIn).toHaveBeenCalledWith('a@b.com', 'pw', true)
    expect(result).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('AUTH_SIGN_IN passes rememberMe: false through when the caller opts out', async () => {
    const { handlers, authSessionManager } = setup()
    await handlers.get(IPC.AUTH_SIGN_IN)({}, { email: 'a@b.com', password: 'pw', rememberMe: false })
    expect(authSessionManager.signIn).toHaveBeenCalledWith('a@b.com', 'pw', false)
  })

  it('AUTH_SIGN_UP signs up with the given credentials', async () => {
    const { handlers, authSessionManager } = setup()
    await handlers.get(IPC.AUTH_SIGN_UP)({}, { email: 'new@b.com', password: 'pw' })
    expect(authSessionManager.signUp).toHaveBeenCalledWith('new@b.com', 'pw', true)
  })

  it('AUTH_SIGN_OUT signs out and returns the resulting (unauthenticated) status', async () => {
    const { handlers, authSessionManager } = setup()
    const result = await handlers.get(IPC.AUTH_SIGN_OUT)({})
    expect(authSessionManager.signOut).toHaveBeenCalled()
    expect(result).toEqual({ authenticated: false, user: null })
  })
})
