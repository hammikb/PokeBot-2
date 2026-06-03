import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDb, getDb } from '../../src/main/db.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'

let dbPath
beforeEach(() => {
  dbPath = join(tmpdir(), `pokebot-test-${Date.now()}.db`)
  initDb(dbPath)
})
afterEach(() => {
  getDb().close()
  rmSync(dbPath)
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
})
