import { createModuleLogger } from './logger.js'

const log = createModuleLogger('RestockPredictor')

/**
 * ML-based restock prediction system
 */
export class RestockPredictor {
  constructor(getDb) {
    this._getDb = getDb
    this._ensureTable()
  }

  /**
   * Ensure restock history table exists
   */
  _ensureTable() {
    try {
      this._getDb().exec(`
        CREATE TABLE IF NOT EXISTS restock_history (
          id TEXT PRIMARY KEY,
          product_url TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          day_of_week INTEGER NOT NULL,
          hour INTEGER NOT NULL,
          stock_level INTEGER,
          price REAL,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)
      this._getDb().exec(`
        CREATE INDEX IF NOT EXISTS idx_restock_product ON restock_history(product_url)
      `)
      this._getDb().exec(`
        CREATE INDEX IF NOT EXISTS idx_restock_timestamp ON restock_history(timestamp)
      `)
    } catch (err) {
      log.error('Failed to create restock_history table', { error: err.message })
    }
  }

  /**
   * Record a restock event
   */
  recordRestock(productUrl, stockLevel = null, price = null) {
    try {
      const now = new Date()
      const timestamp = now.getTime()
      const dayOfWeek = now.getDay() // 0 = Sunday, 6 = Saturday
      const hour = now.getHours()

      this._getDb()
        .prepare(
          `
          INSERT INTO restock_history (id, product_url, timestamp, day_of_week, hour, stock_level, price)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          `restock_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
          productUrl,
          timestamp,
          dayOfWeek,
          hour,
          stockLevel,
          price
        )

      log.info('Restock recorded', { productUrl, dayOfWeek, hour })
    } catch (err) {
      log.error('Failed to record restock', { error: err.message })
    }
  }

  /**
   * Analyze restock patterns for a product
   */
  async analyzePatterns(productUrl) {
    try {
      const history = this._getHistory(productUrl)

      if (history.length < 3) {
        return {
          confidence: 'low',
          message: 'Not enough data (need at least 3 restocks)',
          patterns: null,
          nextPredicted: null
        }
      }

      const patterns = {
        daily: this._findDailyPattern(history),
        weekly: this._findWeeklyPattern(history),
        interval: this._findIntervalPattern(history)
      }

      const prediction = this._predictNext(patterns, history)

      log.info('Pattern analysis complete', { productUrl, patterns, prediction })

      return {
        confidence: this._calculateConfidence(patterns, history),
        patterns,
        nextPredicted: prediction,
        historyCount: history.length
      }
    } catch (err) {
      log.error('Pattern analysis failed', { error: err.message })
      return {
        confidence: 'error',
        message: err.message,
        patterns: null,
        nextPredicted: null
      }
    }
  }

  /**
   * Get restock history for a product
   */
  _getHistory(productUrl, limit = 100) {
    try {
      return this._getDb()
        .prepare(
          `
          SELECT * FROM restock_history
          WHERE product_url = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `
        )
        .all(productUrl, limit)
    } catch {
      return []
    }
  }

  /**
   * Find daily restock pattern (specific hour)
   */
  _findDailyPattern(history) {
    const byHour = {}

    history.forEach((r) => {
      byHour[r.hour] = (byHour[r.hour] || 0) + 1
    })

    const entries = Object.entries(byHour).sort((a, b) => b[1] - a[1])
    if (entries.length === 0) return null

    const [hour, count] = entries[0]
    const confidence = count / history.length

    return {
      hour: parseInt(hour),
      occurrences: count,
      confidence: confidence,
      pattern: confidence > 0.5 ? 'strong' : confidence > 0.3 ? 'moderate' : 'weak'
    }
  }

  /**
   * Find weekly restock pattern (specific day)
   */
  _findWeeklyPattern(history) {
    const byDay = {}

    history.forEach((r) => {
      byDay[r.day_of_week] = (byDay[r.day_of_week] || 0) + 1
    })

    const entries = Object.entries(byDay).sort((a, b) => b[1] - a[1])
    if (entries.length === 0) return null

    const [day, count] = entries[0]
    const confidence = count / history.length

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

    return {
      dayOfWeek: parseInt(day),
      dayName: dayNames[parseInt(day)],
      occurrences: count,
      confidence: confidence,
      pattern: confidence > 0.5 ? 'strong' : confidence > 0.3 ? 'moderate' : 'weak'
    }
  }

  /**
   * Find interval-based pattern (every X hours/days)
   */
  _findIntervalPattern(history) {
    if (history.length < 2) return null

    const intervals = []
    for (let i = 0; i < history.length - 1; i++) {
      const interval = history[i].timestamp - history[i + 1].timestamp
      intervals.push(interval)
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const stdDev = Math.sqrt(
      intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) /
        intervals.length
    )

    const consistency = 1 - stdDev / avgInterval
    const hours = Math.round(avgInterval / (1000 * 60 * 60))

    return {
      averageIntervalMs: avgInterval,
      averageIntervalHours: hours,
      consistency: Math.max(0, Math.min(1, consistency)),
      pattern: consistency > 0.7 ? 'strong' : consistency > 0.4 ? 'moderate' : 'weak'
    }
  }

  /**
   * Predict next restock time
   */
  _predictNext(patterns, history) {
    if (history.length === 0) return null

    const lastRestock = history[0].timestamp
    const now = Date.now()

    // Use interval pattern if strong
    if (patterns.interval && patterns.interval.consistency > 0.6) {
      const nextTime = lastRestock + patterns.interval.averageIntervalMs
      return {
        timestamp: nextTime,
        date: new Date(nextTime),
        method: 'interval',
        confidence: patterns.interval.consistency
      }
    }

    // Use daily pattern if strong
    if (patterns.daily && patterns.daily.confidence > 0.5) {
      const next = new Date()
      next.setHours(patterns.daily.hour, 0, 0, 0)

      // If that time has passed today, predict tomorrow
      if (next.getTime() < now) {
        next.setDate(next.getDate() + 1)
      }

      return {
        timestamp: next.getTime(),
        date: next,
        method: 'daily',
        confidence: patterns.daily.confidence
      }
    }

    // Use weekly pattern if available
    if (patterns.weekly && patterns.weekly.confidence > 0.3) {
      const next = new Date()
      const currentDay = next.getDay()
      const targetDay = patterns.weekly.dayOfWeek

      let daysUntil = targetDay - currentDay
      if (daysUntil <= 0) daysUntil += 7

      next.setDate(next.getDate() + daysUntil)
      next.setHours(patterns.daily?.hour || 12, 0, 0, 0)

      return {
        timestamp: next.getTime(),
        date: next,
        method: 'weekly',
        confidence: patterns.weekly.confidence
      }
    }

    return null
  }

  /**
   * Calculate overall confidence
   */
  _calculateConfidence(patterns, history) {
    if (history.length < 3) return 'low'
    if (history.length < 10) return 'moderate'

    const scores = []

    if (patterns.daily) scores.push(patterns.daily.confidence)
    if (patterns.weekly) scores.push(patterns.weekly.confidence)
    if (patterns.interval) scores.push(patterns.interval.consistency)

    if (scores.length === 0) return 'low'

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length

    if (avgScore > 0.7) return 'high'
    if (avgScore > 0.4) return 'moderate'
    return 'low'
  }

  /**
   * Get smart monitoring interval based on prediction
   */
  getSmartInterval(productUrl, defaultInterval = 4000) {
    try {
      const analysis = this.analyzePatterns(productUrl)

      if (!analysis.nextPredicted) return defaultInterval

      const now = Date.now()
      const predicted = analysis.nextPredicted.timestamp
      const timeUntil = predicted - now

      // If restock is predicted soon, increase frequency
      if (timeUntil < 5 * 60 * 1000) {
        // Less than 5 minutes
        return 1000 // Check every second
      } else if (timeUntil < 30 * 60 * 1000) {
        // Less than 30 minutes
        return 2000 // Check every 2 seconds
      } else if (timeUntil < 2 * 60 * 60 * 1000) {
        // Less than 2 hours
        return 4000 // Normal frequency
      } else {
        return 10000 // Slow down if far away
      }
    } catch {
      return defaultInterval
    }
  }
}

/**
 * Create predictor instance (requires database)
 */
export function createRestockPredictor(getDb) {
  return new RestockPredictor(getDb)
}
