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
 * Run a fetch INSIDE the browser page context.
 *
 * We deliberately do not use Node `axios` for checkout: the cart/checkout endpoints sit behind
 * Akamai (the `_abck` sensor cookie) and require the same-origin `*.target.com` cookies + headers
 * that only a real browser session has. Running `fetch` inside the page reuses all of that for
 * free, which is far more reliable than replaying raw requests from Node.
 *
 * Returns `{ ok, status, data, text }`.
 */
async function pageFetch(page, { url, method = 'GET', body = null }) {
  return page.evaluate(
    async ({ url, method, body }) => {
      // The checkout-mutation routes (PUT/POST /checkouts/...) reject cookie-only auth with
      // "[ID2] token value missing". Target's web app reads the `accessToken` cookie and
      // replays it as an `authorization: Bearer` header — `fetch` won't do that automatically,
      // so we read it from document.cookie and attach it ourselves.
      const readCookie = (name) => {
        const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
        return match ? decodeURIComponent(match[1]) : null
      }
      const accessToken = readCookie('accessToken')

      try {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-application-name': 'web',
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        })

        const text = await res.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = null
        }
        return { ok: res.ok, status: res.status, data, text: text.slice(0, 300) }
      } catch (err) {
        return { ok: false, status: 0, data: null, text: String(err && err.message) }
      }
    },
    { url, method, body }
  )
}

const CARTS_BASE = 'https://carts.target.com/web_checkouts/v1'

/**
 * Read the current checkout, returning the cart id and what still needs to be set
 * (address / payment) so the caller can decide which steps to run.
 */
export async function getCheckoutState(page) {
  const res = await pageFetch(page, {
    url: `${CARTS_BASE}/cart?field_groups=CART_ITEMS,SUMMARY,ADDRESSES,PAYMENT_INSTRUCTIONS`
  })
  if (!res.ok || !res.data) {
    return { success: false, status: res.status, error: res.text || 'cart read failed' }
  }
  const cart = res.data
  return {
    success: true,
    cartId: cart.cart_id || cart.id,
    hasItems: Array.isArray(cart.cart_items) && cart.cart_items.length > 0,
    hasAddress: Boolean(
      cart.addresses?.length || cart.delivery_address || cart.selected_address_id
    ),
    hasPayment: Boolean(cart.payment_instructions?.length),
    cart
  }
}

/**
 * Attach a saved shipping address + shipping fulfillment to the checkout.
 * `addressId` is the Target-stored address id; if omitted Target uses the account default.
 */
export async function setFulfillment(page, cartId, { addressId } = {}) {
  const res = await pageFetch(page, {
    url: `${CARTS_BASE}/checkouts/${cartId}`,
    method: 'PUT',
    body: {
      cart_type: 'REGULAR',
      ...(addressId ? { selected_address_id: addressId } : {}),
      fulfillment: { type: 'SHIPPING' }
    }
  })
  return { success: res.ok, status: res.status, error: res.ok ? null : res.text, data: res.data }
}

/**
 * Attach a saved payment card (by Target `payment_method_id`) + CVV to the checkout.
 */
export async function setPayment(page, cartId, { paymentMethodId, cvv } = {}) {
  const res = await pageFetch(page, {
    url: `${CARTS_BASE}/checkouts/${cartId}/payment_instructions`,
    method: 'PUT',
    body: {
      payment_instructions: [
        {
          ...(paymentMethodId ? { wallet_payment_method_id: paymentMethodId } : {}),
          ...(cvv ? { cvv } : {}),
          payment_type: 'CARD'
        }
      ]
    }
  })
  return { success: res.ok, status: res.status, error: res.ok ? null : res.text, data: res.data }
}

/**
 * Submit the order. This is the irreversible step.
 */
export async function placeOrder(page, cartId) {
  const res = await pageFetch(page, {
    url: `${CARTS_BASE}/checkouts/${cartId}`,
    method: 'POST',
    body: { cart_type: 'REGULAR' }
  })
  const orderId =
    res.data?.order_id || res.data?.order?.order_id || res.data?.purchase_order_id || null
  return {
    success: res.ok && Boolean(orderId),
    status: res.status,
    orderId,
    error: res.ok ? null : res.text,
    data: res.data
  }
}

/**
 * Full API-driven checkout, all run via in-page fetch (no UI clicks).
 *
 * Sequence: add to cart → read checkout → set address → set payment → (optionally) place order.
 * Every step that fails returns `{ success: false, step }` so the caller can fall back to the
 * browser-UI flow. When `testMode` is true we stop right before `placeOrder` so payloads can be
 * validated against a live session without buying anything.
 */
export async function fullApiCheckout(
  page,
  { tcin, quantity = 1, cvv, addressId, paymentMethodId, testMode = false, onStep = () => {} }
) {
  // 1. Add to cart (in-page fetch, reuses session/sensor).
  onStep('API: adding to cart')
  const add = await pageFetch(page, {
    url: `${CARTS_BASE}/cart_items`,
    method: 'POST',
    body: {
      cart_type: 'REGULAR',
      channel_id: '10',
      shopping_context: 'DIGITAL',
      cart_item: { tcin, quantity, item_channel_id: '10' }
    }
  })
  if (!add.ok) {
    log.warn('Full-API add to cart failed', { tcin, status: add.status, body: add.text })
    return { success: false, step: 'add_to_cart', status: add.status, error: add.text }
  }
  const cartId = add.data?.cart_id || add.data?.cart_item?.cart_id

  // 2. Read checkout state to learn the cart id and what still needs setting.
  onStep('API: reading checkout')
  const state = await getCheckoutState(page)
  const resolvedCartId = cartId || state.cartId
  if (!resolvedCartId) {
    return { success: false, step: 'get_cart', error: state.error || 'no cart id' }
  }

  // 3. Shipping address / fulfillment (skip if Target already has one selected).
  if (!state.hasAddress || addressId) {
    onStep('API: setting shipping address')
    const ful = await setFulfillment(page, resolvedCartId, { addressId })
    if (!ful.success) {
      log.warn('Full-API set fulfillment failed', { status: ful.status, error: ful.error })
      return { success: false, step: 'fulfillment', status: ful.status, error: ful.error }
    }
  }

  // 4. Payment (skip if a payment instruction is already attached and no CVV needed).
  if (!state.hasPayment || paymentMethodId || cvv) {
    onStep('API: setting payment')
    const pay = await setPayment(page, resolvedCartId, { paymentMethodId, cvv })
    if (!pay.success) {
      log.warn('Full-API set payment failed', { status: pay.status, error: pay.error })
      return { success: false, step: 'payment', status: pay.status, error: pay.error }
    }
  }

  if (testMode) {
    onStep('API: TEST MODE — stopping before place order')
    return { success: true, testMode: true, cartId: resolvedCartId, requiresManualCheckout: true }
  }

  // 5. Place the order.
  onStep('API: placing order')
  const order = await placeOrder(page, resolvedCartId)
  if (!order.success) {
    log.warn('Full-API place order failed', { status: order.status, error: order.error })
    return { success: false, step: 'place_order', status: order.status, error: order.error }
  }

  log.info('Full-API checkout complete', { cartId: resolvedCartId, orderId: order.orderId })
  return { success: true, cartId: resolvedCartId, orderId: order.orderId }
}

/**
 * Hybrid approach: Use API for cart, browser for checkout
 * This is MUCH faster than pure browser automation
 */
export async function hybridTargetCheckout(page, { tcin, quantity = 1 }) {
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
