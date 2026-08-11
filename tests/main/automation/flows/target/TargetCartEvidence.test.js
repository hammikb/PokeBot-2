import { describe, expect, it, vi } from 'vitest'

import { resolveTargetCartState } from '../../../../../src/main/automation/flows/target/TargetCartEvidence.js'

describe('resolveTargetCartState', () => {
  it('converts authoritative CartEvidence without invoking the fallback parser', async () => {
    const confirmCart = vi.fn(async () => ({ present: false }))
    const cartState = await resolveTargetCartState({
      cartEvidence: {
        tcin: '123456',
        quantity: 1,
        unitPrice: 19.99,
        source: 'mutation-2xx',
        mutationStatus: 200,
        clickCount: 2,
        retryCount: 1,
        reloadCount: 0,
        confirmedAt: '2026-08-10T12:00:00.000Z'
      },
      confirmCart
    })
    expect(cartState).toEqual({
      present: true,
      quantity: 1,
      unitPrice: 19.99,
      source: 'mutation-2xx'
    })
    expect(confirmCart).not.toHaveBeenCalled()
  })

  it('uses the authoritative parser when browser evidence is absent', async () => {
    const expected = { present: true, quantity: 1, unitPrice: 19.99, source: 'item-control' }
    const confirmCart = vi.fn(async () => expected)
    await expect(resolveTargetCartState({ cartEvidence: null, confirmCart })).resolves.toBe(expected)
    expect(confirmCart).toHaveBeenCalledTimes(1)
  })
})
