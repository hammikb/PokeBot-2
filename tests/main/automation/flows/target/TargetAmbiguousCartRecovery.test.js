import { describe, expect, it, vi } from 'vitest'

import { recoverAmbiguousTargetCart } from '../../../../../src/main/automation/flows/target.js'

// The recovery path must never navigate: it judges an unclear click purely from the
// header cart badge on whatever page it is already sitting on.
function makePage() {
  return {
    url: vi.fn(() => 'https://www.target.com/p/example/-/A-123456'),
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {})
  }
}

describe('recoverAmbiguousTargetCart', () => {
  it('confirms the add from an increase in the header cart badge without navigating', async () => {
    const page = makePage()
    const readCartQuantity = vi.fn(async () => 3)

    await expect(
      recoverAmbiguousTargetCart(page, '123456', {
        baselineCartQuantity: 1,
        readCartQuantity,
        timeoutMs: 2000
      })
    ).resolves.toEqual({
      present: true,
      quantity: 2,
      unitPrice: null,
      source: 'header-cart-badge',
      recoveryOutcome: 'present'
    })
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('does not confirm when the badge is positive but unchanged', async () => {
    const page = makePage()
    // Cart already held two unrelated items; a bare "2" must not read as our add.
    const readCartQuantity = vi.fn(async () => 2)

    await expect(
      recoverAmbiguousTargetCart(page, '123456', {
        baselineCartQuantity: 2,
        readCartQuantity,
        timeoutMs: 10,
        now: (() => {
          const stamps = [0, 5, 20]
          return () => (stamps.length > 1 ? stamps.shift() : stamps[0])
        })()
      })
    ).resolves.toMatchObject({ present: false, recoveryOutcome: 'timeout' })
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('reports absent when there is no baseline to compare against', async () => {
    const page = makePage()
    const readCartQuantity = vi.fn(async () => 5)

    await expect(
      recoverAmbiguousTargetCart(page, '123456', {
        baselineCartQuantity: null,
        readCartQuantity
      })
    ).resolves.toMatchObject({ present: false, recoveryOutcome: 'absent' })
    expect(readCartQuantity).not.toHaveBeenCalled()
  })

  it('stops polling once the probe budget is spent', async () => {
    const page = makePage()
    const stamps = [0, 500, 1000, 1500, 2000, 2500]
    const now = vi.fn(() => (stamps.length > 1 ? stamps.shift() : stamps[0]))
    const readCartQuantity = vi.fn(async () => 1)

    await expect(
      recoverAmbiguousTargetCart(page, '123456', {
        baselineCartQuantity: 1,
        readCartQuantity,
        timeoutMs: 2000,
        now
      })
    ).resolves.toMatchObject({ present: false, recoveryOutcome: 'timeout' })
    expect(readCartQuantity.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('treats an unreadable badge as unresolved rather than confirming', async () => {
    const page = makePage()
    const readCartQuantity = vi.fn(async () => {
      throw new Error('detached frame')
    })

    await expect(
      recoverAmbiguousTargetCart(page, '123456', {
        baselineCartQuantity: 0,
        readCartQuantity,
        timeoutMs: 500
      })
    ).resolves.toMatchObject({ present: false, recoveryOutcome: 'timeout' })
  })
})
