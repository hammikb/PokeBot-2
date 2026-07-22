import { describe, expect, it } from 'vitest'
import { getSessionPreparationUrls } from '../../../src/main/automation/profileWarmup.js'

describe('profile session preparation', () => {
  it.each(['target', 'walmart', 'samsclub', 'pokemon-center'])(
    'stays on the selected %s retailer',
    (retailer) => {
      const urls = getSessionPreparationUrls(retailer)
      expect(urls).toHaveLength(3)
      const hosts = new Set(urls.map((url) => new URL(url).hostname))
      expect(hosts.size).toBe(1)
    }
  )

  it('does not prepare unknown retailers', () => {
    expect(getSessionPreparationUrls('unknown')).toEqual([])
  })
})
