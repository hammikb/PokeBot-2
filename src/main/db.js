import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { runMigrations } from './db/migrations.js'
import { createModuleLogger } from './utils/logger.js'

const require = createRequire(import.meta.url)
const log = createModuleLogger('Database')

const TABLE_COLUMNS = {
  schema_migrations: ['version', 'name', 'applied_at'],
  rate_limits: ['id', 'retailer', 'endpoint', 'last_request', 'request_count', 'window_start'],
  accounts: [
    'id',
    'name',
    'retailer',
    'username',
    'password_enc',
    'cvv_enc',
    'proxy',
    'profile_path',
    'shipping_json',
    'payment_method_id',
    'status',
    'created_at'
  ],
  tasks: [
    'id',
    'retailer',
    'product_url',
    'product_name',
    'product_image_url',
    'buy_limit',
    'orders_per_drop',
    'max_price',
    'mode',
    'account_ids',
    'interval_ms',
    'status',
    'created_at'
  ],
  settings: ['key', 'value'],
  payment_methods: [
    'id',
    'name',
    'card_number_enc',
    'expiry_month',
    'expiry_year',
    'cvv_enc',
    'billing_address1',
    'billing_address2',
    'billing_city',
    'billing_state',
    'billing_zip',
    'billing_phone',
    'created_at'
  ],
  shipping_addresses: [
    'id',
    'name',
    'first_name',
    'last_name',
    'address1',
    'address2',
    'city',
    'state',
    'zip',
    'phone',
    'is_default',
    'created_at'
  ],
  drop_history: [
    'id',
    'retailer',
    'product_name',
    'product_url',
    'drop_type',
    'price',
    'result',
    'account_id',
    'timestamp'
  ],
  product_catalog: [
    'id',
    'retailer',
    'retailer_item_id',
    'id_type',
    'product_url',
    'title',
    'brand',
    'category',
    'image_url',
    'msrp',
    'current_price',
    'formatted_current_price',
    'availability',
    'seller',
    'retailer_owned_listing',
    'fresh_stock_confidence',
    'tags_json',
    'status',
    'last_checked_at',
    'created_at',
    'updated_at'
  ],
  catalog_walmart_matches: [
    'target_product_key',
    'walmart_item_id',
    'walmart_url',
    'walmart_name',
    'confidence',
    'created_at'
  ],
  walmart_match_search_cache: ['query_key', 'candidates_json', 'expires_at', 'created_at'],
  catalog_walmart_skips: ['target_product_key', 'reason', 'created_at'],
  product_monitors: [
    'id',
    'product_key',
    'name',
    'image_url',
    'category',
    'catalog_msrp',
    'action_mode',
    'created_at',
    'updated_at'
  ],
  monitor_sources: [
    'id',
    'monitor_id',
    'retailer',
    'product_url',
    'retailer_item_id',
    'msrp',
    'current_price',
    'price_ceiling',
    'buy_limit',
    'orders_per_drop',
    'account_ids',
    'action_mode',
    'enabled',
    'verification_status',
    'task_id',
    'created_at',
    'updated_at'
  ],
  checkout_attempts: [
    'id',
    'user_id',
    'device_ref',
    'task_id',
    'retailer',
    'product_key',
    'product_name',
    'mode',
    'experiment_json',
    'account_ref',
    'started_at',
    'completed_at',
    'duration_ms',
    'outcome',
    'final_stage',
    'failure_stage',
    'failure_code',
    'error_summary',
    'event_count',
    'upload_status',
    'uploaded_at'
  ],
  checkout_attempt_events: [
    'id',
    'attempt_id',
    'sequence',
    'stage',
    'detail',
    'elapsed_ms',
    'created_at'
  ]
}

let db

