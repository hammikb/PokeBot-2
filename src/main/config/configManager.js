import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('ConfigManager')

/**
 * Config file manager for power users
 * Supports JSON and YAML formats
 * Inspired by BestBuy-Walmart-Bot config system
 */
export class ConfigManager {
  constructor() {
    this.configDir = join(app.getPath('userData'), 'config')
    this.defaultConfigPath = join(this.configDir, 'pokebot.config.json')
  }

  /**
   * Load config from file
   */
  loadConfig(filePath = this.defaultConfigPath) {
    try {
      if (!existsSync(filePath)) {
        log.info('No config file found', { filePath })
        return null
      }

      const content = readFileSync(filePath, 'utf-8')
      const config = JSON.parse(content)

      log.info('Config loaded successfully', { 
        filePath, 
        accounts: config.accounts?.length || 0,
        tasks: config.tasks?.length || 0
      })

      return this.validateConfig(config)
    } catch (error) {
      log.error('Failed to load config', { filePath, error: error.message })
      throw new Error(`Failed to load config: ${error.message}`)
    }
  }

  /**
   * Save config to file
   */
  saveConfig(config, filePath = this.defaultConfigPath) {
    try {
      const validated = this.validateConfig(config)
      const content = JSON.stringify(validated, null, 2)
      
      writeFileSync(filePath, content, 'utf-8')
      
      log.info('Config saved successfully', { filePath })
      return true
    } catch (error) {
      log.error('Failed to save config', { filePath, error: error.message })
      throw new Error(`Failed to save config: ${error.message}`)
    }
  }

  /**
   * Export current database state to config file
   */
  async exportToConfig(getDb, accountManager) {
    try {
      const db = getDb()
      
      // Get all accounts (decrypted)
      const accounts = accountManager.getAll().map(account => {
        const decrypted = accountManager.getDecrypted(account.id)
        return {
          name: decrypted.name,
          retailer: decrypted.retailer,
          email: decrypted.username,
          password: decrypted.password,
          cvv: decrypted.cvv || '',
          proxy: decrypted.proxy || '',
          shipping: JSON.parse(decrypted.shipping_json || '{}')
        }
      })

      // Get all tasks
      const tasks = db.prepare('SELECT * FROM tasks').all().map(task => ({
        retailer: task.retailer,
        productUrl: task.product_url,
        productName: task.product_name,
        buyLimit: task.buy_limit,
        maxPrice: task.max_price,
        mode: task.mode,
        accountIds: JSON.parse(task.account_ids || '[]'),
        intervalMs: task.interval_ms
      }))

      // Get settings
      const settingsRows = db.prepare('SELECT key, value FROM settings').all()
      const settings = Object.fromEntries(
        settingsRows.map(r => [r.key, JSON.parse(r.value)])
      )

      const config = {
        version: '1.0',
        accounts,
        tasks,
        settings
      }

      this.saveConfig(config)
      
      log.info('Exported to config', { 
        accounts: accounts.length, 
        tasks: tasks.length 
      })

      return { success: true, path: this.defaultConfigPath }
    } catch (error) {
      log.error('Export failed', { error: error.message })
      return { success: false, error: error.message }
    }
  }

  /**
   * Import config file into database
   */
  async importFromConfig(filePath, getDb, accountManager) {
    try {
      const config = this.loadConfig(filePath)
      if (!config) {
        throw new Error('No config to import')
      }

      const db = getDb()
      let imported = { accounts: 0, tasks: 0, settings: 0 }

      // Import accounts
      for (const account of config.accounts || []) {
        try {
          await accountManager.create({
            name: account.name,
            retailer: account.retailer,
            username: account.email,
            password: account.password,
            cvv: account.cvv || '',
            proxy: account.proxy || '',
            shipping: account.shipping || {}
          })
          imported.accounts++
        } catch (error) {
          log.warn('Failed to import account', { 
            name: account.name, 
            error: error.message 
          })
        }
      }

      // Import tasks
      for (const task of config.tasks || []) {
        try {
          const { randomUUID } = await import('crypto')
          db.prepare(`
            INSERT INTO tasks (
              id, retailer, product_url, product_name, 
              buy_limit, max_price, mode, account_ids, interval_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            task.retailer,
            task.productUrl,
            task.productName || null,
            task.buyLimit || 1,
            task.maxPrice || null,
            task.mode || 'monitor-and-buy',
            JSON.stringify(task.accountIds || []),
            task.intervalMs || 4000
          )
          imported.tasks++
        } catch (error) {
          log.warn('Failed to import task', { 
            url: task.productUrl, 
            error: error.message 
          })
        }
      }

      // Import settings
      for (const [key, value] of Object.entries(config.settings || {})) {
        try {
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .run(key, JSON.stringify(value))
          imported.settings++
        } catch (error) {
          log.warn('Failed to import setting', { key, error: error.message })
        }
      }

      log.info('Import completed', imported)
      return { success: true, imported }
    } catch (error) {
      log.error('Import failed', { error: error.message })
      return { success: false, error: error.message }
    }
  }

  /**
   * Validate config structure
   */
  validateConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Config must be an object')
    }

    // Validate accounts
    if (config.accounts && !Array.isArray(config.accounts)) {
      throw new Error('accounts must be an array')
    }

    for (const account of config.accounts || []) {
      if (!account.retailer || !account.email || !account.password) {
        throw new Error('Account missing required fields: retailer, email, password')
      }
    }

    // Validate tasks
    if (config.tasks && !Array.isArray(config.tasks)) {
      throw new Error('tasks must be an array')
    }

    for (const task of config.tasks || []) {
      if (!task.retailer || !task.productUrl) {
        throw new Error('Task missing required fields: retailer, productUrl')
      }
    }

    return config
  }

  /**
   * Create example config file
   */
  createExampleConfig() {
    const example = {
      version: '1.0',
      accounts: [
        {
          name: 'walmart-example',
          retailer: 'walmart',
          email: 'user@example.com',
          password: 'your-password',
          cvv: '123',
          proxy: '1.2.3.4:8080:user:pass',
          shipping: {
            firstName: 'John',
            lastName: 'Doe',
            address1: '123 Main St',
            address2: 'Apt 4',
            city: 'New York',
            state: 'NY',
            zip: '10001',
            phone: '5551234567'
          }
        }
      ],
      tasks: [
        {
          retailer: 'walmart',
          productUrl: 'https://www.walmart.com/ip/Pokemon-Cards/123456',
          productName: 'Pokemon Booster Pack',
          buyLimit: 2,
          maxPrice: 50,
          mode: 'auto-checkout',
          accountIds: ['walmart-example'],
          intervalMs: 4000
        }
      ],
      settings: {
        maxConcurrent: 3,
        notifySound: true,
        notifyDesktop: true
      }
    }

    const examplePath = join(this.configDir, 'example.config.json')
    this.saveConfig(example, examplePath)
    
    log.info('Example config created', { path: examplePath })
    return examplePath
  }
}
