const KEY_PREFIX = 'supabase-monitor-cursor:'

export class MonitorDeliveryState {
  constructor({ getDb, namespace }) {
    if (typeof getDb !== 'function') throw new TypeError('MonitorDeliveryState requires getDb')
    this._getDb = getDb
    this._namespace = String(namespace || '').trim()
  }

  load(productId) {
    const row = this._getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(this._key(productId))
    if (!row?.value) return null
    try {
      const value = JSON.parse(row.value)
      if (!value || typeof value.observedAt !== 'string' || typeof value.eventId !== 'string') {
        return null
      }
      return {
        observedAt: value.observedAt,
        eventId: value.eventId
      }
    } catch {
      return null
    }
  }

  save(productId, cursor) {
    if (!cursor?.observedAt || !cursor?.eventId) return
    this._getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(this._key(productId), JSON.stringify({
        observedAt: String(cursor.observedAt),
        eventId: String(cursor.eventId)
      }))
  }

  clear(productId) {
    this._getDb().prepare('DELETE FROM settings WHERE key = ?').run(this._key(productId))
  }

  _key(productId) {
    return `${KEY_PREFIX}${this._namespace}:${String(productId)}`
  }
}
