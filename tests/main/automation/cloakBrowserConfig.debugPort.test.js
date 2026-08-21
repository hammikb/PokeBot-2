import { describe, expect, it } from 'vitest'
import { buildRemoteDebuggingArgs } from '../../../src/main/automation/cloakBrowserConfig.js'

describe('remote debugging args', () => {
  it('stays off unless explicitly requested', () => {
    for (const value of [undefined, '', '   ', 'abc', '-1', '70000', '12.5']) {
      expect(buildRemoteDebuggingArgs(value)).toEqual([])
    }
  })

  it('lets Chromium pick a free port so parallel accounts cannot collide', () => {
    expect(buildRemoteDebuggingArgs('auto')).toContain('--remote-debugging-port=0')
    expect(buildRemoteDebuggingArgs('0')).toContain('--remote-debugging-port=0')
  })

  it('never exposes the debugger off this machine', () => {
    expect(buildRemoteDebuggingArgs('9222')).toEqual([
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1'
    ])
  })
})
