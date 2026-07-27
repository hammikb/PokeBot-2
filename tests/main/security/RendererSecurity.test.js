import { describe, expect, it, vi } from 'vitest'
import {
  configureRendererSecurity,
  isSafeExternalUrl,
  isTrustedRendererUrl
} from '../../../src/main/security/RendererSecurity.js'

describe('RendererSecurity', () => {
  it('allows the packaged renderer file and in-page hash changes only', () => {
    const trusted = 'file:///C:/app/out/renderer/index.html'

    expect(isTrustedRendererUrl(trusted, trusted)).toBe(true)
    expect(isTrustedRendererUrl(`${trusted}#/tasks`, trusted)).toBe(true)
    expect(isTrustedRendererUrl('file:///C:/app/secrets.txt', trusted)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com', trusted)).toBe(false)
  })

  it('allows navigation within the development server origin', () => {
    const trusted = 'http://localhost:5173/'

    expect(isTrustedRendererUrl('http://localhost:5173/#/tasks', trusted)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/@vite/client', trusted)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', trusted)).toBe(false)
  })

  it('only treats HTTP and HTTPS links as safe external URLs', () => {
    expect(isSafeExternalUrl('https://www.target.com/')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:3000/')).toBe(true)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/config')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })

  it('blocks untrusted navigation, popups, and permission requests', async () => {
    let navigationHandler
    let windowOpenHandler
    let permissionHandler
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const window = {
      webContents: {
        on: vi.fn((event, handler) => {
          if (event === 'will-navigate') navigationHandler = handler
        }),
        setWindowOpenHandler: vi.fn((handler) => {
          windowOpenHandler = handler
        }),
        session: {
          setPermissionRequestHandler: vi.fn((handler) => {
            permissionHandler = handler
          })
        }
      }
    }

    configureRendererSecurity({
      window,
      trustedRendererUrl: 'file:///C:/app/out/renderer/index.html',
      openExternal
    })

    const navigationEvent = { preventDefault: vi.fn() }
    navigationHandler(navigationEvent, 'https://www.walmart.com/')
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://www.walmart.com/')

    expect(windowOpenHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)

    const permissionCallback = vi.fn()
    permissionHandler(null, 'notifications', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)
  })
})
