import { describe, expect, it, vi } from 'vitest'
import { cleanupTargetCheckoutPage } from '../../../../../src/main/automation/flows/target.js'

function makePage() {
  return { close: vi.fn(async () => {}) }
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
