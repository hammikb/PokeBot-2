import { describe, expect, it } from 'vitest'
import { extractProductKey } from '../../../src/main/products/productKey.js'

describe('extractProductKey', () => {
  it('pulls the TCIN from a Target URL', () => {
    expect(extractProductKey('target', 'https://www.target.com/p/guppy/A-94336414')).toBe(
      '94336414'
    )
  })
  it('pulls the TCIN when there is no slug', () => {
    expect(extractProductKey('target', 'https://www.target.com/p/A-94336414')).toBe('94336414')
  })
  it('pulls the trailing itemId from a Walmart URL and strips query', () => {
    expect(extractProductKey('walmart', 'https://www.walmart.com/ip/seed/15718673510?x=1')).toBe(
      '15718673510'
    )
  })
  it('returns null for unsupported retailer or unparseable URL', () => {
    expect(extractProductKey('bestbuy', 'https://x')).toBeNull()
    expect(extractProductKey('target', 'not a url')).toBeNull()
  })
})
