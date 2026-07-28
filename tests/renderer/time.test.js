import { describe, expect, it } from 'vitest'
import { APP_TIME_ZONE, formatAppDateTime, formatAppTime } from '../../src/renderer/src/utils/time'

describe('renderer time formatting', () => {
  it('always displays timestamps in Pacific daylight time', () => {
    const timestamp = '2026-07-28T02:30:00.000Z'

    expect(APP_TIME_ZONE).toBe('America/Los_Angeles')
    expect(formatAppTime(timestamp)).toContain('7:30:00 PM PDT')
    expect(formatAppDateTime(timestamp)).toContain('Jul 27, 2026')
    expect(formatAppDateTime(timestamp)).toContain('7:30:00 PM PDT')
  })

  it('uses Pacific standard time after daylight saving time', () => {
    expect(formatAppTime('2026-12-01T03:30:00.000Z')).toContain('7:30:00 PM PST')
  })

  it('returns a readable fallback for invalid timestamps', () => {
    expect(formatAppTime('not-a-date')).toBe('Unknown time')
    expect(formatAppDateTime(null)).toBe('Unknown time')
  })
})
