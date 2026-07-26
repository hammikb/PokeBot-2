import { describe, expect, it } from 'vitest'
import {
  parseDisplayedPrice,
  validateCheckoutSafety
} from '../../../src/main/automation/CheckoutSafety.js'
import { validateTargetCartForCheckout } from '../../../src/main/automation/flows/target/TargetCheckoutSafety.js'

describe('checkout safety', () => {
  it('parses the lowest displayed item price without using tax totals', () => {
    expect(parseDisplayedPrice('Regular $39.99, now $29.97')).toBe(29.97)
  })

  it('rejects the wrong item, excess quantity, price, and Walmart marketplace seller', () => {
    expect(() =>
      validateCheckoutSafety({
        retailer: 'Walmart',
        expectedItemId: '123',
        actualItemId: '999',
        actualQuantity: 1
      })
    ).toThrow('requested item')

    expect(() =>
      validateCheckoutSafety({
        retailer: 'Walmart',
        expectedItemId: '123',
        actualItemId: '123',
        requestedQuantity: 1,
        actualQuantity: 2
      })
    ).toThrow('exceeds requested maximum')

    expect(() =>
      validateCheckoutSafety({
        retailer: 'Walmart',
        expectedItemId: '123',
        actualItemId: '123',
        actualQuantity: 1,
        maxUnitPrice: 30,
        actualUnitPrice: 35
      })
    ).toThrow('exceeds maximum')

    expect(() =>
      validateCheckoutSafety({
        retailer: 'Walmart',
        expectedItemId: '123',
        actualItemId: '123',
        actualQuantity: 1,
        seller: 'Sold and shipped by Marketplace Cards LLC',
        requireRetailerSeller: true
      })
    ).toThrow('sold by Walmart')
  })

  it('accepts a limited Target quantity when it remains under the requested maximum', () => {
    expect(
      validateTargetCartForCheckout({
        tcin: '123',
        cartState: { present: true, quantity: 1, unitPrice: 29.99 },
        buyLimit: 2,
        maxPrice: 30
      })
    ).toMatchObject({ quantity: 1, requestedQuantity: 2, quantityLimited: true })
  })
})
