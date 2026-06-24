import { describe, it, expect, vi, beforeEach } from 'vitest'
import { request } from 'playwright-core'
import { proxyToPlaywright, testProxy } from '../../../src/main/proxies/ProxyTest.js'

vi.mock('playwright-core', () => ({
  request: {
    newContext: vi.fn()
  }
}))


describe('ProxyTest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('converts username/password proxy strings into Playwright proxy config', () => {
    expect(proxyToPlaywright('1.2.3.4:8080:user:pass')).toEqual({
      server: 'http://1.2.3.4:8080',
      username: 'user',
      password: 'pass'
    })
  })

  it('tests target and walmart separately through the proxy', async () => {
    const dispose = vi.fn()
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: () => 200 })
      .mockResolvedValueOnce({ status: () => 403 })

    request.newContext.mockResolvedValue({ get, dispose })

    const result = await testProxy('1.2.3.4:8080:user:pass')

    expect(request.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: {
          server: 'http://1.2.3.4:8080',
          username: 'user',
          password: 'pass'
        }
      })
    )
    expect(get).toHaveBeenCalledWith(
      'https://www.target.com/',
      expect.objectContaining({ timeout: 20000 })
    )
    expect(get).toHaveBeenCalledWith(
      'https://www.walmart.com/',
      expect.objectContaining({ timeout: 20000 })
    )
    expect(dispose).toHaveBeenCalled()
    expect(result).toEqual({
      proxy: '1.2.3.4:8080:user:pass',
      target: { ok: true, status: 200 },
      walmart: { ok: false, status: 403 }
    })
  })

  it('returns a failed retailer result when the request errors', async () => {
    const dispose = vi.fn()
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ status: () => 200 })

    request.newContext.mockResolvedValue({ get, dispose })

    const result = await testProxy('1.2.3.4:8080')

    expect(result.target).toEqual({ ok: false, error: 'timed out' })
    expect(result.walmart).toEqual({ ok: true, status: 200 })
  })

  it('can test direct connection without a proxy', async () => {
    const dispose = vi.fn()
    const get = vi.fn().mockResolvedValue({ status: () => 200 })

    request.newContext.mockResolvedValue({ get, dispose })

    const result = await testProxy(null)

    expect(request.newContext).toHaveBeenCalledWith(
      expect.not.objectContaining({
        proxy: expect.anything()
      })
    )
    expect(result.proxy).toBe('direct')
    expect(result.target).toEqual({ ok: true, status: 200 })
    expect(result.walmart).toEqual({ ok: true, status: 200 })
  })
})