export function initDb(dbPath) {
  if (db) db.close()
  log.info('Initializing database', { dbPath })
  db = createSqliteDb(dbPath) || new JsonDb(dbPath)
  db.pragma('journal_mode = WAL')

  // Run migrations first
  try {
    runMigrations(db)
  } catch (err) {
    log.error('Migration failed', { error: err.message })
    throw err
  }

  // Legacy schema creation for backward compatibility
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      retailer TEXT NOT NULL,
      username TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      cvv_enc TEXT,
      proxy TEXT,
      profile_path TEXT,
      shipping_json TEXT,
      payment_method_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      retailer TEXT NOT NULL,
      product_url TEXT NOT NULL,
      product_name TEXT,
      product_image_url TEXT,
      buy_limit INTEGER DEFAULT 1,
      orders_per_drop INTEGER NOT NULL DEFAULT 1,
      max_price REAL,
      mode TEXT NOT NULL,
      account_ids TEXT NOT NULL,
      interval_ms INTEGER DEFAULT 4000,
      status TEXT DEFAULT 'idle',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drop_history (
      id TEXT PRIMARY KEY,
      retailer TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_url TEXT NOT NULL,
      drop_type TEXT NOT NULL,
      price REAL,
      result TEXT,
      account_id TEXT,
      timestamp INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS product_catalog (
      id TEXT PRIMARY KEY,
      retailer TEXT NOT NULL,
      retailer_item_id TEXT NOT NULL,
      id_type TEXT NOT NULL,
      product_url TEXT NOT NULL,
      title TEXT NOT NULL,
      brand TEXT,
      category TEXT,
      image_url TEXT,
      msrp REAL,
      current_price REAL,
      formatted_current_price TEXT,
      availability TEXT,
      seller TEXT,
      retailer_owned_listing INTEGER,
      fresh_stock_confidence TEXT,
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL,
      last_checked_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(retailer, retailer_item_id)
    );
  `)

  const taskColumns = db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .map((column) => column.name)
  if (!taskColumns.includes('product_image_url')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN product_image_url TEXT').run()
  }
  if (!taskColumns.includes('buy_limit')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN buy_limit INTEGER DEFAULT 1').run()
  }
  if (!taskColumns.includes('orders_per_drop')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN orders_per_drop INTEGER NOT NULL DEFAULT 1').run()
  }

  const accountColumns = db
    .prepare('PRAGMA table_info(accounts)')
    .all()
    .map((column) => column.name)
  if (!accountColumns.includes('status')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'").run()
  }
}

export function getDb() {
  if (!db) throw new Error('Database not initialised - call initDb() first')
  return db
}

function createSqliteDb(dbPath) {
  // Early packaged builds stored JSON directly at the `.db` path. Passing that
  // file to SQLite produces a noisy "file is not a database" warning on every
  // launch even though the adjacent JSON fallback contains the live data.
  if (looksLikeJsonDatabase(dbPath)) {
    log.info('Using legacy JSON database store', { dbPath: getJsonDbPath(dbPath) })
    return null
  }

  let candidate
  try {
    const Database = require('better-sqlite3')
    candidate = new Database(dbPath)

    // better-sqlite3 opens some malformed/legacy files successfully and only
    // reports "file is not a database" on the first pragma or query. Validate
    // here so initDb can still select the JSON store used by older installs.
    candidate.pragma('user_version')
    return candidate
  } catch (err) {
    try {
      candidate?.close()
    } catch {
      // The failed handle may already be closed.
    }
    console.warn(`Using JSON database fallback: ${firstLine(err.message)}`)
    return null
  }
}

export class JsonDb {
  constructor(dbPath) {
    this.path = getJsonDbPath(dbPath)
    this.tables = loadTables(this.path)
    this._flushTimer = null
    this._flushDelay = 1000 // Debounce writes by 1 second
  }

  pragma() {}

  exec() {
    this._flush()
  }

  close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._flushImmediate()
  }

  prepare(sql) {
    return new JsonStatement(this, sql)
  }

  _flush() {
    // Debounce writes to improve performance
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
    }
    this._flushTimer = setTimeout(() => {
      this._flushImmediate()
      this._flushTimer = null
    }, this._flushDelay)
  }

  _flushImmediate() {
    try {
      writeFileSync(this.path, JSON.stringify(this.tables, null, 2))
    } catch (err) {
      log.error('Failed to write JSON database', { path: this.path, error: err.message })
    }
  }
}

class JsonStatement {
  constructor(db, sql) {
    this.db = db
    this.sql = sql.trim().replace(/\s+/g, ' ')
  }

  all(...args) {
    if (this.sql.startsWith('PRAGMA table_info(')) {
      const table = this.sql.match(/PRAGMA table_info\(([^)]+)\)/)?.[1]
      return (TABLE_COLUMNS[table] || []).map((name, cid) => ({ cid, name }))
    }
    if (this.sql.includes('sqlite_master')) {
      const table = this.sql.match(/name='([^']+)'/)?.[1]
      return table && this.db.tables[table] ? [{ name: table }] : []
    }
    return this._select(args)
  }

  get(...args) {
    return this.all(...args)[0]
  }

  run(...args) {
    if (this.sql.startsWith('ALTER TABLE')) return this._ok()
    if (this.sql.startsWith('INSERT')) return this._insert(args)
    if (this.sql.startsWith('UPDATE')) return this._update(args)
    if (this.sql.startsWith('DELETE')) return this._delete(args)
    return this._ok()
  }

  _select(args) {
    const maxMatch = this.sql.match(/^SELECT MAX\((\w+)\) as (\w+) FROM (\w+)$/i)
    if (maxMatch) {
      const [, column, alias, table] = maxMatch
      const values = (this.db.tables[table] || [])
        .map((row) => Number(row[column]))
        .filter(Number.isFinite)
      return [{ [alias]: values.length ? Math.max(...values) : null }]
    }

    const match = this.sql.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY .+)?$/)
    if (!match) return []

    const [, fields, table, whereClause] = match
    let rows = [...(this.db.tables[table] || [])]
    if (whereClause) {
      // Only simple `col = ?` conditions joined by AND — everything this app's
      // SQL actually uses. Placeholders map to args in order of appearance.
      const matchesWhere = buildJsonWherePredicate(whereClause, args)
      if (!matchesWhere) return []
      rows = rows.filter(matchesWhere)
    }
    if (fields === '*') return rows.map((row) => ({ ...row }))

    const columns = fields.split(',').map((field) => field.trim())
    return rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))
    )
  }

  _insert(args) {
    const match = this.sql.match(/^INSERT(?: OR REPLACE)? INTO (\w+) \(([^)]+)\)/)
    if (!match) return this._ok()

    const [, table, columnList] = match
    const columns = columnList.split(',').map((column) => column.trim())
    const row = Object.fromEntries(columns.map((column, index) => [column, args[index] ?? null]))
    applyDefaults(table, row)

    // INSERT ... ON CONFLICT(cols) DO UPDATE SET a = excluded.a, ... — upsert.
    // Without this branch every "update" from MONITORS_SAVE appended a duplicate
    // row with the same id, which is exactly what real SQLite's conflict clause
    // prevents. Match on every conflict column; update only the SET-listed
    // columns (SQLite preserves the rest, e.g. created_at, so we must too).
    const conflict = this.sql.match(/ON CONFLICT\s*\(([^)]+)\)\s*DO UPDATE SET\s+(.+)$/i)
    if (conflict) {
      const conflictColumns = conflict[1].split(',').map((column) => column.trim())
      const setColumns = conflict[2]
        .split(',')
        .map((clause) => clause.match(/^\s*(\w+)\s*=\s*excluded\.\w+\s*$/i)?.[1])
        .filter(Boolean)
      const existing = (this.db.tables[table] || []).find((candidate) =>
        conflictColumns.every((column) => candidate[column] === row[column])
      )
      if (existing) {
        for (const column of setColumns) existing[column] = row[column]
        this.db._flush()
        return this._ok(1)
      }
    }

    if (this.sql.startsWith('INSERT OR REPLACE')) {
      const primaryKey = tablePrimaryKey(table)
      this.db.tables[table] = this.db.tables[table].filter(
        (existing) => existing[primaryKey] !== row[primaryKey]
      )
    }

    this.db.tables[table].push(row)
    this.db._flush()
    return this._ok(1)
  }

  _update(args) {
    const match = this.sql.match(/^UPDATE (\w+) SET (.+?)(?: WHERE (.+))?$/i)
    if (!match) return this._ok()

    const [, table, setClause, whereClause] = match
    const assignments = setClause.split(',').map((clause) => clause.trim())
    let argumentIndex = 0
    const setters = assignments.map((assignment) => {
      let valueMatch = assignment.match(/^(\w+)\s*=\s*\?$/i)
      if (valueMatch) {
        const argument = argumentIndex++
        return { column: valueMatch[1], valueFor: () => args[argument] }
      }

      valueMatch = assignment.match(/^(\w+)\s*=\s*'(.*)'$/i)
      if (valueMatch) return { column: valueMatch[1], valueFor: () => valueMatch[2] }

      valueMatch = assignment.match(/^(\w+)\s*=\s*(-?\d+(?:\.\d+)?)$/i)
      if (valueMatch) return { column: valueMatch[1], valueFor: () => Number(valueMatch[2]) }

      valueMatch = assignment.match(/^(\w+)\s*=\s*(\w+)\s*\+\s*(-?\d+(?:\.\d+)?)$/i)
      if (valueMatch) {
        return {
          column: valueMatch[1],
          valueFor: (row) => Number(row[valueMatch[2]] || 0) + Number(valueMatch[3])
        }
      }

      return null
    })
    if (setters.some((setter) => !setter)) return this._ok()

    const whereArguments = args.slice(argumentIndex)
    const matchesWhere = buildJsonWherePredicate(whereClause, whereArguments)
    if (!matchesWhere) return this._ok()

    let changes = 0
    for (const row of this.db.tables[table] || []) {
      if (!matchesWhere(row)) continue
      for (const setter of setters) row[setter.column] = setter.valueFor(row)
      changes += 1
    }
    this.db._flush()
    return this._ok(changes)
  }

  _delete(args) {
    const match = this.sql.match(/^DELETE FROM (\w+) WHERE (\w+) = \?/)
    if (!match) return this._ok()

    const [, table, whereColumn] = match
    const before = this.db.tables[table].length
    this.db.tables[table] = this.db.tables[table].filter((row) => row[whereColumn] !== args[0])
    this.db._flush()
    return this._ok(before - this.db.tables[table].length)
  }

  _ok(changes = 0) {
    return { changes }
  }
}

function buildJsonWherePredicate(whereClause, args = []) {
  if (!whereClause) return () => true
  let argumentIndex = 0
  const predicates = whereClause.split(/\s+AND\s+/i).map((part) => {
    const condition = part.trim()
    let match = condition.match(/^(\w+)\s*(=|>)\s*\?$/i)
    if (match) {
      const argument = argumentIndex++
      return (row) =>
        match[2] === '>' ? row[match[1]] > args[argument] : row[match[1]] === args[argument]
    }

    match = condition.match(/^(\w+)\s*=\s*'(.*)'$/i)
    if (match) return (row) => row[match[1]] === match[2]

    match = condition.match(/^(\w+)\s*=\s*(-?\d+(?:\.\d+)?)$/i)
    if (match) return (row) => row[match[1]] === Number(match[2])

    match = condition.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i)
    if (match) {
      return match[2]
        ? (row) => row[match[1]] !== null && row[match[1]] !== undefined
        : (row) => row[match[1]] === null || row[match[1]] === undefined
    }

    return null
  })
  if (predicates.some((predicate) => !predicate)) return null
  return (row) => predicates.every((predicate) => predicate(row))
}

function tablePrimaryKey(table) {
  if (table === 'settings') return 'key'
  if (table === 'catalog_walmart_matches') return 'target_product_key'
  if (table === 'walmart_match_search_cache') return 'query_key'
  if (table === 'catalog_walmart_skips') return 'target_product_key'
  return 'id'
}

function loadTables(path) {
  const tables = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  for (const table of Object.keys(TABLE_COLUMNS)) {
    tables[table] ||= []
  }
  // Repair duplicate primary keys left behind by the pre-upsert _insert bug
  // (ON CONFLICT statements used to append instead of update). Keep the last
  // occurrence — it carries the most recent save.
  for (const [table, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) continue
    const primaryKey = tablePrimaryKey(table)
    const byKey = new Map()
    for (const row of rows) byKey.set(row[primaryKey], row)
    if (byKey.size !== rows.length) tables[table] = [...byKey.values()]
  }
  return tables
}

function getJsonDbPath(dbPath) {
  if (!existsSync(dbPath) || isJsonDbFile(dbPath)) return dbPath
  return `${dbPath}.json`
}

function isJsonDbFile(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return (
      data && typeof data === 'object' && Object.keys(TABLE_COLUMNS).every((table) => table in data)
    )
  } catch {
    return false
  }
}

function looksLikeJsonDatabase(path) {
  if (!existsSync(path)) return false
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    return Object.keys(data).some(
      (table) => Object.hasOwn(TABLE_COLUMNS, table) && Array.isArray(data[table])
    )
  } catch {
    return false
  }
}

function firstLine(value) {
  return String(value).split(/\r?\n/)[0]
}

function applyDefaults(table, row) {
  const now = Math.floor(Date.now() / 1000)
  if (table === 'accounts') {
    row.created_at ??= now
    row.status ??= 'active'
  }
  if (table === 'tasks') {
    row.status ??= 'idle'
    row.created_at ??= now
  }
  if (table === 'drop_history') row.timestamp ??= now
  if (table === 'product_catalog') {
    row.created_at ??= now
    row.updated_at ??= now
    row.status ??= 'active'
  }
  if (table === 'catalog_walmart_matches') row.created_at ??= now
  if (table === 'catalog_walmart_skips') row.created_at ??= now
}
