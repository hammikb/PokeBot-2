import { describe, expect, it } from 'vitest'
import { parseTargetCartQuantity } from '../../../src/main/automation/flows/target.js'

describe('Target cart quantity parsing', () => {
  it.each([
    ['1', 1],
    ['Qty: 2', 2],
    ['Quantity 3', 3],
    ['2 in cart', 2],
    ['1 item in your cart', 1]
  ])('reads %s as %i', (value, expected) => {
    expect(parseTargetCartQuantity(value)).toBe(expected)
  })

  it.each(['', 'Add to cart', 'Cart subtotal $29.99', 'Qty 0'])(
    'does not guess a quantity from %s',
    (value) => {
      expect(parseTargetCartQuantity(value)).toBeNull()
    }
  )
})
