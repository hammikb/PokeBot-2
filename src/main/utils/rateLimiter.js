import { randomUUID } from 'crypto'
import { createModuleLogger } from './logger.js'

const log = createModuleLogger('RateLimiter')

// Rate limit configurations per retailer (requests per minute)
const RATE_LIMITS = {
  target: { requestsPerMinute: 30, burstLimit: 10 },
  walmart: { requestsPerMinute: 30, burstLimit: 10 },
  'pokemon-center': { requestsPerMinute: 20, burstLimit: 5 },
  bestbuy: { requestsPerMinute: 30, burstLimit: 10 },
  costco: { requestsPerMinute: 20, burstLimit: 5 },
  gamestop: { requestsPerMinute: 30, burstLimit: 10 },
  samsclub: { requestsPerMinute: 20, burstLimit: 5 }
}

export class RateLimiter {
  constructor(getDb) {
    this._getDb = getDb
  }

  async checkLimit(retailer, endpoint = 'default') {
    const config = RATE_LIMITS[retailer] || { requestsPerMinute: 30, burstLimit: 10 }
    const now = Date.now()
    const windowMs = 60 * 1000 // 1 minute window

    try {
      const db = this._getDb()
      
      // Get or create rate limit record
      let record = db
        .prepare('SELECT * FROM rate_limits WHERE retailer = ? AND endpoint = ?')
        .get(retailer, endpoint)

      if (!record) {
        const id = randomUUID()
        db.prepare(
          'INSERT INTO rate_limits (id, retailer, endpoint, last_request, request_count, window_start) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, retailer, endpoint, now, 1, now)
        log.debug('Rate limit initialized', { retailer, endpoint })
        return { allowed: true, retryAfter: 0 }
      }

      // Check if we're in a new window
      if (now - record.window_start > windowMs) {
        // Reset window
        db.prepare(
          'UPDATE rate_limits SET request_count = 1, window_start = ?, last_request = ? WHERE retailer = ? AND endpoint = ?'
        ).run(now, now, retailer, endpoint)
        log.debug('Rate limit window reset', { retailer, endpoint })
        return { allowed: true, retryAfter: 0 }
      }

      // Check burst limit (requests in quick succession)
      const timeSinceLastRequest = now - record.last_request
      if (timeSinceLastRequest < 1000 && record.request_count >= config.burstLimit) {
        const retryAfter = 1000 - timeSinceLastRequest
        log.warn('Burst limit exceeded', { retailer, endpoint, retryAfter })
        return { allowed: false, retryAfter }
      }

      // Check rate limit
      if (record.request_count >= config.requestsPerMinute) {
        const retryAfter = windowMs - (now - record.window_start)
        log.warn('Rate limit exceeded', { retailer, endpoint, retryAfter })
        return { allowed: false, retryAfter }
      }

      // Increment counter
      db.prepare(
        'UPDATE rate_limits SET request_count = request_count + 1, last_request = ? WHERE retailer = ? AND endpoint = ?'
      ).run(now, retailer, endpoint)

      return { allowed: true, retryAfter: 0 }
    } catch (err) {
      log.error('Rate limit check failed', { retailer, endpoint, error: err.message })
      // Fail open - allow request if rate limiting fails
      return { allowed: true, retryAfter: 0 }
    }
  }

  async waitForLimit(retailer, endpoint = 'default') {
    const result = await this.checkLimit(retailer, endpoint)
    if (!result.allowed && result.retryAfter > 0) {
      log.info('Waiting for rate limit', { retailer, endpoint, waitMs: result.retryAfter })
      await new Promise((resolve) => setTimeout(resolve, result.retryAfter))
      return this.waitForLimit(retailer, endpoint)
    }
    return result
  }

  getRateLimitConfig(retailer) {
    return RATE_LIMITS[retailer] || { requestsPerMinute: 30, burstLimit: 10 }
  }

  async resetLimits(retailer = null) {
    try {
      const db = this._getDb()
      if (retailer) {
        db.prepare('DELETE FROM rate_limits WHERE retailer = ?').run(retailer)
        log.info('Rate limits reset', { retailer })
      } else {
        db.prepare('DELETE FROM rate_limits').run()
        log.info('All rate limits reset')
      }
    } catch (err) {
      log.error('Failed to reset rate limits', { retailer, error: err.message })
    }
  }
}
