import { randomUUID } from 'crypto'
import { encrypt, decrypt } from '../crypto.js'
import { join } from 'path'
import { tmpdir } from 'os'

async function getAppPath() {
  try {
    const { app } = await import('electron')
    return join(app.getPath('userData'), 'profiles')
  } catch {
    return join(tmpdir(), 'pokebot-profiles')
  }
}

export class AccountManager {
  constructor(getDb, encryptionKey, profileBasePath = null) {
    this._getDb = getDb
    this._key = encryptionKey
    this._profileBasePath = profileBasePath
  }

  async _getProfileBase() {
    if (this._profileBasePath) return this._profileBasePath
    return getAppPath()
  }

  async create({
    name,
    retailer,
    username,
    password,
    cvv = '',
    proxy = '',
    paymentMethodId = null,
    shipping = {},
    status = 'active'
  }) {
    const normalizedProxy = normalizeProxy(proxy)
    this._assertProxyAvailable(normalizedProxy)
    const base = await this._getProfileBase()
    const id = randomUUID()
    const profilePath = join(base, id)
    this._getDb()
      .prepare(
        `
    INSERT INTO accounts (id, name, retailer, username, password_enc, cvv_enc, proxy, profile_path, shipping_json, payment_method_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
      )
      .run(
        id,
        name,
        retailer,
        username,
        encrypt(password, this._key),
        cvv ? encrypt(cvv, this._key) : '',
        normalizedProxy,
        profilePath,
        JSON.stringify(shipping),
        paymentMethodId || null,
        status
      )
    return id
  }

  getAll() {
    return this._getDb()
      .prepare(
        'SELECT id, name, retailer, username, proxy, profile_path, shipping_json, payment_method_id, status FROM accounts'
      )
      .all()
  }

  getDecrypted(id) {
    const row = this._getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id)
    if (!row) return null
    const { password_enc, cvv_enc, ...rest } = row
    return {
      ...rest,
      password: decrypt(password_enc, this._key),
      cvv: cvv_enc ? decrypt(cvv_enc, this._key) : ''
    }
  }

  update(id, fields) {
    const allowed = {
      name: 'name',
      proxy: 'proxy',
      shipping_json: 'shipping_json',
      paymentMethodId: 'payment_method_id'
    }
    for (const [k, v] of Object.entries(fields)) {
      const column = allowed[k]
      if (!column) continue
      const value = k === 'proxy' ? normalizeProxy(v) : v
      if (k === 'proxy') this._assertProxyAvailable(value, id)
      this._getDb().prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, id)
    }
  }

  findAvailableProxy(proxies = []) {
    const assigned = new Set(
      this.getAll()
        .map((account) => normalizeProxy(account.proxy))
        .filter(Boolean)
    )
    return normalizeProxyPool(proxies).find((proxy) => !assigned.has(proxy)) || ''
  }

  assignUniqueProxies(proxies = []) {
    const pool = normalizeProxyPool(proxies)
    const accounts = this.getAll()
    const claimed = new Set()
    const needsAssignment = []
    const assignments = []

    for (const account of accounts) {
      const current = normalizeProxy(account.proxy)
      if (current && !claimed.has(current)) {
        claimed.add(current)
      } else {
        needsAssignment.push({ account, current })
      }
    }

    const available = pool.filter((proxy) => !claimed.has(proxy))
    const unassigned = []

    for (const { account, current } of needsAssignment) {
      const next = available.shift() || ''
      if (next) claimed.add(next)
      if (next !== current) {
        this._getDb().prepare('UPDATE accounts SET proxy = ? WHERE id = ?').run(next, account.id)
        assignments.push({
          accountId: account.id,
          accountName: account.name,
          from: current,
          to: next
        })
      }
      if (!next) unassigned.push({ accountId: account.id, accountName: account.name })
    }

    return {
      assignments,
      unassigned,
      assignedCount: accounts.length - unassigned.length,
      accountCount: accounts.length,
      proxyCount: pool.length
    }
  }

  _assertProxyAvailable(proxy, excludeAccountId = null) {
    if (!proxy) return
    const conflict = this.getAll().find(
      (account) => account.id !== excludeAccountId && normalizeProxy(account.proxy) === proxy
    )
    if (conflict) {
      throw new Error(
        `Proxy is already assigned to ${conflict.name}; each account needs a unique proxy`
      )
    }
  }

  setStatus(id, status) {
    this._getDb().prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id)
  }

  delete(id) {
    this._getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}

function normalizeProxy(proxy) {
  return String(proxy || '').trim()
}

function normalizeProxyPool(proxies) {
  if (!Array.isArray(proxies)) return []
  return [...new Set(proxies.map(normalizeProxy).filter(Boolean))]
}
