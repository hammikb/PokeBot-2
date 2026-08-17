import { describe, expect, it, vi } from 'vitest'
import { BrowserPool } from '../../../src/main/automation/BrowserPool.js'

describe('BrowserPool checkout page reservation', () => {
  it('reuses an open page and replaces it after it closes', async () => {
    const first = { isClosed: vi.fn(() => false) }
    const second = { isClosed: vi.fn(() => false) }
    const context = {
      newPage: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    }
    const pool = new BrowserPool()

    expect(await pool.getCheckoutPage('account-1', context)).toBe(first)
    expect(await pool.getCheckoutPage('account-1', context)).toBe(first)

    first.isClosed.mockReturnValue(true)

    expect(await pool.getCheckoutPage('account-1', context)).toBe(second)
    expect(context.newPage).toHaveBeenCalledTimes(2)
  })
})
