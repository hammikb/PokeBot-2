import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startTrace } from '../../../src/main/automation/TraceRecorder.js'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\Users\\test\\AppData\\PokeBot')
  }
}))

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => {})
}))

describe('startTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts tracing and saves trace plus screenshot paths', async () => {
    const context = {
      tracing: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {})
      }
    }
    const page = {
      screenshot: vi.fn(async () => {})
    }

    const trace = await startTrace(context, {
      retailer: 'target',
      accountName: 'target-user@example.com',
      taskId: 'Pokemon Box'
    })
    await trace.capture(page)
    await trace.stop()

    expect(context.tracing.start).toHaveBeenCalledWith({
      screenshots: true,
      snapshots: true,
      sources: false
    })
    expect(page.screenshot).toHaveBeenCalledWith({
      path: expect.stringContaining('.png'),
      fullPage: true
    })
    expect(context.tracing.stop).toHaveBeenCalledWith({
      path: expect.stringContaining('.zip')
    })
  })
})
