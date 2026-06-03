import axios from 'axios'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('TargetAPI')

/**
 * Target API client for faster cart operations
 * Uses Target's internal APIs instead of browser automation
 */
export class TargetApiClient {
  constructor(cookies = {}) {
    this.cookies = cookies
    this.baseUrl = 'https://www.target.com'
    this.apiUrl = 'https://redsky.target.com/redsky_aggregations/v1'
  }

  /**
   * Extract cookies from Playwright page
   */
  static async fromPage(page) {
    const cookies = await page.context().cookies()
    const cookieMap = {}
    for (const cookie of cookies) {
      cookieMap[cookie.name] = cookie.value
    }
    return new TargetApiClient(cookieMap)
  }

  /**
   * Get product details from Target API
   */
  async getProduct(tcin) {
    try {
      log.info('Fetching product details', { tcin })
      const response = await axios.get(`${this.apiUrl}/web/pdp_client_v1`, {
        params: {
          key: this._getApiKey(),
          tcin,
          store_id: '3991', // Default store
          pricing_store_id: '3991',
          has_pricing_store_id: 'true',
          has_financing_options: 'true'
        },
        headers: this._getHeaders()
      })

      return {
        success: true,
        product: response.data?.data?.product
      }
    } catch (err) {
      log.error('Failed to fetch product', { tcin, error: err.message })
      return { success: false, error: err.message }
    }
  }

  /**
   * Add item to cart using Target API (FAST!)
   */
  async addToCart(tcin, quantity = 1) {
    try {
      log.info('Adding to cart via API', { tcin, quantity })
      
      const response = await axios.post(
        'https://carts.target.com/web_checkouts/v1/cart_items',
        {
          cart_type: 'REGULAR',
          channel_id: '10',
          shopping_context: 'DIGITAL',
          cart_item: {
            tcin,
            quantity,
            item_channel_id: '10'
          }
        },
        {
          headers: {
            ...this._getHeaders(),
            'Content-Type': 'application/json'
          }
        }
      )

      if (response.data?.cart_item) {
        log.info('Successfully added to cart', { tcin, quantity })
        return {
          success: true,
          cartItem: response.data.cart_item,
          cartId: response.data.cart_id
        }
      }

      return { success: false, error: 'No cart item in response' }
    } catch (err) {
      log.error('Failed to add to cart', { tcin, error: err.message })
      return { success: false, error: err.message }
    }
  }

  /**
   * Get current cart
   */
  async getCart() {
    try {
      const response = await axios.get('https://carts.target.com/web_checkouts/v1/cart', {
        params: {
          field_groups: 'CART_ITEMS,SUMMARY',
          key: this._getApiKey()
        },
        headers: this._getHeaders()
      })

      return {
        success: true,
        cart: response.data
      }
    } catch (err) {
      log.error('Failed to get cart', { error: err.message })
      return { success: false, error: err.message }
    }
  }

  /**
   * Update cart item quantity
   */
  async updateQuantity(cartItemId, quantity) {
    try {
      log.info('Updating cart quantity', { cartItemId, quantity })
      
      const response = await axios.put(
        `https://carts.target.com/web_checkouts/v1/cart_items/${cartItemId}`,
        {
          cart_item: {
            quantity
          }
        },
        {
          headers: {
            ...this._getHeaders(),
            'Content-Type': 'application/json'
          }
        }
      )

      return {
        success: true,
        cartItem: response.data.cart_item
      }
    } catch (err) {
      log.error('Failed to update quantity', { cartItemId, error: err.message })
      return { success: false, error: err.message }
    }
  }

  /**
   * Clear cart
   */
  async clearCart() {
    try {
      const cartResult = await this.getCart()
      if (!cartResult.success) return cartResult

      const items = cartResult.cart?.cart_items || []
      for (const item of items) {
        await axios.delete(
          `https://carts.target.com/web_checkouts/v1/cart_items/${item.cart_item_id}`,
          { headers: this._getHeaders() }
        )
      }

      log.info('Cart cleared successfully')
      return { success: true }
    } catch (err) {
      log.error('Failed to clear cart', { error: err.message })
      return { success: false, error: err.message }
    }
  }

  /**
   * Extract TCIN from Target product URL
   */
  static extractTcin(url) {
    // Target URLs: https://www.target.com/p/product-name/-/A-12345678
    const match = url.match(/\/A-(\d+)/)
    return match ? match[1] : null
  }

  _getHeaders() {
    const cookieString = Object.entries(this.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ')

    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cookieString,
      Referer: 'https://www.target.com/',
      Origin: 'https://www.target.com'
    }
  }

  _getApiKey() {
    // Target's public API key (changes occasionally)
    return 'ff457966e64d5e877fdbad070f276d18ecec4a01'
  }
}

/**
 * Hybrid approach: Use API for cart, browser for checkout
 * This is MUCH faster than pure browser automation
 */
export async function hybridTargetCheckout(page, { tcin, quantity = 1, cvv }) {
  try {
    // Step 1: Use API to add to cart (FAST - ~500ms)
    log.info('Using hybrid approach: API + Browser')
    const api = await TargetApiClient.fromPage(page)
    
    const addResult = await api.addToCart(tcin, quantity)
    if (!addResult.success) {
      log.warn('API add to cart failed, falling back to browser', { error: addResult.error })
      return { success: false, fallbackToBrowser: true }
    }

    log.info('Item added to cart via API', { cartId: addResult.cartId })

    // Step 2: Navigate to checkout (browser takes over)
    await page.goto('https://www.target.com/co-cart', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    return {
      success: true,
      method: 'hybrid',
      cartId: addResult.cartId,
      message: 'Added to cart via API, ready for checkout'
    }
  } catch (err) {
    log.error('Hybrid checkout failed', { error: err.message })
    return { success: false, fallbackToBrowser: true, error: err.message }
  }
}
