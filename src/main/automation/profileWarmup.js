import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('ProfileWarmup')

/**
 * Automated profile warmup for Walmart accounts
 * Simulates human browsing behavior to build session trust
 */
export class ProfileWarmup {
  constructor(browserPool) {
    this.browserPool = browserPool
  }

  /**
   * Warm up a Walmart account profile with human-like browsing
   */
  async warmupWalmartProfile(account, options = {}) {
    const {
      duration = 180000, // 3 minutes default
      searchQueries = ['pokemon cards', 'pokemon booster packs', 'trading cards'],
      minActions = 8,
      maxActions = 15
    } = options

    log.info('Starting automated profile warmup', {
      accountId: account.id,
      duration: `${duration / 1000}s`
    })

    const context = await this.browserPool.launch(account.id, {
      profilePath: account.profile_path,
      proxy: account.proxy
    })

    const page = await context.newPage()
    const startTime = Date.now()
    const actions = []

    try {
      // Step 1: Go to Walmart homepage
      log.info('Step 1: Loading Walmart homepage')
      await page.goto('https://www.walmart.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
      await this._humanDelay(2000, 4000)
      actions.push('Loaded homepage')

      // Step 2: Sign in if needed
      const signInLink = page.locator('a:has-text("Sign in"), button:has-text("Sign in")')
      if ((await signInLink.count()) > 0 && account.username && account.password) {
        log.info('Step 2: Signing in')
        await this._signIn(page, account)
        await this._humanDelay(2000, 3000)
        actions.push('Signed in')
      } else {
        log.info('Step 2: Already signed in')
        actions.push('Already signed in')
      }

      // Step 3: Random browsing actions
      const numActions = Math.floor(Math.random() * (maxActions - minActions + 1)) + minActions
      log.info(`Step 3: Performing ${numActions} human-like actions`)

      for (let i = 0; i < numActions && Date.now() - startTime < duration; i++) {
        const action = await this._performRandomAction(page, searchQueries)
        actions.push(action)
        await this._humanDelay(3000, 8000) // Wait between actions
      }

      // Step 4: View cart
      log.info('Step 4: Viewing cart')
      await page.goto('https://www.walmart.com/cart', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
      await this._humanDelay(2000, 4000)
      actions.push('Viewed cart')

      // Step 5: Browse account/orders
      log.info('Step 5: Viewing account')
      await page.goto('https://www.walmart.com/account', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
      await this._humanDelay(2000, 3000)
      actions.push('Viewed account')

      const totalTime = Date.now() - startTime
      log.info('Profile warmup completed successfully', {
        accountId: account.id,
        duration: `${totalTime / 1000}s`,
        actionsPerformed: actions.length
      })

      return {
        success: true,
        duration: totalTime,
        actions,
        message: `Profile warmed up with ${actions.length} actions in ${Math.round(totalTime / 1000)}s`
      }
    } catch (err) {
      log.error('Profile warmup failed', {
        accountId: account.id,
        error: err.message
      })
      return {
        success: false,
        error: err.message,
        actions
      }
    } finally {
      try {
        await page.close()
      } catch {
        // Best effort cleanup
      }
    }
  }

  /**
   * Perform a random human-like action
   */
  async _performRandomAction(page, searchQueries) {
    const actions = [
      () => this._searchProduct(page, searchQueries),
      () => this._clickProduct(page),
      () => this._scrollPage(page),
      () => this._hoverElements(page),
      () => this._viewDepartment(page)
    ]

    const randomAction = actions[Math.floor(Math.random() * actions.length)]
    return await randomAction()
  }

  /**
   * Search for a product
   */
  async _searchProduct(page, queries) {
    try {
      const query = queries[Math.floor(Math.random() * queries.length)]
      const searchBox = page.locator('input[type="search"], input[aria-label*="Search"]')
      
      if ((await searchBox.count()) > 0) {
        await searchBox.first().click()
        await this._humanDelay(500, 1000)
        
        // Type like a human (character by character with delays)
        for (const char of query) {
          await searchBox.first().type(char)
          await this._humanDelay(50, 150)
        }
        
        await searchBox.first().press('Enter')
        await this._humanDelay(2000, 3000)
        return `Searched for "${query}"`
      }
    } catch (err) {
      log.warn('Search action failed', { error: err.message })
    }
    return 'Search skipped'
  }

  /**
   * Click on a random product
   */
  async _clickProduct(page) {
    try {
      const products = page.locator('[data-item-id], [data-product-id], a[href*="/ip/"]')
      const count = await products.count()
      
      if (count > 0) {
        const randomIndex = Math.floor(Math.random() * Math.min(count, 10))
        await products.nth(randomIndex).click({ timeout: 5000 })
        await this._humanDelay(3000, 6000)
        
        // Sometimes go back
        if (Math.random() > 0.5) {
          await page.goBack()
          await this._humanDelay(1000, 2000)
          return 'Clicked product and went back'
        }
        return 'Clicked product'
      }
    } catch (err) {
      log.warn('Click product failed', { error: err.message })
    }
    return 'Click skipped'
  }

  /**
   * Scroll the page like a human
   */
  async _scrollPage(page) {
    try {
      const scrolls = Math.floor(Math.random() * 3) + 2 // 2-4 scrolls
      for (let i = 0; i < scrolls; i++) {
        await page.evaluate(() => {
          window.scrollBy({
            top: Math.random() * 500 + 200,
            behavior: 'smooth'
          })
        })
        await this._humanDelay(800, 1500)
      }
      return `Scrolled ${scrolls} times`
    } catch (err) {
      log.warn('Scroll failed', { error: err.message })
    }
    return 'Scroll skipped'
  }

  /**
   * Hover over random elements
   */
  async _hoverElements(page) {
    try {
      const elements = page.locator('a, button, [role="button"]')
      const count = await elements.count()
      
      if (count > 0) {
        const hovers = Math.floor(Math.random() * 3) + 1
        for (let i = 0; i < hovers; i++) {
          const randomIndex = Math.floor(Math.random() * Math.min(count, 20))
          await elements.nth(randomIndex).hover({ timeout: 2000 })
          await this._humanDelay(500, 1000)
        }
        return `Hovered ${hovers} elements`
      }
    } catch (err) {
      log.warn('Hover failed', { error: err.message })
    }
    return 'Hover skipped'
  }

  /**
   * View a random department
   */
  async _viewDepartment(page) {
    try {
      const departments = [
        'https://www.walmart.com/browse/toys/4171',
        'https://www.walmart.com/browse/electronics/3944',
        'https://www.walmart.com/browse/sports-outdoors/4125'
      ]
      
      const dept = departments[Math.floor(Math.random() * departments.length)]
      await page.goto(dept, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await this._humanDelay(2000, 4000)
      return 'Viewed department'
    } catch (err) {
      log.warn('View department failed', { error: err.message })
    }
    return 'Department skipped'
  }

  /**
   * Sign in to Walmart
   */
  async _signIn(page, account) {
    try {
      await page.goto('https://www.walmart.com/account/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
      await this._humanDelay(1000, 2000)

      const emailField = page.locator('input[name="email"], input[type="email"]')
      await emailField.first().waitFor({ state: 'visible', timeout: 10000 })
      
      // Type email like a human
      for (const char of account.username || account.email) {
        await emailField.first().type(char)
        await this._humanDelay(50, 150)
      }
      
      await this._humanDelay(500, 1000)
      
      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]')
      if ((await continueBtn.count()) > 0) {
        await continueBtn.first().click()
        await this._humanDelay(2000, 3000)
      }

      const passwordField = page.locator('input[name="password"], input[type="password"]')
      await passwordField.first().waitFor({ state: 'visible', timeout: 10000 })
      
      // Type password like a human
      for (const char of account.password) {
        await passwordField.first().type(char)
        await this._humanDelay(50, 150)
      }
      
      await this._humanDelay(500, 1000)
      
      const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]')
      await signInBtn.first().click()
      await this._humanDelay(3000, 5000)
    } catch (err) {
      log.error('Sign in failed during warmup', { error: err.message })
      throw err
    }
  }

  /**
   * Human-like delay with randomness
   */
  async _humanDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}
