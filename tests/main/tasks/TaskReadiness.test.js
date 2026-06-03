import { describe, expect, it } from 'vitest'
import { buildTaskReadiness } from '../../../src/main/tasks/TaskReadiness.js'

const task = {
  id: 'task-1',
  retailer: 'walmart',
  product_url: 'https://www.walmart.com/ip/example/123',
  account_ids: JSON.stringify(['account-1'])
}

function account(overrides = {}) {
  return {
    id: 'account-1',
    name: 'Walmart Account',
    retailer: 'walmart',
    status: 'active',
    cvv: '123',
    proxy: '',
    ...overrides
  }
}

function manager(row) {
  return {
    getDecrypted: (id) => (id === row.id ? row : null)
  }
}

describe('buildTaskReadiness', () => {
  it('marks a task ready when product, account, cvv, proxy, and test are good', () => {
    const readiness = buildTaskReadiness({
      tasks: [task],
      accountManager: manager(account()),
      settings: {
        taskTestResults: {
          'task-1': { success: true, testedAt: '2026-05-31T00:00:00.000Z' }
        }
      }
    })

    expect(readiness['task-1'].ready).toBe(true)
  })

  it('surfaces actionable blockers for missing accounts, cvv, proxy pass, and test', () => {
    const readiness = buildTaskReadiness({
      tasks: [task],
      accountManager: manager(account({ cvv: '', proxy: '1.2.3.4:8000:user:pass' })),
      settings: {}
    })

    expect(readiness['task-1'].ready).toBe(false)
    expect(readiness['task-1'].checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'CVV', ok: false }),
        expect.objectContaining({ label: 'Proxies', ok: false }),
        expect.objectContaining({ label: 'Last Test', ok: false })
      ])
    )
  })

  it('marks Target checkout as reset even when the account data is otherwise complete', () => {
    const readiness = buildTaskReadiness({
      tasks: [
        { ...task, retailer: 'target', product_url: 'https://www.target.com/p/example/A-123' }
      ],
      accountManager: manager(account({ retailer: 'target', name: 'Target Account' })),
      settings: {
        taskTestResults: {
          'task-1': { success: true, testedAt: '2026-05-31T00:00:00.000Z' }
        }
      }
    })

    expect(readiness['task-1'].ready).toBe(false)
    expect(readiness['task-1'].checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Checkout Flow',
          ok: false,
          message: 'target checkout automation is reset'
        })
      ])
    )
  })
})
