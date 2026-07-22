import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MonitorEngine } from '../../../src/main/monitor/MonitorEngine.js'

describe('MonitorEngine', () => {
  let engine
  beforeEach(() => {
    engine = new MonitorEngine()
  })
  afterEach(() => {
    engine.stopAll()
  })

  it('starts with no active tasks', () => {
    expect(engine.getActiveTasks()).toHaveLength(0)
  })

  it('addTask registers a task', () => {
    const mockPoller = { poll: vi.fn().mockResolvedValue(null) }
    engine.addTask({ id: 'task1', poller: mockPoller, intervalMs: 100 })
    expect(engine.getActiveTasks()).toContain('task1')
  })

  it('removeTask stops polling', () => {
    const mockPoller = { poll: vi.fn().mockResolvedValue(null) }
    engine.addTask({ id: 'task2', poller: mockPoller, intervalMs: 100 })
    engine.removeTask('task2')
    expect(engine.getActiveTasks()).not.toContain('task2')
  })

  it('does not start a delayed poll after the task is removed', async () => {
    vi.useFakeTimers()
    const mockPoller = {
      poll: vi.fn().mockResolvedValue(null),
      destroy: vi.fn().mockResolvedValue(undefined)
    }
    engine.addTask({ id: 'cancel-before-first-run', poller: mockPoller, intervalMs: 100 })
    engine.removeTask('cancel-before-first-run')

    await vi.advanceTimersByTimeAsync(1000)

    expect(mockPoller.poll).not.toHaveBeenCalled()
    expect(mockPoller.destroy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('emits drop event when poller returns drop', async () => {
    const dropEvent = { id: '1', retailer: 'walmart', productName: 'ETB', dropType: 'in_stock' }
    const mockPoller = { poll: vi.fn().mockResolvedValue(dropEvent) }
    const handler = vi.fn()
    engine.on('drop', handler)
    engine.addTask({ id: 'task3', poller: mockPoller, intervalMs: 50 })
    await new Promise((r) => setTimeout(r, 120))
    expect(handler).toHaveBeenCalledWith(dropEvent)
  })
})
