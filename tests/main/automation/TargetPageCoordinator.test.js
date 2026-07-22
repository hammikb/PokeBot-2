import { describe, expect, it, vi } from 'vitest'
import { TargetPageCoordinator } from '../../../src/main/automation/TargetPageCoordinator.js'

describe('TargetPageCoordinator', () => {
  it('installs for the current page and future Target documents', async () => {
    const page = {
      addInitScript: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined)
    }

    const coordinator = await TargetPageCoordinator.attach(page)

    expect(coordinator).toBeInstanceOf(TargetPageCoordinator)
    expect(page.addInitScript).toHaveBeenCalledTimes(1)
    expect(page.evaluate).toHaveBeenCalledTimes(1)
  })

  it('deduplicates host actions even when the page is navigating', async () => {
    const page = {
      evaluate: vi.fn(async () => true)
    }
    const coordinator = new TargetPageCoordinator(page)

    await expect(coordinator.claimAction('add-to-cart', 5000)).resolves.toBe(true)
    await expect(coordinator.claimAction('add-to-cart', 5000)).resolves.toBe(false)
    expect(page.evaluate).toHaveBeenCalledTimes(1)
  })

  it('uses a backup wait when the observer is unavailable during navigation', async () => {
    const page = {
      evaluate: vi.fn(async () => {
        throw new Error('Execution context destroyed')
      }),
      waitForTimeout: vi.fn(async () => {})
    }
    const coordinator = new TargetPageCoordinator(page, { backupScanMs: 25 })

    await coordinator.waitForChange(3, 100)

    expect(page.waitForTimeout).toHaveBeenCalledWith(25)
  })
})
