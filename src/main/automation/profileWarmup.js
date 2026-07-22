import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('ProfileWarmup')

const RETAILER_SESSION_PAGES = {
  target: [
    'https://www.target.com/',
    'https://www.target.com/account',
    'https://www.target.com/cart'
  ],
  walmart: [
    'https://www.walmart.com/',
    'https://www.walmart.com/account',
    'https://www.walmart.com/cart'
  ],
  samsclub: [
    'https://www.samsclub.com/',
    'https://www.samsclub.com/account',
    'https://www.samsclub.com/cart'
  ],
  'pokemon-center': [
    'https://www.pokemoncenter.com/',
    'https://www.pokemoncenter.com/account',
    'https://www.pokemoncenter.com/cart'
  ]
}

const CHALLENGE_TEXT =
  /robot or human|verify you are human|access denied|captcha|hold tight for a moment/i

export function getSessionPreparationUrls(retailer) {
  return [...(RETAILER_SESSION_PAGES[retailer] || [])]
}

/**
 * Prepares an existing persistent retailer profile by loading the pages needed
 * during checkout. This is session setup, not behavioral imitation: it does not
 * browse unrelated sites, randomly click products, or simulate a person.
 */
export class ProfileWarmup {
  constructor(browserPool) {
    this.browserPool = browserPool
  }

  async prepareProfile(account, options = {}) {
    const urls = getSessionPreparationUrls(account?.retailer)
    if (!urls.length) throw new Error('Session preparation is not supported for this retailer')

    const settleMs = Math.max(0, Math.min(Number(options.settleMs) || 1500, 5000))
    const context = await this.browserPool.launch(account.id, {
      profilePath: account.profile_path,
      proxy: account.proxy
    })
    const page = await context.newPage()
    const startedAt = Date.now()
    const pagesLoaded = []

    log.info('Preparing persistent retailer session', {
      accountId: account.id,
      retailer: account.retailer,
      pageCount: urls.length
    })

    try {
      for (const url of urls) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        if (settleMs) await page.waitForTimeout(settleMs)

        const title = await page.title().catch(() => '')
        const bodyText = await page
          .locator('body')
          .innerText({ timeout: 3000 })
          .catch(() => '')
        if (CHALLENGE_TEXT.test(`${title}\n${bodyText.slice(0, 5000)}`)) {
          throw new Error(`Retailer challenge detected at ${new URL(url).pathname || '/'}`)
        }
        pagesLoaded.push(new URL(url).pathname || '/')
      }

      const duration = Date.now() - startedAt
      log.info('Persistent retailer session prepared', {
        accountId: account.id,
        retailer: account.retailer,
        durationMs: duration,
        pagesLoaded
      })
      return {
        success: true,
        duration,
        pagesLoaded,
        message: `${account.retailer} session prepared (${pagesLoaded.length} pages loaded)`
      }
    } catch (err) {
      log.warn('Retailer session preparation stopped', {
        accountId: account.id,
        retailer: account.retailer,
        error: err.message,
        pagesLoaded
      })
      return { success: false, error: err.message, pagesLoaded }
    } finally {
      await page.close().catch(() => {})
    }
  }

  // Keep the previous method available for callers from older renderer builds.
  async warmupWalmartProfile(account, options = {}) {
    return this.prepareProfile({ ...account, retailer: 'walmart' }, options)
  }
}
