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

  it('shares an in-flight launch when two jobs use the same account profile', async () => {
    const pool = new BrowserPool()
    const context = makeContext({ open: true })
    mocks.launchPersistentContext.mockReset()
    let resolveLaunch
    mocks.launchPersistentContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLaunch = () => resolve(context)
        })
    )

    const first = pool.launch('walmart-account', {
      profilePath: 'C:/tmp/walmart-account',
      proxy: ''
    })
    const second = pool.launch('walmart-account', {
      profilePath: 'C:/tmp/walmart-account',
      proxy: ''
    })
    resolveLaunch()

    await expect(first).resolves.toBe(context)
    await expect(second).resolves.toBe(context)
    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1)
  })

  it('pins a pre-warmed context until the account is released', async () => {
    const pool = new BrowserPool({ contextTimeout: 1 })
    const context = makeContext({ open: true })
    mocks.launchPersistentContext.mockReset()
    mocks.launchPersistentContext.mockResolvedValueOnce(context)

    await pool.pin('target-account', {
      profilePath: 'C:/tmp/target-account',
      proxy: ''
    })
    pool._lastActivity.set('target-account', 0)
    pool._checkStaleContexts()

    expect(pool.isPinned('target-account')).toBe(true)
    expect(context.close).not.toHaveBeenCalled()

    await pool.unpin('target-account', { close: true })
    expect(pool.isPinned('target-account')).toBe(false)
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('does not silently move an active cookie session to another proxy', async () => {
    const pool = new BrowserPool()
    const context = makeContext({ open: true })
    mocks.launchPersistentContext.mockReset()
    mocks.launchPersistentContext.mockResolvedValueOnce(context)

    await pool.launch('stable-account', {
      profilePath: 'C:/tmp/stable-account',
      proxy: 'proxy.example:80:user:session-one'
    })

    await expect(
      pool.launch('stable-account', {
        profilePath: 'C:/tmp/stable-account',
        proxy: 'proxy.example:80:user:session-two'
      })
    ).rejects.toThrow('different proxy')
    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1)
  })
})
