import { describe, expect, it } from 'vitest'
import {
  parseCheckoutEventMetadata,
  sanitizeCheckoutEventMetadata
} from '../../../src/main/telemetry/CheckoutEventMetadata.js'

describe('CheckoutEventMetadata', () => {
  it('keeps only controlled flat metadata values', () => {
    expect(
      sanitizeCheckoutEventMetadata({
        eventType: 'cart_response',
        requestType: 'cart_mutation',
        responseKind: 'session_error',
        httpStatus: 401,
        attemptNumber: 2,
        retryAfterHonored: false,
        productUrl: 'https://www.target.com/private',
        cookies: 'secret',
        nested: { token: 'secret' },
        delayMs: -1
      })
    ).toEqual({
      eventType: 'cart_response',
      requestType: 'cart_mutation',
      responseKind: 'session_error',
      httpStatus: 401,
      attemptNumber: 2,
      retryAfterHonored: false
    })
  })

  it('returns an empty object for invalid serialized metadata', () => {
    expect(parseCheckoutEventMetadata('{bad')).toEqual({})
  })

  it('enforces enum and numeric upper bounds', () => {
    expect(
      sanitizeCheckoutEventMetadata({
        eventType: 'cart_retry',
        retryKind: 'rate_limit',
        attemptNumber: 10_000,
        retryNumber: 10_000,
        delayMs: 86_400_000,
        heldMs: 86_400_000,
        responseKind: 'unknown'
      })
    ).toEqual({
      eventType: 'cart_retry',
      retryKind: 'rate_limit',
      attemptNumber: 10_000,
      retryNumber: 10_000,
      delayMs: 86_400_000,
      heldMs: 86_400_000
    })
    expect(
      sanitizeCheckoutEventMetadata({
        eventType: 'unknown',
        attemptNumber: 10_001,
        retryNumber: 10_001,
        delayMs: 86_400_001,
        heldMs: 86_400_001
      })
    ).toEqual({})
  })
})
