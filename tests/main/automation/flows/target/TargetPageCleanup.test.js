import { describe, expect, it, vi } from 'vitest'
import { cleanupTargetCheckoutPage } from '../../../../../src/main/automation/flows/target.js'

function makePage() {
  return {
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    url: vi.fn(() => 'https://www.target.com/p/example/-/A-123')
  }
}

describe('Target checkout page cleanup', () => {
  it('keeps a pooled page after an approved recoverable failure', async () => {
    const page = makePage()

    await cleanupTargetCheckoutPage({
      page,
      pooled: true,
      requiresManual: false,
      reuseDecision: {
        preserve: true,
        reason: 'recoverable-pre-submission-failure'
      }
    })

    expect(page.close).not.toHaveBeenCalled()
  })

  it('classifies the actual flow error before deciding whether to preserve the page', async () => {
    const page = makePage()

    await cleanupTargetCheckoutPage({
      page,
      pooled: true,
      requiresManual: false,
      error: new Error('Target did not confirm the requested item in the cart'),
      orderSubmissionAttempted: false
    })

    expect(page.close).not.toHaveBeenCalled()
  })

  it('closes a recoverable page when it is not owned by the pool', async () => {
    const page = makePage()

    await cleanupTargetCheckoutPage({
      page,
      pooled: false,
      requiresManual: false,
      reuseDecision: {
        preserve: true,
        reason: 'recoverable-pre-submission-failure'
      }
    })

    expect(page.close).toHaveBeenCalledOnce()
  })

  it('closes a pooled page after an unsafe failure', async () => {
    const page = makePage()

    await cleanupTargetCheckoutPage({
      page,
      pooled: true,
      requiresManual: false,
      reuseDecision: { preserve: false, reason: 'unsafe-failure' }
    })

    expect(page.close).toHaveBeenCalledOnce()
  })

  it('keeps existing manual-review pages regardless of reuse classification', async () => {
    const page = makePage()

    await cleanupTargetCheckoutPage({
      page,
      pooled: true,
      requiresManual: true,
      reuseDecision: { preserve: false, reason: 'submission-attempted' }
    })

    expect(page.close).not.toHaveBeenCalled()
  })
})
