import { describe, expect, it } from 'vitest'
import { safeUrl } from '../../../src/main/automation/CheckoutDiagnostics.js'

describe('CheckoutDiagnostics', () => {
  it('removes query strings and fragments from recorded URLs', () => {
    expect(safeUrl('https://checkout.example/order?token=secret&card=4111#payment')).toBe(
      'https://checkout.example/order'
    )
  })

  it('sanitizes malformed URLs without preserving query parameters', () => {
    expect(safeUrl('/checkout?session=secret#payment')).toBe('/checkout')
  })
})
