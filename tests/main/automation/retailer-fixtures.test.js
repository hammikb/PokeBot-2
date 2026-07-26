import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { isQueueActive } from '../../../src/main/automation/walmartQueue.js'
import { classifyPokemonCenterQueueText } from '../../../src/main/automation/PokemonCenterQueueJoiner.js'
import { classifySamsPageText } from '../../../src/main/automation/flows/samsclub.js'
import { classifyCheckoutFailure } from '../../../src/main/telemetry/CheckoutTelemetry.js'

const fixture = (name) =>
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'retailers', name), 'utf8')

describe('sanitized retailer page fixtures', () => {
  it('recognizes a Walmart waiting room payload', () => {
    expect(isQueueActive({ body: fixture('walmart-queue.html') })).toBe(true)
  })

  it('recognizes Pokemon Center queue copy and ETA', () => {
    expect(
      classifyPokemonCenterQueueText(
        fixture('pokemon-center-queue.html'),
        'https://www.pokemoncenter.com/queue'
      )
    ).toEqual({ inQueue: true, etaSec: 750 })
  })

  it("recognizes Sam's Club traffic gate without refreshing it", () => {
    expect(classifySamsPageText(fixture('sams-traffic-gate.html'))).toBe('traffic-gate')
  })

  it('classifies Target high-demand failures consistently', () => {
    expect(classifyCheckoutFailure(fixture('target-high-demand.html'), 'cart_attempted')).toEqual({
      code: 'high_demand',
      stage: 'cart_attempted'
    })
  })
})
