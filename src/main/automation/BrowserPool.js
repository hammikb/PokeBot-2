import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

export class BrowserPool {
  constructor({ maxConcurrent = 3 } = {}) {
    this._maxConcurrent = maxConcurrent
    this._active = new Map()
  }

  async launch(accountId, { profilePath, proxy }) {
    if (this._active.has(accountId)) return this._active.get(accountId)
    if (this._active.size >= this._maxConcurrent) {
      throw new Error(`Browser pool at max capacity (${this._maxConcurrent})`)
    }

    mkdirSync(profilePath, { recursive: true })

    const contextOptions = {
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation']
    }

    if (proxy) {
      const parts = proxy.split(':')
      if (parts.length >= 2) {
        const [host, port, username, password] = parts
        contextOptions.proxy = {
          server: `http://${host}:${port}`,
          ...(username && password ? { username, password } : {})
        }
      }
    }

    const context = await chromium.launchPersistentContext(profilePath, contextOptions)
    this._active.set(accountId, context)
    return context
  }

  async close(accountId) {
    const ctx = this._active.get(accountId)
    if (ctx) {
      try { await ctx.close() } catch {}
      this._active.delete(accountId)
    }
  }

  async closeAll() {
    for (const id of [...this._active.keys()]) await this.close(id)
  }

  getActiveCount() {
    return this._active.size
  }

  isAtCapacity() {
    return this._active.size >= this._maxConcurrent
  }
}
