import { describe, expect, it } from 'vitest'
import {
  buildCloakBrowserOptions,
  redactProxyUrl,
  stableFingerprintSeed
} from '../../../src/main/automation/cloakBrowserConfig.js'

describe('cloakBrowserConfig', () => {
  it('keeps one stable fingerprint seed for the same profile identity', () => {
    expect(stableFingerprintSeed('account:one')).toBe(stableFingerprintSeed('account:one'))
    expect(stableFingerprintSeed('account:one')).not.toBe(stableFingerprintSeed('account:two'))
  })

  it('lets CloakBrowser own the user agent and automation-related switches', () => {
    const options = buildCloakBrowserOptions({
      identity: 'account:one',
      proxyUrl: 'http://user:password@proxy.example:80'
    })

    expect(options.locale).toBe('en-US')
    expect(options.timezone).toBe('America/Los_Angeles')
    expect(options.geoip).toBe(true)
    expect(options.args.some((arg) => arg.startsWith('--fingerprint='))).toBe(true)
    expect(options.args.some((arg) => arg.startsWith('--user-agent='))).toBe(false)
    expect(options.args).not.toContain('--disable-blink-features=AutomationControlled')
  })

  it('never returns proxy passwords in display-safe log values', () => {
    const redacted = redactProxyUrl('http://my-user:very-secret@proxy.example:80')
    expect(redacted).toBe('http://my-u…@proxy.example')
    expect(redacted).not.toContain('very-secret')
  })
})
