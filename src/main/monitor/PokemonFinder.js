import axios from 'axios'
import { EventEmitter } from 'events'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('PokemonFinder')

/**
 * Automatically finds new Pokemon items on retailers
 */
export class PokemonFinder extends EventEmitter {
  constructor(getDb) {
    super()
    this._getDb = getDb
    this._ensureTable()
    this._knownItems = new Set()
    this._loadKnownItems()
  }

  /**
   * Ensure pokemon_items table exists
   */
  _ensureTable() {
    try {
      this._getDb().exec(`
        CREATE TABLE IF NOT EXISTS pokemon_items (
          id TEXT PRIMARY KEY,
          retailer TEXT NOT NULL,
          product_name TEXT NOT NULL,
          product_url TEXT NOT NULL,
          tcin TEXT,
          price REAL,
          discovered_at INTEGER DEFAULT (strftime('%s', 'now')),
          is_new INTEGER DEFAULT 1
        )
      `)
      this._getDb().exec(`
        CREATE INDEX IF NOT EXISTS idx_pokemon_retailer ON pokemon_items(retailer)
      `)
      this._getDb().exec(`
        CREATE INDEX IF NOT EXISTS idx_pokemon_new ON pokemon_items(is_new)
      `)
    } catch (err) {
      log.error('Failed to create pokemon_items table', { error: err.message })
    }
  }

  /**
   * Load known items from database
   */
  _loadKnownItems() {
    try {
      const items = this._getDb()
        .prepare('SELECT product_url FROM pokemon_items')
        .all()
      
      items.forEach(item => this._knownItems.add(item.product_url))
      log.info('Loaded known Pokemon items', { count: this._knownItems.size })
    } catch (err) {
      log.error('Failed to load known items', { error: err.message })
    }
  }

  /**
   * Start scanning for new Pokemon items
   */
  startScanning(intervalMinutes = 30) {
    log.info('Starting Pokemon item scanner', { intervalMinutes })
    
    // Scan immediately
    this.scanAll()
    
    // Then scan periodically
    this._scanTimer = setInterval(() => {
      this.scanAll()
    }, intervalMinutes * 60 * 1000)
  }

  /**
   * Stop scanning
   */
  stopScanning() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer)
      this._scanTimer = null
      log.info('Pokemon scanner stopped')
    }
  }

  /**
   * Scan all retailers
   */
  async scanAll() {
    log.info('Scanning for new Pokemon items...')
    
    const results = await Promise.allSettled([
      this.scanTarget(),
      this.scanWalmart()
    ])

    const newItems = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)

    if (newItems.length > 0) {
      log.info('Found new Pokemon items', { count: newItems.length })
      this.emit('newItems', newItems)
    } else {
      log.info('No new Pokemon items found')
    }

    return newItems
  }

  /**
   * Scan Target for Pokemon items
   */
  async scanTarget() {
    try {
      log.info('Scanning Target for Pokemon items...')
      
      // Target search API
      const { data } = await axios.get(
        'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2',
        {
          params: {
            key: 'ff457966e64d5e877fdbad070f276d18ecec4a01',
            channel: 'WEB',
            count: 24,
            offset: 0,
            page: '/s/pokemon+cards',
            pricing_store_id: '3991',
            useragent: 'Mozilla/5.0',
            visitor_id: Math.random().toString(36).substring(7),
            keyword: 'pokemon cards'
          },
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }
      )

      const products = data?.data?.search?.products || []
      const newItems = []

      for (const product of products) {
        const tcin = product.tcin
        const url = `https://www.target.com/p/-/A-${tcin}`
        const name = product.item?.product_description?.title || 'Unknown'
        const price = product.price?.current_retail

        // Check if this is a new item
        if (!this._knownItems.has(url)) {
          const item = {
            retailer: 'target',
            productName: name,
            productUrl: url,
            tcin,
            price
          }

          this._saveItem(item)
          this._knownItems.add(url)
          newItems.push(item)
          
          log.info('New Pokemon item found on Target', { name, tcin, price })
        }
      }

      return newItems
    } catch (err) {
      log.error('Target scan failed', { error: err.message })
      return []
    }
  }

  /**
   * Scan Walmart for Pokemon items
   */
  async scanWalmart() {
    try {
      log.info('Scanning Walmart for Pokemon items...')
      
      // Walmart search API
      const { data } = await axios.get(
        'https://www.walmart.com/orchestra/home/graphql/search',
        {
          params: {
            query: 'pokemon cards',
            page: 1,
            affinityOverride: 'default'
          },
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'WM_CONSUMER.ID': '0f3e4a3e-d47e-4d6e-9e6e-3c3e3e3e3e3e'
          }
        }
      )

      const products = data?.data?.search?.searchResult?.itemStacks?.[0]?.items || []
      const newItems = []

      for (const product of products) {
        const id = product.usItemId || product.id
        const url = `https://www.walmart.com/ip/${id}`
        const name = product.name || 'Unknown'
        const price = product.priceInfo?.currentPrice?.price

        // Check if this is a new item
        if (!this._knownItems.has(url)) {
          const item = {
            retailer: 'walmart',
            productName: name,
            productUrl: url,
            tcin: id,
            price
          }

          this._saveItem(item)
          this._knownItems.add(url)
          newItems.push(item)
          
          log.info('New Pokemon item found on Walmart', { name, id, price })
        }
      }

      return newItems
    } catch (err) {
      log.error('Walmart scan failed', { error: err.message })
      return []
    }
  }

  /**
   * Save item to database
   */
  _saveItem(item) {
    try {
      this._getDb()
        .prepare(`
          INSERT INTO pokemon_items (id, retailer, product_name, product_url, tcin, price)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          `${item.retailer}_${item.tcin}_${Date.now()}`,
          item.retailer,
          item.productName,
          item.productUrl,
          item.tcin,
          item.price
        )
    } catch (err) {
      log.error('Failed to save Pokemon item', { error: err.message })
    }
  }

  /**
   * Get all discovered items
   */
  getAllItems() {
    try {
      return this._getDb()
        .prepare('SELECT * FROM pokemon_items ORDER BY discovered_at DESC')
        .all()
    } catch {
      return []
    }
  }

  /**
   * Get new items (not yet seen)
   */
  getNewItems() {
    try {
      return this._getDb()
        .prepare('SELECT * FROM pokemon_items WHERE is_new = 1 ORDER BY discovered_at DESC')
        .all()
    } catch {
      return []
    }
  }

  /**
   * Mark item as seen
   */
  markAsSeen(id) {
    try {
      this._getDb()
        .prepare('UPDATE pokemon_items SET is_new = 0 WHERE id = ?')
        .run(id)
    } catch (err) {
      log.error('Failed to mark item as seen', { error: err.message })
    }
  }
}

/**
 * Create Pokemon finder instance
 */
export function createPokemonFinder(getDb) {
  return new PokemonFinder(getDb)
}
