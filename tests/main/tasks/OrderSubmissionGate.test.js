import { describe, expect, it } from 'vitest'
import { OrderSubmissionGate } from '../../../src/main/tasks/OrderSubmissionGate.js'

describe('OrderSubmissionGate', () => {
  it('allows only the configured number of irreversible submissions', () => {
    const gate = new OrderSubmissionGate(1)
    expect(gate.claim('account-a:1')).toBe(true)
    expect(gate.claim('account-a:1')).toBe(true)
    expect(gate.claim('account-b:1')).toBe(false)
    expect(gate.snapshot()).toEqual({ limit: 1, claimed: 1 })
  })

  it('supports an intentional two-order task without exceeding it', () => {
    const gate = new OrderSubmissionGate(2)
    expect(gate.claim('account-a:1')).toBe(true)
    expect(gate.claim('account-b:1')).toBe(true)
    expect(gate.claim('account-a:2')).toBe(false)
  })
})
