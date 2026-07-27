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
  const setupPage = {
    goto: vi.fn(async () => {}),
    mouse: { move: vi.fn(async () => {}) },
    close: vi.fn(async () => {})
  }
  return {
    browser: vi.fn(() => (open ? {} : null)),
    newPage: vi.fn(async () => setupPage),
    pages: vi.fn(() => []),
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
    const pool = new BrowserPool({ setupWarmupMs: 0, setupMouseDelayMs: 0 })
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
    await pool.closeAll()
  })

  it('shares an in-flight launch when two jobs use the same account profile', async () => {
    const pool = new BrowserPool({ setupWarmupMs: 0, setupMouseDelayMs: 0 })
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
    await vi.waitFor(() => expect(resolveLaunch).toBeTypeOf('function'))
    resolveLaunch()

    await expect(first).resolves.toBe(context)
    await expect(second).resolves.toBe(context)
    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1)
    await pool.closeAll()
  })

  it('pins a pre-warmed context until the account is released', async () => {
    const pool = new BrowserPool({
      contextTimeout: 1,
      setupWarmupMs: 0,
      setupMouseDelayMs: 0
    })
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
    const pool = new BrowserPool({ setupWarmupMs: 0, setupMouseDelayMs: 0 })
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
    await pool.closeAll()
  })

  it('warms the requested retailer and never redirects Walmart to Target', async () => {
    const pool = new BrowserPool({ setupWarmupMs: 0 })
    const context = makeContext({ open: true })
    mocks.launchPersistentContext.mockReset()
    mocks.launchPersistentContext.mockResolvedValueOnce(context)

    await pool.launch('walmart-account', {
      profilePath: 'C:/tmp/walmart-account',
      proxy: '',
      retailer: 'walmart'
    })

    const setupPage = await context.newPage.mock.results[0].value
    expect(setupPage.goto).toHaveBeenCalledWith(
      'https://www.walmart.com/',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    )
    expect(setupPage.goto).not.toHaveBeenCalledWith('https://www.target.com/', expect.anything())
    await pool.closeAll()
  })

  it('waits for capacity instead of failing a checkout launch immediately', async () => {
    const pool = new BrowserPool({ maxConcurrent: 1, setupWarmupMs: 0, capacityWaitMs: 1000 })
    const firstContext = makeContext({ open: true })
    const secondContext = makeContext({ open: true })
    mocks.launchPersistentContext.mockReset()
    mocks.launchPersistentContext
      .mockResolvedValueOnce(firstContext)
      .mockResolvedValueOnce(secondContext)

    await pool.launch('first', {
      profilePath: 'C:/tmp/first',
      proxy: '',
      retailer: 'target'
    })
    const secondLaunch = pool.launch('second', {
      profilePath: 'C:/tmp/second',
      proxy: '',
      retailer: 'walmart',
      priority: 100
    })

    await vi.waitFor(() => expect(pool._capacityWaiters).toHaveLength(1))
    await pool.close('first')
    await expect(secondLaunch).resolves.toBe(secondContext)
    await pool.closeAll()
  })

  it('cancels active downloads before closing a persistent browser context', async () => {
    const pageHandlers = {}
    const downloadPage = {
      on: vi.fn((event, handler) => {
        pageHandlers[event] = handler
      })
    }
    const context = makeContext({ open: true })
    context.pages = vi.fn(() => [downloadPage])
    mocks.launchPersistentContext.mockReset()
    mocks.launchPersistentContext.mockResolvedValueOnce(context)
    const pool = new BrowserPool({ setupWarmupMs: 0 })

    await pool.launch('download-account', {
      profilePath: 'C:/tmp/download-account',
      proxy: ''
    })
    const download = {
      cancel: vi.fn(async () => {}),
      failure: vi.fn(() => new Promise(() => {}))
    }
    pageHandlers.download(download)

    await pool.close('download-account')

    expect(download.cancel).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('falls back to browser close when context shutdown times out', async () => {
    const browser = { close: vi.fn(async () => {}) }
    const context = makeContext({ open: true })
    context.browser = vi.fn(() => browser)
    context.close = vi.fn(() => new Promise(() => {}))
    mocks.launchPersistentContext.mockReset()
    mocks.launchPersistentContext.mockResolvedValueOnce(context)
    const pool = new BrowserPool({ setupWarmupMs: 0, closeTimeoutMs: 100 })

    await pool.launch('stuck-account', {
      profilePath: 'C:/tmp/stuck-account',
      proxy: ''
    })
    await pool.close('stuck-account')

    expect(browser.close).toHaveBeenCalledOnce()
    expect(pool.getActiveCount()).toBe(0)
  })
})
