import { describe, expect, it } from 'vitest'

import {
  classifySamsPageText,
  isSamsCartAcknowledgementUrl,
  samsCurrentCartQuantity,
  samsCheckoutRetryDelay,
  samsSavedCardLast4
} from '../../../../src/main/automation/flows/samsclub.js'

describe("Sam's Club checkout state classification", () => {
  it('recognizes the live high-traffic waiting room', () => {
    expect(
      classifySamsPageText(
        "Hold tight for a moment High traffic is slowing things down a bit. We'll load this page when it's ready."
      )
    ).toBe('traffic-gate')
  })

  it('prioritizes the temporary checkout error over the checkout URL', () => {
    expect(
      classifySamsPageText(
        "Checkout We're having trouble with your request. We're working on fixing it. Please try again later.",
        'https://www.samsclub.com/checkout/review-order?cartId=abc'
      )
    ).toBe('checkout-error')
  })

  it('distinguishes settled unavailability from an actionable product page', () => {
    expect(classifySamsPageText('Shipping Not available Shop similar')).toBe('unavailable')
    expect(classifySamsPageText('Shipping Arrives Jul 23 Add to cart')).toBe('normal')
  })

  it('recognizes an empty cart and a normal review-order page', () => {
    expect(classifySamsPageText('Cart (0 items)')).toBe('empty-cart')
    expect(
      classifySamsPageText(
        'Checkout Review order',
        'https://www.samsclub.com/checkout/review-order'
      )
    ).toBe('checkout')
  })

  it('recognizes the live added-to-cart route', () => {
    expect(
      isSamsCartAcknowledgementUrl('https://www.samsclub.com/pac?id=19170800669&ip=69.98&qt=1')
    ).toBe(true)
    expect(isSamsCartAcknowledgementUrl('https://www.samsclub.com/cart')).toBe(false)
  })

  it('classifies additional checkout recovery and traffic messages', () => {
    expect(classifySamsPageText("We're experiencing high demand. Please wait.")).toBe(
      'traffic-gate'
    )
    expect(
      classifySamsPageText(
        'Something went wrong. Please try again later.',
        'https://www.samsclub.com/checkout/review-order?cartId=abc'
      )
    ).toBe('checkout-error')
  })

  it('backs off checkout retries without abandoning the warm session', () => {
    expect([1, 2, 3, 4, 8].map(samsCheckoutRetryDelay)).toEqual([750, 1500, 3000, 6000, 6000])
  })

  it("reads the saved card displayed on Sam's live review-order page", () => {
    expect(samsSavedCardLast4('Payment method Mastercard Ending in 5750 $35.18')).toBe('5750')
    expect(samsSavedCardLast4('Add a payment method')).toBeNull()
  })

  it('reads the current quantity without mistaking product-name numbers for quantity', () => {
    expect(
      samsCurrentCartQuantity(
        "Increase quantity Member's Mark Ultra Premium 2-Ply Toilet Paper 45 rolls, Current Quantity 1"
      )
    ).toBe(1)
  })
})
