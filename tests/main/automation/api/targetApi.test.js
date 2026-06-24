import { describe, it, expect, vi } from 'vitest'
import { fullApiCheckout } from '../../../../src/main/automation/api/targetApi.js'

/**
 * Build a fake Playwright page whose `evaluate` resolves the in-page `fetch` calls.
 * `responder({ url, method, body })` returns `{ ok, status, data }` per request so each
 * test can script the cart/checkout sequence.
 */
function makePage(responder) {
  return {
    calls: [],
    async evaluate(_fn, args) {
      this.calls.push(args)
      const res = responder(args)
      return {
        ok: res.ok ?? true,
        status: res.status ?? 200,
        data: res.data ?? null,
        text: res.text ?? ''
      }
    }
  }
}

const okCart = { ok: true, data: { cart_id: 'cart-1', cart_item: { cart_id: 'cart-1' } } }
const okState = {
  ok: true,
  data: { cart_id: 'cart-1', cart_items: [{}], addresses: [], payment_instructions: [] }
}

describe('fullApiCheckout', () => {
  it('runs add → address → payment → place order and returns the order id', async () => {
    const page = makePage(({ url, method }) => {
      if (url.endsWith('/cart_items') && method === 'POST') return okCart
      if (url.includes('/cart?field_groups')) return okState
      if (url.includes('/payment_instructions')) return { ok: true, data: {} }
      if (url.includes('/checkouts/cart-1') && method === 'PUT') return { ok: true, data: {} }
      if (url.includes('/checkouts/cart-1') && method === 'POST')
        return { ok: true, data: { order_id: 'ORDER-99' } }
      return { ok: false, status: 500 }
    })

    const result = await fullApiCheckout(page, { tcin: '123', quantity: 1, cvv: '456' })
    expect(result).toMatchObject({ success: true, orderId: 'ORDER-99' })
  })

  it('stops before place order in test mode', async () => {
    let placedOrder = false
    const page = makePage(({ url, method }) => {
      if (url.endsWith('/cart_items') && method === 'POST') return okCart
      if (url.includes('/cart?field_groups')) return okState
      if (url.includes('/checkouts/cart-1') && method === 'POST') {
        placedOrder = true
        return { ok: true, data: { order_id: 'ORDER-99' } }
      }
      return { ok: true, data: {} }
    })

    const result = await fullApiCheckout(page, { tcin: '123', testMode: true })
    expect(result).toMatchObject({ success: true, testMode: true, requiresManualCheckout: true })
    expect(placedOrder).toBe(false)
  })

  it('fails fast and reports the step when add to cart is blocked', async () => {
    const onStep = vi.fn()
    const page = makePage(() => ({ ok: false, status: 403, text: 'blocked' }))
    const result = await fullApiCheckout(page, { tcin: '123', onStep })
    expect(result).toMatchObject({ success: false, step: 'add_to_cart', status: 403 })
  })

  it('reports the payment step when setting payment fails', async () => {
    const page = makePage(({ url, method }) => {
      if (url.endsWith('/cart_items') && method === 'POST') return okCart
      if (url.includes('/cart?field_groups')) return okState
      if (url.includes('/payment_instructions')) return { ok: false, status: 400, text: 'bad cvv' }
      return { ok: true, data: {} }
    })
    const result = await fullApiCheckout(page, { tcin: '123', cvv: '000' })
    expect(result).toMatchObject({ success: false, step: 'payment', status: 400 })
  })
})
