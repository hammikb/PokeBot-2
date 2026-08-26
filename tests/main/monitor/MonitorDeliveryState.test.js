import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDb, initDb } from '../../../src/main/db.js'
import { MonitorDeliveryState } from '../../../src/main/monitor/MonitorDeliveryState.js'

describe('MonitorDeliveryState', () => {
  let directory

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pokebot-monitor-state-'))
    initDb(join(directory, 'pokebot.db'))
  })

  afterEach(() => {
    getDb().close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('round-trips a product cursor through the local settings database', () => {
    const first = new MonitorDeliveryState({ getDb, namespace: 'user-1' })
    first.save('product-1', { observedAt: '2026-08-25T01:00:00.000Z', eventId: 'drop-1' })

    const reopened = new MonitorDeliveryState({ getDb, namespace: 'user-1' })
    expect(reopened.load('product-1')).toEqual({
      observedAt: '2026-08-25T01:00:00.000Z',
      eventId: 'drop-1'
    })
  })

  it('does not restore another user’s cursor', () => {
    const first = new MonitorDeliveryState({ getDb, namespace: 'user-1' })
    first.save('product-1', { observedAt: '2026-08-25T01:00:00.000Z', eventId: 'drop-1' })

    expect(new MonitorDeliveryState({ getDb, namespace: 'user-2' }).load('product-1')).toBeNull()
  })

  it('clears a released product cursor', () => {
    const state = new MonitorDeliveryState({ getDb, namespace: 'user-1' })
    state.save('product-1', { observedAt: '2026-08-25T01:00:00.000Z', eventId: 'drop-1' })
    state.clear('product-1')

    expect(state.load('product-1')).toBeNull()
  })
})
