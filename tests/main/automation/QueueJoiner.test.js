import { describe, expect, it, vi } from 'vitest'
import { QueueJoiner } from '../../../src/main/automation/QueueJoiner.js'

function queueToken(overrides = {}) {
  return encodeURIComponent(
    JSON.stringify({
      queued: true,
      queue: 'queue-drop-1',
      ticket: 2788,
      state: 'pending',
      nextRefreshRelativeTime: 30_000,
      customMetadata: {
        item: {
          itemID: '19380764160',
          name: 'Perfect Order Booster Bundle',
          currentPrice: '$29.97'
        }
      },
      ...overrides
    })
  )
}

function makePage({
  url = 'https://www.walmart.com/ip/perfect-order/19380764160',
  content = '',
  bodyText = ''
} = {}) {
  const holdButton = {
    count: vi.fn(async () => 1),
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {})
  }
  const page = {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => url),
    content: vi.fn(async () => content),
    locator: vi.fn(() => ({
      innerText: vi.fn(async () => bodyText),
      first: vi.fn(() => holdButton)
    })),
    getByRole: vi.fn(() => ({ first: vi.fn(() => holdButton) })),
    waitForTimeout: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }
  return { page, holdButton }
}

function makeContext(page, { newPageError = null } = {}) {
  return {
    newPage: newPageError
      ? vi.fn(async () => {
          throw newPageError
        })
      : vi.fn(async () => page),
    close: vi.fn(async () => {})
  }
}

const ACCOUNT = {
  id: 'account-1',
  name: 'Walmart Account',
  profile_path: 'C:/profiles/account-1',
  proxy: null
}

describe('QueueJoiner', () => {
  it('captures embedded qpdata and includes its stable ticket on checkout-ready handoff', async () => {
    const token = queueToken()
    const { page } = makePage({
      content: `<a href="/qp?qpdata=${token}&source=item">Queue</a>`,
      bodyText: 'Ready to checkout'
    })
    const context = makeContext(page)
    const browserPool = {
      launch: vi.fn(async () => context),
      launchContext: vi.fn()
    }
    const joiner = new QueueJoiner({ browserPool, maxWaitMin: 1, rewatchSec: 0 })
    const turns = []
    joiner.on('turn', (event) => turns.push(event))

    joiner.start('task-1', {
      productUrl: 'https://www.walmart.com/ip/perfect-order/19380764160',
      label: 'Perfect Order',
      account: ACCOUNT
    })

    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(turns[0]).toMatchObject({
      id: 'task-1',
      phase: 'turn',
      ticket: 2788,
      queueCycleId: 'walmart-queue:2788',
      status: {
        ticket: 2788,
        queueId: 'queue-drop-1',
        itemId: '19380764160',
        yourTurn: true,
        queueCycleId: 'walmart-queue:2788'
      },
      context,
      page
    })
    expect(joiner.isJoining('task-1')).toBe(true)
    expect(page.close).not.toHaveBeenCalled()
    expect(context.close).not.toHaveBeenCalled()

    const job = joiner._jobs.get('task-1')
    expect(
      joiner._emitTurn('task-1', job, 'Perfect Order', {
        status: { yourTurn: true },
        message: 'duplicate'
      })
    ).toBe(false)
    expect(turns).toHaveLength(1)

    await joiner.stop('task-1')
    expect(page.close).toHaveBeenCalledTimes(1)
    expect(context.close).not.toHaveBeenCalled()
  })

  it('removes a normal timeout job and closes only its page in a shared account context', async () => {
    const { page } = makePage()
    const context = makeContext(page)
    const browserPool = { launch: vi.fn(async () => context) }
    const joiner = new QueueJoiner({ browserPool, maxWaitMin: 0 })

    joiner.start('shared-timeout', {
      productUrl: 'https://www.walmart.com/ip/item/1',
      label: 'Item',
      account: ACCOUNT
    })

    await vi.waitFor(() => expect(joiner.isJoining('shared-timeout')).toBe(false))
    expect(page.close).toHaveBeenCalledTimes(1)
    expect(context.close).not.toHaveBeenCalled()
  })

  it('closes an owned throwaway context when no queue opens', async () => {
    const { page } = makePage()
    const context = makeContext(page)
    const browserPool = { launchContext: vi.fn(async () => context) }
    const joiner = new QueueJoiner({ browserPool, maxWaitMin: 0 })

    joiner.start('owned-timeout', {
      productUrl: 'https://www.walmart.com/ip/item/1',
      label: 'Item',
      account: null
    })

    await vi.waitFor(() => expect(joiner.isJoining('owned-timeout')).toBe(false))
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(page.close).not.toHaveBeenCalled()
  })

  it('removes a crashed job and closes the context it owns', async () => {
    const context = makeContext(null, { newPageError: new Error('renderer crashed') })
    const browserPool = { launchContext: vi.fn(async () => context) }
    const joiner = new QueueJoiner({ browserPool, maxWaitMin: 1 })
    const progress = []
    joiner.on('progress', (event) => progress.push(event))

    joiner.start('crashed', {
      productUrl: 'https://www.walmart.com/ip/item/1',
      label: 'Item',
      account: null
    })

    await vi.waitFor(() => expect(joiner.isJoining('crashed')).toBe(false))
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(progress).toContainEqual(
      expect.objectContaining({
        id: 'crashed',
        phase: 'error',
        message: 'renderer crashed'
      })
    )
  })

  it('derives a stable non-clock queue cycle when a qpdata token has no ticket', () => {
    const joiner = new QueueJoiner({ browserPool: {} })
    const token = queueToken({ ticket: undefined })
    const firstJob = { queueStatus: null, queueCycleId: null }
    const secondJob = { queueStatus: null, queueCycleId: null }

    const first = joiner._captureQueueStatus(firstJob, `https://www.walmart.com/qp?qpdata=${token}`)
    const second = joiner._captureQueueStatus(
      secondJob,
      `https://www.walmart.com/qp?qpdata=${token}`
    )

    expect(first.ticket).toBeUndefined()
    expect(first.queueCycleId).toBe('walmart-queue:queue-drop-1:19380764160')
    expect(second.queueCycleId).toBe(first.queueCycleId)
  })

  it('uses a stable token digest when qpdata has neither a ticket nor queue id', () => {
    const joiner = new QueueJoiner({ browserPool: {} })
    const token = queueToken({ ticket: undefined, queue: undefined })
    const firstJob = { queueStatus: null, queueCycleId: null }
    const secondJob = { queueStatus: null, queueCycleId: null }

    const first = joiner._captureQueueStatus(firstJob, token)
    const second = joiner._captureQueueStatus(secondJob, token)

    expect(first.queueCycleId).toMatch(/^walmart-queue:token:[a-f0-9]{24}$/)
    expect(second.queueCycleId).toBe(first.queueCycleId)
  })
})
