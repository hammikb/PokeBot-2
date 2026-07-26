import { describe, expect, it } from 'vitest'
import {
  RetailerCircuitBreaker,
  classifyCircuitFailure
} from '../../../src/main/tasks/RetailerCircuitBreaker.js'

describe('RetailerCircuitBreaker', () => {
  it('trips only for repeated systemic failures and recovers half-open', () => {
    let now = 1000
    const circuit = new RetailerCircuitBreaker({
      threshold: 3,
      windowMs: 1000,
      cooldownMs: 5000,
      now: () => now
    })

    circuit.recordFailure('target', 'out of stock')
    expect(circuit.allow('target').allowed).toBe(true)
    circuit.recordFailure('target', 'HTTP 403')
    circuit.recordFailure('target', 'security challenge did not clear')
    circuit.recordFailure('target', 'CAPTCHA')
    expect(circuit.allow('target')).toMatchObject({
      allowed: false,
      reason: 'security-challenge'
    })

    now += 5001
    expect(circuit.allow('target')).toMatchObject({ allowed: true, halfOpen: true })
    expect(circuit.allow('target').allowed).toBe(false)
    circuit.recordSuccess('target')
    expect(circuit.allow('target').allowed).toBe(true)
  })

  it('does not classify inventory or payment failures as systemic', () => {
    expect(classifyCircuitFailure('item is out of stock').tripEligible).toBe(false)
    expect(classifyCircuitFailure('card was declined').tripEligible).toBe(false)
    expect(classifyCircuitFailure('HTTP 429 rate limited')).toEqual({
      tripEligible: true,
      reason: 'rate-limited'
    })
  })

  it('restarts cooldown after a failed half-open probe', () => {
    let now = 1000
    const circuit = new RetailerCircuitBreaker({
      threshold: 1,
      cooldownMs: 5000,
      now: () => now
    })

    circuit.recordFailure('target', 'HTTP 403')
    now += 5001
    expect(circuit.allow('target')).toMatchObject({ allowed: true, halfOpen: true })
    circuit.recordFailure('target', 'CAPTCHA')
    expect(circuit.allow('target')).toMatchObject({ allowed: false, remainingMs: 5000 })
  })

  it('closes a half-open circuit when the probe reaches a task-specific failure', () => {
    let now = 1000
    const circuit = new RetailerCircuitBreaker({
      threshold: 1,
      cooldownMs: 5000,
      now: () => now
    })

    circuit.recordFailure('target', 'HTTP 403')
    now += 5001
    expect(circuit.allow('target')).toMatchObject({ allowed: true, halfOpen: true })
    circuit.recordFailure('target', 'item is out of stock')
    expect(circuit.allow('target')).toEqual({ allowed: true })
  })
})
