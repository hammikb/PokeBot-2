import { describe, expect, it, vi } from 'vitest'
import { BrowserPool } from '../../../src/main/automation/BrowserPool.js'

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn()
}))

vi.mock('cloakbrowser', () => ({
  launchPersistentContext: mocks.launchPersistentContext
}))


function makeContext({ open = true } = {}) {
  const handlers = {}
  return {
    browser: vi.fn(() => (open ? {} : null)),
    on: vi.fn((event, handler) => {
      handlers[event] = handler
    }),
    close: vi.fn(async () => {
      open = false
      handlers.close?.()
    })
  }
}

describe('BrowserPool', () => {
  it('relaunches a saved profile when the cached context was closed manually', async () => {
    const pool = new BrowserPool()
    const closedContext = makeContext({ open: false })
    const freshContext = makeContext({ open: true })
    mocks.launchPersistentContext
      .mockResolvedValueOnce(closedContext)
      .mockResolvedValueOnce(freshContext)

    await pool.launch('target-account', {
      profilePath: 'C:/tmp/target-account',
      proxy: ''
    })
    const relaunched = await pool.launch('target-account', {
      profilePath: 'C:/tmp/target-account',
      proxy: ''
    })

    expect(relaunched).toBe(freshContext)
    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(2)
    expect(pool.getActiveCount()).toBe(1)
  })
})
