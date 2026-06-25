import { describe, it, expect } from 'vitest'
import {
  parseQp,
  isQueueActive,
  extractQpdataFromText,
  secondsUntilTurn
} from '../../../src/main/automation/walmartQueue.js'

// A real captured /qp token (pending, unlikely odds).
const QP_URL =
  'https://www.walmart.com/qp?qpdata=%7B%22site%22%3A%22usgm%22%2C%22' +
  'queue%22%3A%22q21f627c674f24%22%2C%22shard%22%3A13%2C%22ticket%22' +
  '%3A17005%2C%22state%22%3A%22pending%22%2C%22expires%22%3A1782437441873' +
  '%2C%22signature%22%3A%22x%22%2C%22itemId%22%3A%2219283656289%22%2C%22' +
  'nextRefreshRelativeTime%22%3A30000%2C%22expectedTurnTimeUnixTimestamp' +
  '%22%3A1782352842116%2C%22customMetadata%22%3A%7B%22admissionLikelihood' +
  '%22%3A%22unlikely%22%2C%22item%22%3A%7B%22name%22%3A%22Pokemon+S1%22%2C' +
  '%22currentPrice%22%3A%22%2421.97%22%7D%7D%7D'

describe('walmartQueue', () => {
  it('parses a /qp URL into a flat status', () => {
    const s = parseQp(QP_URL)
    expect(s.state).toBe('pending')
    expect(s.inQueue).toBe(true)
    expect(s.yourTurn).toBe(false)
    expect(s.ticket).toBe(17005)
    expect(s.itemId).toBe('19283656289')
    expect(s.admissionLikelihood).toBe('unlikely')
    expect(s.refreshSec).toBe(30)
  })

  it('flags a valid token as your turn', () => {
    const s = parseQp(QP_URL.replace('%22pending%22', '%22valid%22'))
    expect(s.yourTurn).toBe(true)
    expect(s.inQueue).toBe(false)
  })

  it('detects an active queue from url or body', () => {
    expect(isQueueActive({ url: QP_URL })).toBe(true)
    expect(isQueueActive({ url: 'https://www.walmart.com/qp' })).toBe(true)
    expect(isQueueActive({ url: 'https://www.walmart.com/ip/123' })).toBe(false)
    expect(isQueueActive({ body: '<a href="/qp?qpdata=abc">' })).toBe(true)
  })

  it('extracts a qpdata token out of an HTML body', () => {
    expect(extractQpdataFromText('foo <a href="/qp?qpdata=ABC123&x=1">')).toBe('ABC123')
    expect(extractQpdataFromText('no token here')).toBe(null)
  })

  it('returns null ETA when the token has no estimate', () => {
    expect(secondsUntilTurn({})).toBe(null)
    expect(secondsUntilTurn({ expectedTurnMs: Date.now() + 60_000 })).toBeGreaterThan(0)
  })
})
