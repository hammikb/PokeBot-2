import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('CookieManager')

/**
 * Dynamic cookie management system
 * Generates, validates, and rotates cookies to bypass detection
 */
export class CookieManager {
  constructor() {
    this.cookieHistory = new Map() // Track cookie usage per account
  }

  /**
   * Generate fresh cookies for a retailer
   * Creates cookies that look legitimate
   */
  async generateFreshCookies(retailer, context) {
    log.info('Generating fresh cookies', { retailer })

    const cookies = []
    const timestamp = Date.now()

    try {
      if (retailer === 'walmart') {
        cookies.push(...this.generateWalmartCookies(timestamp))
      } else if (retailer === 'target') {
        cookies.push(...this.generateTargetCookies(timestamp))
      }

      // Set cookies in browser context
      if (context) {
        for (const cookie of cookies) {
          await context.addCookies([cookie])
        }
        log.debug('Cookies set in browser context', { count: cookies.length })
      }

      log.info('Fresh cookies generated', { 
        retailer, 
        count: cookies.length,
        types: cookies.map(c => c.name)
      })

      return cookies
    } catch (error) {
      log.error('Failed to generate cookies', { retailer, error: error.message })
      throw error
    }
  }

  /**
   * Generate Walmart-specific cookies
   */
  generateWalmartCookies(timestamp) {
    const cookies = []

    // Session tracking cookie
    cookies.push({
      name: '_pxvid',
      value: this.generateRandomHex(36),
      domain: '.walmart.com',
      path: '/',
      expires: timestamp + (365 * 24 * 60 * 60 * 1000), // 1 year
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    })

    // PerimeterX cookie
    cookies.push({
      name: '_px3',
      value: this.generatePX3Cookie(),
      domain: '.walmart.com',
      path: '/',
      expires: timestamp + (24 * 60 * 60 * 1000), // 24 hours
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    })

    // Analytics cookie
    cookies.push({
      name: 'akavpau_vp_walmart',
      value: this.generateRandomNumeric(10),
      domain: '.walmart.com',
      path: '/',
      expires: timestamp + (60 * 60 * 1000), // 1 hour
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    })

    // Session ID
    cookies.push({
      name: 'ACID',
      value: this.generateRandomAlphanumeric(32),
      domain: '.walmart.com',
      path: '/',
      expires: timestamp + (30 * 60 * 1000), // 30 minutes
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    })

    log.debug('Generated Walmart cookies', { count: cookies.length })
    return cookies
  }

  /**
   * Generate Target-specific cookies
   */
  generateTargetCookies(timestamp) {
    const cookies = []

    // Visitor ID
    cookies.push({
      name: 'visitorId',
      value: this.generateUUID(),
      domain: '.target.com',
      path: '/',
      expires: timestamp + (365 * 24 * 60 * 60 * 1000), // 1 year
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    })

    // Session cookie
    cookies.push({
      name: 'TealeafAkaSid',
      value: this.generateRandomAlphanumeric(32),
      domain: '.target.com',
      path: '/',
      expires: timestamp + (30 * 60 * 1000), // 30 minutes
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    })

    // Geo location
    cookies.push({
      name: 'UserLocation',
      value: this.generateLocationCookie(),
      domain: '.target.com',
      path: '/',
      expires: timestamp + (24 * 60 * 60 * 1000), // 24 hours
      httpOnly: false,
      secure: false,
      sameSite: 'Lax'
    })

    log.debug('Generated Target cookies', { count: cookies.length })
    return cookies
  }

  /**
   * Validate cookies are still valid
   */
  async validateCookies(context, retailer) {
    log.debug('Validating cookies', { retailer })

    try {
      const cookies = await context.cookies()
      
      if (cookies.length === 0) {
        log.warn('No cookies found')
        return { valid: false, reason: 'No cookies' }
      }

      // Check for expired cookies
      const now = Date.now()
      const expiredCookies = cookies.filter(c => c.expires && c.expires * 1000 < now)
      
      if (expiredCookies.length > 0) {
        log.warn('Found expired cookies', { 
          count: expiredCookies.length,
          names: expiredCookies.map(c => c.name)
        })
        return { valid: false, reason: 'Expired cookies', expiredCookies }
      }

      // Check for required cookies
      const requiredCookies = this.getRequiredCookies(retailer)
      const cookieNames = new Set(cookies.map(c => c.name))
      const missingCookies = requiredCookies.filter(name => !cookieNames.has(name))

      if (missingCookies.length > 0) {
        log.warn('Missing required cookies', { missing: missingCookies })
        return { valid: false, reason: 'Missing cookies', missingCookies }
      }

      log.info('Cookies validated successfully', { 
        total: cookies.length,
        retailer 
      })

      return { valid: true, cookies }
    } catch (error) {
      log.error('Cookie validation failed', { error: error.message })
      return { valid: false, reason: error.message }
    }
  }

  /**
   * Rotate cookies to avoid detection
   */
  async rotateCookies(accountId, context, retailer) {
    log.info('Rotating cookies', { accountId, retailer })

    try {
      // Get current cookies
      const currentCookies = await context.cookies()
      
      // Store in history
      this.cookieHistory.set(accountId, {
        timestamp: Date.now(),
        cookies: currentCookies,
        retailer
      })

      // Clear current cookies
      await context.clearCookies()
      log.debug('Cleared existing cookies', { count: currentCookies.length })

      // Generate and set fresh cookies
      await this.generateFreshCookies(retailer, context)

      log.info('Cookie rotation complete', { accountId })
      return { success: true }
    } catch (error) {
      log.error('Cookie rotation failed', { accountId, error: error.message })
      return { success: false, error: error.message }
    }
  }

  /**
   * Get required cookies for retailer
   */
  getRequiredCookies(retailer) {
    const required = {
      walmart: ['_pxvid', 'ACID'],
      target: ['visitorId', 'TealeafAkaSid']
    }

    return required[retailer] || []
  }

  /**
   * Get cookie history for account
   */
  getCookieHistory(accountId) {
    return this.cookieHistory.get(accountId) || null
  }

  /**
   * Clear cookie history
   */
  clearHistory(accountId) {
    if (accountId) {
      this.cookieHistory.delete(accountId)
      log.debug('Cleared cookie history', { accountId })
    } else {
      this.cookieHistory.clear()
      log.debug('Cleared all cookie history')
    }
  }

  // Helper functions for cookie generation

  generateRandomHex(length) {
    const chars = '0123456789abcdef'
    let result = ''
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)]
    }
    return result
  }

  generateRandomNumeric(length) {
    let result = ''
    for (let i = 0; i < length; i++) {
      result += Math.floor(Math.random() * 10)
    }
    return result
  }

  generateRandomAlphanumeric(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)]
    }
    return result
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  generatePX3Cookie() {
    // PerimeterX _px3 cookie format (simplified)
    const timestamp = Math.floor(Date.now() / 1000)
    const random = this.generateRandomAlphanumeric(40)
    return `${timestamp}:${random}`
  }

  generateLocationCookie() {
    // Format: zipcode|city|state|latitude|longitude
    const zips = ['90210', '10001', '60601', '94102', '33101']
    const zip = zips[Math.floor(Math.random() * zips.length)]
    return `${zip}||||`
  }
}

// Singleton instance
export const cookieManager = new CookieManager()
