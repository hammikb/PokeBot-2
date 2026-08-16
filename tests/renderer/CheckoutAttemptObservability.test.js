import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CheckoutAttemptObservability from '../../src/renderer/src/components/CheckoutAttemptObservability'
import { AttemptDetails } from '../../src/renderer/src/pages/CheckoutAnalytics'

describe('CheckoutAttemptObservability', () => {
  it('renders milestones, cart attempts, and account contention', () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutAttemptObservability, {
        attempt: {
          milestones: [
            { stage: 'drop_detected', reached: true, reachedMs: 0 },
            { stage: 'cart_ready', reached: false, reachedMs: null }
          ],
          cartAttempts: [
            {
              elapsedMs: 1200,
              attemptNumber: 1,
              responseKind: 'rate_limit',
              httpStatus: 429,
              delayMs: 2000
            }
          ],
          leaseSummary: { contended: true, state: 'busy', heldMs: null }
        }
      })
    )

    expect(html).toContain('429')
    expect(html).toContain('Rate limit')
    expect(html).toContain('Account busy')
  })

  it('omits empty structured sections for legacy attempts', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(CheckoutAttemptObservability, {
          attempt: { milestones: [], cartAttempts: [], leaseSummary: null }
        })
      )
    ).not.toThrow()

    const html = renderToStaticMarkup(
      createElement(CheckoutAttemptObservability, {
        attempt: { milestones: [], cartAttempts: [], leaseSummary: null }
      })
    )
    expect(html).not.toContain('Cart attempts')
    expect(html).not.toContain('Account summary')
  })

  it('orders milestone pills by the checkout telemetry stages', () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutAttemptObservability, {
        attempt: {
          milestones: [
            { stage: 'cart_ready', reached: true, reachedMs: 1200 },
            { stage: 'cart_attempted', reached: true, reachedMs: 800 },
            { stage: 'browser_launch', reached: true, reachedMs: 100 }
          ]
        }
      })
    )

    expect(html.indexOf('Browser Launch')).toBeLessThan(html.indexOf('Cart Attempted'))
    expect(html.indexOf('Cart Attempted')).toBeLessThan(html.indexOf('Cart Ready'))
  })

  it('places diagnostics before the existing timeline without removing artifacts or events', () => {
    const html = renderToStaticMarkup(
      createElement(AttemptDetails, {
        attempt: {
          failureCode: 'rate_limited',
          failureStage: 'cart_attempted',
          errorSummary: 'Target rate limited the cart request.',
          experiment: { checkout_mode: 'target' },
          artifacts: [{ type: 'screenshot', path: 'debug-traces/cart.png' }],
          milestones: [{ stage: 'drop_detected', reached: true, reachedMs: 0 }],
          cartAttempts: [
            {
              elapsedMs: 1200,
              attemptNumber: 1,
              responseKind: 'rate_limit',
              httpStatus: 429,
              delayMs: 2000
            }
          ],
          leaseSummary: { contended: true, state: 'busy', heldMs: null },
          events: [
            {
              sequence: 1,
              elapsedMs: 1200,
              stage: 'cart_attempted',
              detail: 'Target cart response: rate limit'
            }
          ]
        }
      })
    )

    const diagnosticsIndex = html.indexOf('Cart attempts')
    expect(diagnosticsIndex).toBeGreaterThanOrEqual(0)
    expect(diagnosticsIndex).toBeLessThan(html.indexOf('Event timeline'))
    expect(html).toContain('debug-traces/cart.png')
    expect(html).toContain('Target cart response: rate limit')
  })
})
