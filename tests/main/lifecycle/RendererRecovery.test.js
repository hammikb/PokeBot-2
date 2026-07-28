import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachRendererRecovery } from '../../../src/main/lifecycle/RendererRecovery.js'

function makeWindow() {
  const window = new EventEmitter()
  window.isDestroyed = vi.fn(() => false)
  window.webContents = new EventEmitter()
  window.webContents.isDestroyed = vi.fn(() => false)
  window.webContents.reload = vi.fn()
  return window
}

describe('RendererRecovery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reloads the interface after an unexpected renderer exit', async () => {
    vi.useFakeTimers()
    const window = makeWindow()
    const onRecovery = vi.fn()
    const recovery = attachRendererRecovery({
      window,
      onRecovery,
      reloadDelayMs: 100
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(100)

    expect(onRecovery).toHaveBeenCalledWith('renderer-crashed')
    expect(window.webContents.reload).toHaveBeenCalledOnce()
    recovery.dispose()
  })

  it('cancels an unresponsive reload when the renderer becomes responsive again', async () => {
    vi.useFakeTimers()
    const window = makeWindow()
    const recovery = attachRendererRecovery({
      window,
      unresponsiveDelayMs: 100
    })

    window.emit('unresponsive')
    window.emit('responsive')
    await vi.advanceTimersByTimeAsync(100)

    expect(window.webContents.reload).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('does not reload while the application is shutting down', async () => {
    vi.useFakeTimers()
    const window = makeWindow()
    const recovery = attachRendererRecovery({
      window,
      isShuttingDown: () => true,
      reloadDelayMs: 10
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'killed' })
    await vi.advanceTimersByTimeAsync(10)

    expect(window.webContents.reload).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('can dispose after Electron destroys the BrowserWindow and its webContents', () => {
    const window = makeWindow()
    const webContents = window.webContents
    const recovery = attachRendererRecovery({ window })

    window.isDestroyed.mockReturnValue(true)
    webContents.isDestroyed.mockReturnValue(true)
    Object.defineProperty(window, 'webContents', {
      configurable: true,
      get() {
        throw new TypeError('Object has been destroyed')
      }
    })

    expect(() => window.emit('closed')).not.toThrow()
    expect(() => recovery.dispose()).not.toThrow()
  })
})
