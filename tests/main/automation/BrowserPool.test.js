import { describe, expect, it, vi } from 'vitest'
import {
  BrowserPool,
  clearTargetCartBeforeWarmup
} from '../../../src/main/automation/BrowserPool.js'

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
  it('clears stale Target cart items before warming the monitored product', async () => {
    const removeButton = {
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {})
    }
    const buttons = {
      count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
      nth: vi.fn(() => removeButton)
    }
    const page = {
      goto: vi.fn(async () => {}),
      locator: vi.fn(() => buttons),
      waitForTimeout: vi.fn(async () => {})
    }

    await expect(clearTargetCartBeforeWarmup(page)).resolves.toBe(1)
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.target.com/cart',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    )
    expect(removeButton.click).toHaveBeenCalledOnce()
  })

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

  describe('keepalive', () => {
    // Builds a context whose keepalive navigation returns `status`, optionally with a
    // captcha in the page, and lets the test drive the timer by hand.
    function makePinnedPool({ status = 200, captcha = false, onBlocked } = {}) {
      const page = {
        goto: vi.fn(async () => ({ status: () => status })),
        mouse: { move: vi.fn(async () => {}) },
        close: vi.fn(async () => {}),
        locator: vi.fn(() => ({
          first: () => ({ isVisible: async () => captcha, count: async () => (captcha ? 1 : 0) })
        })),
        $: vi.fn(async () => (captcha ? {} : null)),
        content: vi.fn(async () => (captcha ? '<html>press and hold</html>' : '<html>ok</html>')),
        url: vi.fn(() => 'https://www.target.com/')
      }
      const context = makeContext({ open: true })
      context.newPage = vi.fn(async () => page)
      mocks.launchPersistentContext.mockReset()
      mocks.launchPersistentContext.mockResolvedValue(context)
      const pool = new BrowserPool({ setupWarmupMs: 0, onBlocked })
      return { pool, context, page }
    }

    it('reschedules itself while the retailer answers normally', async () => {
      const { pool } = makePinnedPool({ status: 200 })
      await pool.pin('acct', { profilePath: 'C:/tmp/acct', proxy: '', retailer: 'target' })

      await pool._keepaliveTick('acct', 'target')

      expect(pool.isPinned('acct')).toBe(true)
      expect(pool._keepalive.has('acct')).toBe(true)
      await pool.closeAll()
    })

    it('stops dead on the first block instead of retrying into it', async () => {
      const onBlocked = vi.fn()
      const { pool } = makePinnedPool({ status: 429, onBlocked })
      await pool.pin('acct', { profilePath: 'C:/tmp/acct', proxy: '', retailer: 'target' })

      await pool._keepaliveTick('acct', 'target')

      // No rescheduled timer, no pin, no live context: nothing can issue another
      // request into a block that escalates with every request.
      expect(pool._keepalive.has('acct')).toBe(false)
      expect(pool.isPinned('acct')).toBe(false)
      expect(pool.getActiveCount()).toBe(0)
      expect(onBlocked).toHaveBeenCalledWith({
        accountId: 'acct',
        retailer: 'target',
        reason: 'HTTP 429'
      })
    })

    it('does not touch or close a pinned context while a page is active', async () => {
      const { pool, context } = makePinnedPool({ status: 429 })
      const checkoutPage = { isClosed: () => false }
      context.pages = vi.fn(() => [checkoutPage])
      await pool.pin('acct', { profilePath: 'C:/tmp/acct', proxy: '', retailer: 'target' })
      context.newPage.mockClear()

      await pool._keepaliveTick('acct', 'target')

      expect(context.newPage).not.toHaveBeenCalled()
      expect(pool.isPinned('acct')).toBe(true)
      expect(pool.getActiveCount()).toBe(1)
      await pool.closeAll()
    })

    it('unpinning cancels the keepalive so a stopped task stops touching the retailer', async () => {
      const { pool } = makePinnedPool({ status: 200 })
      await pool.pin('acct', { profilePath: 'C:/tmp/acct', proxy: '', retailer: 'target' })
      expect(pool._keepalive.has('acct')).toBe(true)
      expect(pool._warmPages.has('acct')).toBe(true)

      await pool.unpin('acct', { close: true })

      expect(pool._keepalive.has('acct')).toBe(false)
      expect(pool._warmPages.has('acct')).toBe(false)
      expect(pool.isPinned('acct')).toBe(false)
    })
  })
})
