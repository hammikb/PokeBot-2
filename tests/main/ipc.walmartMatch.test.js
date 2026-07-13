import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handlers, findWalmartMatch } = vi.hoisted(() => {
  const handlers = new Map()
  const findWalmartMatch = vi.fn(async () => [
    { retailer: 'walmart', name: 'Match', url: 'https://www.walmart.com/ip/1', itemId: '1', confidence: 'upc' }
  ])
  return { handlers, findWalmartMatch }
})

vi.mock('electron', () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }))
vi.mock('../../src/main/products/WalmartMatch.js', () => ({ findWalmartMatch }))

import { registerIpcHandlers } from '../../src/main/ipc.js'
import { IPC } from '../../src/shared/constants.js'

function setup() {
  handlers.clear()
  const rows = []
  const db = {
    prepare: vi.fn((sql) => ({
      run: (...args) => {
        if (sql.includes('INSERT OR REPLACE INTO catalog_walmart_matches')) {
          const [target_product_key, walmart_item_id, walmart_url, walmart_name, confidence] = args
          rows.push({ target_product_key, walmart_item_id, walmart_url, walmart_name, confidence })
        }
      },
      all: () => (sql.includes('FROM catalog_walmart_matches') ? rows : [])
    }))
  }
  registerIpcHandlers({
    getDb: () => db,
    accountManager: {},
    paymentManager: {},
    shippingManager: {},
    thumbnailCache: {},
    taskManager: { on: vi.fn(), setMonitorMode: vi.fn(async () => {}) },
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
  return { handlers, rows }
}

describe('Walmart match IPC handlers', () => {
  beforeEach(() => {
    findWalmartMatch.mockClear()
  })

  it('CATALOG_FIND_WALMART_MATCH delegates to findWalmartMatch and returns candidates', async () => {
    const { handlers } = setup()
    const result = await handlers.get(IPC.CATALOG_FIND_WALMART_MATCH)({}, { upc: '123', name: 'Card' })
    expect(findWalmartMatch).toHaveBeenCalledWith({ upc: '123', name: 'Card' })
    expect(result).toEqual([
      { retailer: 'walmart', name: 'Match', url: 'https://www.walmart.com/ip/1', itemId: '1', confidence: 'upc' }
    ])
  })

  it('CATALOG_SAVE_WALMART_MATCH persists the confirmed candidate keyed by Target product key', async () => {
    const { handlers, rows } = setup()
    const candidate = { itemId: '1', url: 'https://www.walmart.com/ip/1', name: 'Match', confidence: 'upc' }
    const result = await handlers.get(IPC.CATALOG_SAVE_WALMART_MATCH)({}, { productKey: 'TCIN1', candidate })
    expect(result).toBe(true)
    expect(rows).toEqual([
      {
        target_product_key: 'TCIN1',
        walmart_item_id: '1',
        walmart_url: 'https://www.walmart.com/ip/1',
        walmart_name: 'Match',
        confidence: 'upc'
      }
    ])
  })

  it('CATALOG_LIST_WALMART_MATCHES returns saved matches', async () => {
    const { handlers } = setup()
    const candidate = { itemId: '1', url: 'https://www.walmart.com/ip/1', name: 'Match', confidence: 'upc' }
    await handlers.get(IPC.CATALOG_SAVE_WALMART_MATCH)({}, { productKey: 'TCIN1', candidate })
    const result = await handlers.get(IPC.CATALOG_LIST_WALMART_MATCHES)({})
    expect(result).toEqual([
      {
        target_product_key: 'TCIN1',
        walmart_item_id: '1',
        walmart_url: 'https://www.walmart.com/ip/1',
        walmart_name: 'Match',
        confidence: 'upc'
      }
    ])
  })
})
