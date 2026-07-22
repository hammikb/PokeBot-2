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
  },
  {
    version: 3,
    name: 'add_payment_and_shipping',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_methods (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          card_number_enc TEXT NOT NULL,
          expiry_month TEXT NOT NULL,
          expiry_year TEXT NOT NULL,
          cvv_enc TEXT NOT NULL,
          billing_address1 TEXT,
          billing_address2 TEXT,
          billing_city TEXT,
          billing_state TEXT,
          billing_zip TEXT,
          billing_phone TEXT,
          created_at TEXT NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS shipping_addresses (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          address1 TEXT NOT NULL,
          address2 TEXT,
          city TEXT NOT NULL,
          state TEXT NOT NULL,
          zip TEXT NOT NULL,
          phone TEXT,
          is_default INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 4,
    name: 'add_thumbnails_and_alerts',
    up: (db) => {
      db.exec(`
        -- Add thumbnail_path column to tasks
        ALTER TABLE tasks ADD COLUMN thumbnail_path TEXT;
        
        -- Create alert history table for acknowledgment system
        CREATE TABLE IF NOT EXISTS alert_history (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          alert_type TEXT NOT NULL,
          product_name TEXT,
          product_url TEXT,
          price REAL,
          seen INTEGER DEFAULT 0,
          acknowledged_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_alert_history_task ON alert_history(task_id);
        CREATE INDEX IF NOT EXISTS idx_alert_history_seen ON alert_history(seen);
        CREATE INDEX IF NOT EXISTS idx_alert_history_created ON alert_history(created_at);
      `)
    }
  },
  {
    version: 5,
    name: 'add_catalog_walmart_matches',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_walmart_matches (
          target_product_key TEXT PRIMARY KEY,
          walmart_item_id TEXT NOT NULL,
          walmart_url TEXT NOT NULL,
          walmart_name TEXT,
          confidence TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        );
      `)
    }
  },
  {
    version: 6,
    name: 'add_product_monitors_and_retailer_sources',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_monitors (
          id TEXT PRIMARY KEY,
          product_key TEXT,
          name TEXT NOT NULL,
          image_url TEXT,
          category TEXT,
          catalog_msrp REAL,
          action_mode TEXT NOT NULL DEFAULT 'auto-checkout',
          created_at INTEGER DEFAULT (strftime('%s','now')),
          updated_at INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS monitor_sources (
          id TEXT PRIMARY KEY,
          monitor_id TEXT NOT NULL,
          retailer TEXT NOT NULL,
          product_url TEXT,
          retailer_item_id TEXT,
          msrp REAL,
          current_price REAL,
          price_ceiling REAL,
          buy_limit INTEGER NOT NULL DEFAULT 1,
          account_ids TEXT NOT NULL DEFAULT '[]',
          action_mode TEXT NOT NULL DEFAULT 'auto-checkout',
          enabled INTEGER NOT NULL DEFAULT 0,
          verification_status TEXT NOT NULL DEFAULT 'unverified',
          task_id TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          updated_at INTEGER DEFAULT (strftime('%s','now')),
          UNIQUE(monitor_id, retailer),
          FOREIGN KEY (monitor_id) REFERENCES product_monitors(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_monitor_sources_monitor ON monitor_sources(monitor_id);
        CREATE INDEX IF NOT EXISTS idx_monitor_sources_task ON monitor_sources(task_id);
      `)
    }
  },
  {
    version: 7,
    name: 'add_walmart_match_search_cache',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS walmart_match_search_cache (
          query_key TEXT PRIMARY KEY,
          candidates_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_walmart_match_cache_expires
          ON walmart_match_search_cache(expires_at);
      `)
    }
  },
  {
    version: 8,
    name: 'add_walmart_match_skips',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_walmart_skips (
          target_product_key TEXT PRIMARY KEY,
          reason TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        );
      `)
    }
  },
  {
    version: 9,
    name: 'add_checkout_telemetry',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkout_attempts (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          device_ref TEXT NOT NULL,
          task_id TEXT,
          retailer TEXT NOT NULL,
          product_key TEXT,
          product_name TEXT,
          mode TEXT NOT NULL,
          experiment_json TEXT NOT NULL DEFAULT '{}',
          account_ref TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          duration_ms INTEGER,
          outcome TEXT NOT NULL DEFAULT 'running',
          final_stage TEXT NOT NULL DEFAULT 'drop_detected',
          failure_stage TEXT,
          failure_code TEXT,
          error_summary TEXT,
          event_count INTEGER NOT NULL DEFAULT 0,
          upload_status TEXT NOT NULL DEFAULT 'pending',
          uploaded_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS checkout_attempt_events (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          stage TEXT NOT NULL,
          detail TEXT,
          elapsed_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(attempt_id, sequence),
          FOREIGN KEY (attempt_id) REFERENCES checkout_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_checkout_attempts_started
          ON checkout_attempts(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_checkout_attempts_upload
          ON checkout_attempts(upload_status, completed_at);
        CREATE INDEX IF NOT EXISTS idx_checkout_events_attempt
          ON checkout_attempt_events(attempt_id, sequence);
      `)
    }
  },
  {
    version: 10,
    name: 'remove_remote_notification_credentials',
    up: (db) => {
      const removeSetting = db.prepare('DELETE FROM settings WHERE key = ?')
      for (const key of ['discordWebhook', 'twilioSid', 'twilioToken', 'twilioFrom', 'twilioTo']) {
        removeSetting.run(key)
      }
    }
  },
  {
    version: 11,
    name: 'assign_payment_methods_to_accounts',
    up: (db) => {
      db.exec('ALTER TABLE accounts ADD COLUMN payment_method_id TEXT;')

      // Preserve the previous global Target verification card by assigning it
      // to Target accounts that do not yet have an explicit payment method.
      const legacy = db
        .prepare('SELECT * FROM settings WHERE key = ?')
        .get('targetVerificationPaymentMethodId')
      let legacyPaymentMethodId = ''
      try {
        legacyPaymentMethodId = JSON.parse(legacy?.value || '""')
      } catch {
        legacyPaymentMethodId = ''
      }
      if (legacyPaymentMethodId) {
        const update = db.prepare('UPDATE accounts SET payment_method_id = ? WHERE id = ?')
        for (const account of db.prepare('SELECT * FROM accounts').all()) {
          if (account.retailer === 'target' && !account.payment_method_id) {
            update.run(legacyPaymentMethodId, account.id)
          }
        }
      }
      db.prepare('DELETE FROM settings WHERE key = ?').run('targetVerificationPaymentMethodId')
    }
  },
  {
    version: 12,
    name: 'add_orders_per_drop',
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN orders_per_drop INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE monitor_sources ADD COLUMN orders_per_drop INTEGER NOT NULL DEFAULT 1;
      `)
    }
  },
  {
    version: 13,
    name: 'persist_task_runtime_state',
    up: (db) => {
      // Before this migration the app resumed every enabled retailer source,
      // regardless of tasks.status. Preserve that existing behavior once, then
      // explicit Start/Stop actions maintain the desired state going forward.
      const enabledSources = db.prepare('SELECT * FROM monitor_sources WHERE enabled = ?').all(1)
      const markMonitoring = db.prepare('UPDATE tasks SET status = ? WHERE id = ?')
      for (const source of enabledSources) {
        if (source.task_id) markMonitoring.run('monitoring', source.task_id)
      }
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
