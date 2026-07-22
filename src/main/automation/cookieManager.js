import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('CookieManager')

const RETAILER_COOKIE_URLS = {
  target: ['https://www.target.com'],
  walmart: ['https://www.walmart.com'],
  samsclub: ['https://www.samsclub.com'],
  'pokemon-center': ['https://www.pokemoncenter.com']
}

/**
 * Read-only cookie health diagnostics. Cookie values are deliberately never
 * returned, logged, generated, copied, or cleared.
 */
export class CookieManager {
  async inspectCookies(context, retailer, nowSeconds = Date.now() / 1000) {
    const urls = RETAILER_COOKIE_URLS[retailer]
    if (!urls) return { healthy: false, status: 'unsupported', message: 'Unsupported retailer' }

    try {
      const cookies = await context.cookies(urls)
      const active = cookies.filter((cookie) => cookie.expires <= 0 || cookie.expires > nowSeconds)
      const expired = cookies.length - active.length
      const session = active.filter((cookie) => cookie.expires <= 0).length
      const expiringSoon = active.filter(
        (cookie) => cookie.expires > 0 && cookie.expires <= nowSeconds + 60 * 60
      ).length
      const domains = [...new Set(active.map((cookie) => cookie.domain))].sort()
      const secure = active.filter((cookie) => cookie.secure).length
      const status =
        active.length === 0 ? 'empty' : expiringSoon > active.length / 2 ? 'expiring' : 'healthy'
      const summary = {
        healthy: status === 'healthy',
        status,
        total: active.length,
        persistent: active.length - session,
        session,
        expiringSoon,
        expired,
        secure,
        domains
      }

      log.info('Retailer cookie health inspected', { retailer, ...summary })
      return {
        ...summary,
        message:
          status === 'empty'
            ? `No active ${retailer} cookies found; open the profile and sign in.`
            : `${retailer} cookie profile: ${active.length} active, ${expiringSoon} expiring within an hour.`
      }
    } catch (error) {
      log.warn('Cookie health inspection failed', { retailer, error: error.message })
      return { healthy: false, status: 'error', message: error.message }
    }
  }

  async validateCookies(context, retailer) {
    return this.inspectCookies(context, retailer)
  }

  async generateFreshCookies() {
    throw new Error('Synthetic cookie generation is disabled; retailer cookies must be site-issued')
  }

  async rotateCookies() {
    return {
      success: false,
      error: 'Cookie rotation is disabled to preserve the retailer-issued persistent session'
    }
  }
}

export const cookieManager = new CookieManager()
