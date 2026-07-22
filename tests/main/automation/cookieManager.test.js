import { describe, expect, it, vi } from 'vitest'
import { CookieManager } from '../../../src/main/automation/cookieManager.js'

describe('CookieManager', () => {
  it('reports health without returning cookie values', async () => {
    const manager = new CookieManager()
    const context = {
      cookies: vi.fn().mockResolvedValue([
        { name: 'session', value: 'secret', domain: '.target.com', expires: -1, secure: true },
        { name: 'saved', value: 'private', domain: '.target.com', expires: 5000, secure: true }
      ])
    }

    const result = await manager.inspectCookies(context, 'target', 1000)
    expect(result).toMatchObject({ healthy: true, total: 2, session: 1, persistent: 1 })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('disables synthetic generation and destructive rotation', async () => {
    const manager = new CookieManager()
    await expect(manager.generateFreshCookies()).rejects.toThrow('site-issued')
    await expect(manager.rotateCookies()).resolves.toMatchObject({ success: false })
  })
})
