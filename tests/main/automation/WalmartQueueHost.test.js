import { describe, expect, it, vi } from 'vitest'
import { WalmartQueueHost } from '../../../src/main/automation/WalmartQueueHost.js'
import { parseTickets, parseWrCookie } from '../../../src/main/automation/walmartQueue.js'

// Shape captured from a live drop, 2026-08-19.
const ticket = (queue, itemId, over = {}) => ({
  site: 'usgm',
  queue,
  shard: 48,
  ticket: 62813,
  state: 'pending',
  expires: 1787275313827,
  signature: 'sig==',
  itemId,
  offerId: 'OFFER' + itemId,
  nextRefreshRelativeTime: 38000,
  expectedTurnTimeUnixTimestamp: Date.now() + 1800000,
  customMetadata: {
    admissionLikelihood: 'unlikely',
    item: { itemID: itemId, name: 'Item ' + itemId, currentPrice: '$69.00' }
  },
  ...over
})

const hostWith = (payload) => {
  const get = vi.fn().mockResolvedValue({ status: 200, data: payload, headers: {} })
  return { host: new WalmartQueueHost({ http: { get }, getCookieHeader: () => 'auth=x' }), get }
}

describe('WalmartQueueHost', () => {
  it('refreshes every held ticket with ONE request', async () => {
    // The whole reason this replaces browser-per-queue: validateTickets takes
    // no parameters and returns one entry per queue held.
    const { host, get } = hostWith([
      ticket('qAAA', '19965460207'),
      ticket('qBBB', '19594412970', { ticket: 4881 }),
      ticket('qCCC', '20413908978', { ticket: 77 })
    ])
    await host.pollOnce()

    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('https://q-api.www.walmart.com/validateTickets')
    expect(host.list()).toHaveLength(3)
    expect(host.stats()).toMatchObject({ tickets: 3, inQueue: 3, ready: 0, errors: 0 })
  })

  it('adopts the cadence Walmart asks for instead of guessing', async () => {
    const { host } = hostWith([ticket('qAAA', '1', { nextRefreshRelativeTime: 38000 })])
    await host.pollOnce()
    expect(host.stats().pollMs).toBe(38000)
  })

  it('never polls faster than the floor even if the server says 0', async () => {
    const { host } = hostWith([ticket('qAAA', '1', { nextRefreshRelativeTime: 1 })])
    await host.pollOnce()
    expect(host.stats().pollMs).toBeGreaterThanOrEqual(2000)
  })

  it('emits ready exactly once when a ticket turns valid', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [ticket('qAAA', '1')] })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: [ticket('qAAA', '1', { state: 'valid' })]
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: [ticket('qAAA', '1', { state: 'valid' })]
      })
    const host = new WalmartQueueHost({ http: { get }, getCookieHeader: () => 'auth=x' })
    const ready = vi.fn()
    host.on('ready', ready)

    await host.pollOnce()
    expect(ready).not.toHaveBeenCalled()
    await host.pollOnce()
    expect(ready).toHaveBeenCalledTimes(1)
    await host.pollOnce()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(ready.mock.calls[0][0]).toMatchObject({ queueId: 'qAAA', offerId: 'OFFER1' })
  })

  it('keeps user intent (auto checkout) across polls', async () => {
    const { host } = hostWith([ticket('qAAA', '1')])
    host.track({ queueId: 'qAAA', autoCheckout: true, itemName: 'mine' })
    await host.pollOnce()
    expect(host.list()[0].autoCheckout).toBe(true)
    expect(host.list()[0].itemName).toBe('Item 1')
  })

  it('survives a poll failure without dropping tickets', async () => {
    const { host } = hostWith([ticket('qAAA', '1')])
    await host.pollOnce()
    const failing = new WalmartQueueHost({
      http: { get: vi.fn().mockRejectedValue(new Error('network down')) },
      getCookieHeader: () => 'auth=x'
    })
    failing.track({ queueId: 'qAAA' })
    const errors = vi.fn()
    failing.on('error', errors)
    await expect(failing.pollOnce()).resolves.toBeInstanceOf(Array)
    expect(errors).toHaveBeenCalled()
    expect(failing.list()).toHaveLength(1)
  })

  it('refuses to call the API without a session, with a readable reason', async () => {
    // cookieManager has no getCookieHeader today, so this is the real-world
    // path. An empty cookie must not produce a mystery HTTP 403.
    const get = vi.fn()
    const host = new WalmartQueueHost({ http: { get }, getCookieHeader: () => '' })
    host.track({ queueId: 'qAAA' })

    await expect(host.join('qAAA')).rejects.toThrow(/sign in to a Walmart account/i)
    expect(get).not.toHaveBeenCalled()

    await host.pollOnce()
    expect(get).not.toHaveBeenCalled()
    expect(host.list()[0].error).toMatch(/sign in to a Walmart account/i)
    expect(host.stats().errors).toBe(1)
  })

  it('reads the queue id from the redirect header without downloading the page', async () => {
    const qpdata = encodeURIComponent(
      JSON.stringify({ queued: true, queue: 'qZZZ', url: 'x', customMetadata: {} })
    )
    const get = vi.fn().mockResolvedValue({
      status: 307,
      headers: { location: `/qp?qpdata=${qpdata}` },
      data: ''
    })
    const host = new WalmartQueueHost({ http: { get }, getCookieHeader: () => 'auth=x' })

    const status = await host.resolveQueueId('19965460207')
    expect(status.queueId).toBe('qZZZ')
    expect(get.mock.calls[0][1].maxRedirects).toBe(0)

    // Second call must be served from cache: joining only needs the queue id.
    const again = await host.resolveQueueId('19965460207')
    expect(again.queueId).toBe('qZZZ')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('reports no queue when the PDP does not redirect', async () => {
    const get = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      data: '<html>normal product page</html>'
    })
    const host = new WalmartQueueHost({ http: { get }, getCookieHeader: () => 'auth=x' })
    expect(await host.resolveQueueId('123456')).toBeNull()
  })

  it('does not take a second spot in a line it already holds', async () => {
    // Tickets are keyed by queueId, so an itemId check has to scan values.
    // Getting this wrong double-joined item 20278470684 in production.
    const qpdata = encodeURIComponent(
      JSON.stringify({ queued: true, queue: 'qDUP', url: 'x', customMetadata: {} })
    )
    const get = vi.fn().mockImplementation((url) => {
      if (url.includes('/ip/')) {
        return Promise.resolve({
          status: 307,
          headers: { location: `/qp?qpdata=${qpdata}` },
          data: ''
        })
      }
      return Promise.resolve({ status: 200, headers: { 'set-cookie': [] }, data: '' })
    })
    const host = new WalmartQueueHost({ http: { get }, getCookieHeader: () => 'auth=x' })
    host._tickets.set('qDUP', { queueId: 'qDUP', itemId: '20278470684', ticket: 4242 })

    expect(host.isHoldingItem('20278470684')).toBe(true)
    expect(await host.joinByItem({ itemId: '20278470684' })).toBeNull()
    const result = await host.scanAndJoin(['20278470684'])
    expect(result.joined).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('mirrors the ticket cookie into the browser session', async () => {
    // Tickets are taken over HTTP but the purchase happens in the browser --
    // without this the browser shows no queue and cannot check out when admitted.
    const wr = 'qAAA%3Dsite%253Dusgm%252Cticket%253D99%252Cstate%253Dpending'
    const get = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: { 'set-cookie': [`wr=${wr}; Path=/`] }, data: '' })
    const onTicketCookie = vi.fn().mockResolvedValue(true)
    const host = new WalmartQueueHost({
      http: { get },
      getCookieHeader: () => 'auth=x',
      onTicketCookie
    })

    await host.join('qAAA', { itemId: '1' })
    await vi.waitFor(() => expect(onTicketCookie).toHaveBeenCalledOnce())
    expect(onTicketCookie).toHaveBeenCalledWith('wr', wr)
    expect(host.list()[0].ticket).toBe(99)
  })

  it('keeps the ticket even if writing it to the browser fails', async () => {
    const wr = 'qAAA%3Dsite%253Dusgm%252Cticket%253D77%252Cstate%253Dpending'
    const get = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: { 'set-cookie': [`wr=${wr}; Path=/`] }, data: '' })
    const host = new WalmartQueueHost({
      http: { get },
      getCookieHeader: () => 'auth=x',
      onTicketCookie: vi.fn().mockRejectedValue(new Error('browser closed'))
    })
    await host.join('qAAA', { itemId: '1' })
    expect(host.list()[0].ticket).toBe(77)
  })

  it('discovers items from the listing, including ones never dropped', async () => {
    // The gap this closes: 19994265476 and 20708870386 had queues open but had
    // never produced a drop, so a candidate list built from tasks/drop_history
    // missed them entirely.
    const listing = '"usItemId":"19994265476" x "usItemId":"20708870386"'
    const get = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: listing })
    const host = new WalmartQueueHost({ http: { get }, getCookieHeader: () => 'auth=x' })
    const ids = await host.discoverItemIds('https://www.walmart.com/search?q=pokemon')
    expect(ids).toEqual(['19994265476', '20708870386'])
  })

  it('falls back to the browser when HTTP discovery is blocked', async () => {
    // Confirmed in production: PerimeterX 403s axios on /search regardless of
    // cookies -- it keys on the TLS fingerprint. The stealth browser passes.
    const get = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: '<title>Robot or human?</title>' })
    const fetchPage = vi.fn().mockResolvedValue('"usItemId":"19594412970"')
    const host = new WalmartQueueHost({
      http: { get },
      getCookieHeader: () => 'auth=x',
      fetchPage
    })
    const ids = await host.discoverItemIds('https://www.walmart.com/search?q=x')
    expect(fetchPage).toHaveBeenCalledOnce()
    expect(ids).toEqual(['19594412970'])
  })

  it('gives up quietly when even the browser is blocked', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: '<title>Robot or human?</title>' })
    const host = new WalmartQueueHost({
      http: { get },
      getCookieHeader: () => 'auth=x',
      fetchPage: vi.fn().mockResolvedValue('<title>Robot or human?</title>')
    })
    expect(await host.discoverItemIds('https://www.walmart.com/search?q=x')).toEqual([])
  })

  it('recovers held tickets from the wr cookie after a restart', () => {
    const wr =
      'q21f208f5c2194%3Dsite%253Dusgm%252Cshard%253D48%252Cticket%253D62813' +
      '%252Cstate%253Dpending%252CitemId%253D19965460207%252CofferId%253DBACA8' +
      '%2Cq9f765cd305d44%3Dsite%253Dusgm%252Cshard%253D24%252Cticket%253D4881' +
      '%252Cstate%253Dpending%252CitemId%253D19594412970%252CofferId%253D6EE2F'
    const host = new WalmartQueueHost({ http: { get: vi.fn() }, getCookieHeader: () => 'auth=x' })
    const restored = host.restoreFromCookie(wr)
    expect(restored).toHaveLength(2)
    expect(restored.map((t) => t.ticket).sort()).toEqual([4881, 62813])
    expect(restored[0].itemId).toBe('19965460207')
  })
})

describe('queue parsing helpers', () => {
  it('parseTickets tolerates junk', () => {
    expect(parseTickets(null)).toEqual([])
    expect(parseTickets('not json')).toEqual([])
    expect(parseTickets([{ nope: 1 }])).toEqual([])
  })

  it('parseWrCookie splits on queue blocks, not inner commas', () => {
    const blocks = parseWrCookie(
      'qAAA%3Dsite%253Dusgm%252Cshard%253D1%252Cticket%253D5' +
        '%2CqBBB%3Dsite%253Dusgm%252Cshard%253D2%252Cticket%253D6'
    )
    expect(blocks.map((b) => b.queueId)).toEqual(['qAAA', 'qBBB'])
    expect(blocks.map((b) => b.ticket)).toEqual([5, 6])
  })
})
