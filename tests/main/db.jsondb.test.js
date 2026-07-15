import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { JsonDb } from '../../src/main/db.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync, readFileSync, writeFileSync, existsSync } from 'fs'

// These tests target the JSON fallback storage directly. The regular db tests
// exercise better-sqlite3 when it loads (it does under plain Node in CI/vitest),
// which is exactly why the fallback's upsert bugs went unnoticed: the packaged
// Electron app on this machine failed the native rebuild and runs JsonDb.

let dbPath
let db

beforeEach(() => {
  dbPath = join(tmpdir(), `pokebot-jsondb-test-${Date.now()}-${Math.random()}.json`)
  db = new JsonDb(dbPath)
})

afterEach(() => {
  db.close()
  if (existsSync(dbPath)) rmSync(dbPath)
})

describe('JsonDb ON CONFLICT upserts', () => {
  it('ON CONFLICT(id) DO UPDATE updates the existing row instead of appending a duplicate', () => {
    const sql = `INSERT INTO product_monitors
        (id, product_key, name, image_url, category, catalog_msrp, action_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        product_key = excluded.product_key,
        name = excluded.name,
        image_url = excluded.image_url,
        category = excluded.category,
        catalog_msrp = excluded.catalog_msrp,
        action_mode = excluded.action_mode,
        updated_at = excluded.updated_at`
    db.prepare(sql).run('m1', 'key-1', 'First name', null, null, 49.99, 'auto-checkout', 111, 111)
    db.prepare(sql).run('m1', 'key-1', 'Second name', null, null, 39.99, 'alert-only', 222, 222)

    const rows = db.prepare('SELECT * FROM product_monitors').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Second name')
    expect(rows[0].catalog_msrp).toBe(39.99)
    expect(rows[0].action_mode).toBe('alert-only')
  })

  it('ON CONFLICT(id) DO UPDATE preserves columns not listed in the SET clause', () => {
    const sql = `INSERT INTO product_monitors
        (id, product_key, name, image_url, category, catalog_msrp, action_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        updated_at = excluded.updated_at`
    db.prepare(sql).run('m1', 'key-1', 'First name', null, null, 49.99, 'auto-checkout', 111, 111)
    db.prepare(sql).run('m1', 'key-1', 'Second name', null, null, 39.99, 'alert-only', 222, 222)

    const row = db.prepare('SELECT * FROM product_monitors WHERE id = ?').get('m1')
    expect(row.name).toBe('Second name')
    expect(row.updated_at).toBe(222)
    // Not in the SET list — SQLite keeps the original values, so must we.
    expect(row.created_at).toBe(111)
    expect(row.catalog_msrp).toBe(49.99)
  })

  it('ON CONFLICT with a composite key matches on every conflict column', () => {
    const sql = `INSERT INTO monitor_sources
        (id, monitor_id, retailer, product_url, price_ceiling, buy_limit, account_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitor_id, retailer) DO UPDATE SET
        product_url = excluded.product_url,
        price_ceiling = excluded.price_ceiling,
        updated_at = excluded.updated_at`
    db.prepare(sql).run('s1', 'm1', 'target', 'https://t/1', 50, 2, '[]', 111, 111)
    db.prepare(sql).run('s2', 'm1', 'walmart', 'https://w/1', 55, 5, '[]', 111, 111)
    // Same (monitor_id, retailer) as the first row — must update it, not append.
    db.prepare(sql).run('s3', 'm1', 'target', 'https://t/2', 45, 2, '[]', 222, 222)

    const rows = db.prepare('SELECT * FROM monitor_sources').all()
    expect(rows).toHaveLength(2)
    const target = rows.find((row) => row.retailer === 'target')
    expect(target.product_url).toBe('https://t/2')
    expect(target.price_ceiling).toBe(45)
    expect(target.id).toBe('s1')
  })
})

describe('JsonDb SELECT with AND-chained WHERE', () => {
  it('filters on every condition, not just the first', () => {
    const insert = db.prepare(
      'INSERT INTO monitor_sources (id, monitor_id, retailer) VALUES (?, ?, ?)'
    )
    insert.run('s1', 'm1', 'target')
    insert.run('s2', 'm1', 'walmart')

    const row = db
      .prepare('SELECT * FROM monitor_sources WHERE monitor_id = ? AND retailer = ?')
      .get('m1', 'walmart')
    expect(row.id).toBe('s2')
  })
})

describe('JsonDb load-time repair', () => {
  it('dedupes rows sharing a primary key, keeping the most recent', () => {
    // Flush a real (empty) db file first so the fixture has the full table
    // structure isJsonDbFile expects, then corrupt the tasks table the same
    // way the old append-instead-of-upsert bug did.
    db.close()
    const tables = JSON.parse(readFileSync(dbPath, 'utf8'))
    tables.tasks = [
      { id: 't1', retailer: 'target', product_name: 'Old copy' },
      { id: 't1', retailer: 'target', product_name: 'Newest copy' },
      { id: 't2', retailer: 'target', product_name: 'Unrelated' }
    ]
    writeFileSync(dbPath, JSON.stringify(tables))

    db = new JsonDb(dbPath)
    const rows = db.prepare('SELECT * FROM tasks').all()
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === 't1').product_name).toBe('Newest copy')
  })
})
