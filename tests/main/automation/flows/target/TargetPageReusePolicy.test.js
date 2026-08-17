import { describe, expect, it } from 'vitest'
import { classifyTargetPageReuse } from '../../../../../src/main/automation/flows/target/TargetPageReusePolicy.js'

function makePage({ url = 'https://www.target.com/p/example/-/A-123', closed = false } = {}) {
  return {
    url: () => url,
    isClosed: () => closed
  }
}

describe('TargetPageReusePolicy', () => {
  it.each([
    'Target browser add-to-cart was not confirmed',
    'Target did not confirm the requested item in the cart',
    'Target high-demand add-to-cart retry window expired',
    'Target fulfillment is still loading',
    'Target availability did not settle',
    'page.goto: net::ERR_ABORTED at https://www.target.com/checkout'
  ])('preserves an open Target page for recoverable failure: %s', (error) => {
    expect(
      classifyTargetPageReuse({
        error,
        page: makePage(),
        orderSubmissionAttempted: false
      })
    ).toMatchObject({ preserve: true })
  })

  it.each([
    'Target cart session rejected with HTTP 401',
    'HTTP 403',
    'Target security challenge did not clear',
    'Item is out of stock (Target availability settled)',
    'Unexpected Target failure'
  ])('discards an unsafe or unclassified failure: %s', (error) => {
    expect(
      classifyTargetPageReuse({
        error,
        page: makePage(),
        orderSubmissionAttempted: false
      })
    ).toMatchObject({ preserve: false })
  })

  it('discards a recoverable failure after order submission', () => {
    expect(
      classifyTargetPageReuse({
        error: 'Target did not confirm the requested item in the cart',
        page: makePage(),
        orderSubmissionAttempted: true
      })
    ).toEqual({ preserve: false, reason: 'submission-attempted' })
  })

  it('discards a closed page or a page outside a Target-owned origin', () => {
    const error = 'Target did not confirm the requested item in the cart'
    expect(
      classifyTargetPageReuse({
        error,
        page: makePage({ closed: true }),
        orderSubmissionAttempted: false
      })
    ).toEqual({ preserve: false, reason: 'page-closed' })
    expect(
      classifyTargetPageReuse({
        error,
        page: makePage({ url: 'https://example.com/' }),
        orderSubmissionAttempted: false
      })
    ).toEqual({ preserve: false, reason: 'non-target-origin' })
  })
})
