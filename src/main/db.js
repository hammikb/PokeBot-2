import Database from 'better-sqlite3'

let db

export function initDb(dbPath) {
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
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
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      retailer TEXT NOT NULL,
      product_url TEXT NOT NULL,
      product_name TEXT,
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
  `)
}

export function getDb() {
  return db
}
