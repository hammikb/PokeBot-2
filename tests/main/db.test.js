import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDb, getDb } from '../../src/main/db.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync, writeFileSync } from 'fs'

let dbPath
beforeEach(() => {
  dbPath = join(tmpdir(), `pokebot-test-${Date.now()}.db`)
  initDb(dbPath)
})
afterEach(() => {
  getDb().close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}.json`, { force: true })
})

describe('initDb', () => {
  it('creates accounts table', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
      .get()
    expect(row.name).toBe('accounts')
  })
  it('creates tasks table', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get()
    expect(row.name).toBe('tasks')
  })
  it('creates task product image column', () => {
    const columns = getDb()
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((column) => column.name)
    expect(columns).toContain('product_image_url')
  })
  it('creates task buy limit column', () => {
    const columns = getDb()
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((column) => column.name)
    expect(columns).toContain('buy_limit')
    expect(columns).toContain('orders_per_drop')
  })
  it('creates settings table', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .get()
    expect(row.name).toBe('settings')
  })
  it('creates drop_history table', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drop_history'")
      .get()
    expect(row.name).toBe('drop_history')
  })
  it('creates grouped product monitor tables', () => {
    const tables = ['monitor_sources', 'product_monitors'].filter((table) =>
      getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get()
    )
    expect(tables).toEqual(['monitor_sources', 'product_monitors'])
  })
  it('stores retailer MSRP and price limits independently', () => {
    const db = getDb()
    db.prepare('INSERT INTO product_monitors (id, name) VALUES (?, ?)').run('monitor-1', 'ETB')
    const insert = db.prepare(
      `INSERT INTO monitor_sources
        (id, monitor_id, retailer, msrp, price_ceiling, buy_limit, account_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('source-target', 'monitor-1', 'target', 49.99, 49.99, 2, '[]')
    insert.run('source-walmart', 'monitor-1', 'walmart', 54.99, 52.99, 5, '[]')

    const rows = db
      .prepare(
        'SELECT retailer, msrp, price_ceiling FROM monitor_sources WHERE monitor_id = ? ORDER BY retailer'
      )
      .all('monitor-1')
    expect(rows).toEqual([
      { retailer: 'target', msrp: 49.99, price_ceiling: 49.99 },
      { retailer: 'walmart', msrp: 54.99, price_ceiling: 52.99 }
    ])
  })

  it('falls back to the current JSON store when the legacy db file contains JSON', () => {
    getDb().close()
    dbPath = join(tmpdir(), `pokebot-legacy-json-test-${Date.now()}.db`)
    writeFileSync(dbPath, JSON.stringify({ settings: [] }))
    writeFileSync(
      `${dbPath}.json`,
      JSON.stringify({ settings: [{ key: 'pokemonCenterAutoJoin', value: 'true' }] })
    )

    initDb(dbPath)

    expect(getDb().prepare('SELECT key, value FROM settings').all()).toEqual([
      { key: 'pokemonCenterAutoJoin', value: 'true' }
    ])
  })
})
