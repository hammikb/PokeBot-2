import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('Migrations')

// Migration definitions - each migration has a version number and up/down functions
const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
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
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER DEFAULT (strftime('%s','now'))
        );
      `)
    }
  },
  {
    version: 2,
    name: 'add_rate_limiting',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          id TEXT PRIMARY KEY,
          retailer TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          last_request INTEGER,
          request_count INTEGER DEFAULT 0,
          window_start INTEGER,
          UNIQUE(retailer, endpoint)
        );
      `)
    }
  }
]

export function getCurrentVersion(db) {
  try {
    const result = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
    return result?.version || 0
  } catch {
    return 0
  }
}

export function runMigrations(db) {
  const currentVersion = getCurrentVersion(db)
  log.info('Checking migrations', { currentVersion })

  const pendingMigrations = migrations.filter((m) => m.version > currentVersion)

  if (pendingMigrations.length === 0) {
    log.info('Database is up to date')
    return
  }

  log.info('Running migrations', { count: pendingMigrations.length })

  for (const migration of pendingMigrations) {
    try {
      log.info('Applying migration', { version: migration.version, name: migration.name })
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      )
      log.info('Migration applied successfully', {
        version: migration.version,
        name: migration.name
      })
    } catch (err) {
      log.error('Migration failed', {
        version: migration.version,
        name: migration.name,
        error: err.message
      })
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${err.message}`)
    }
  }

  log.info('All migrations completed successfully')
}

export function getMigrationHistory(db) {
  try {
    return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
  } catch {
    return []
  }
}
