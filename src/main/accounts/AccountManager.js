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
    shipping = {},
    status = 'active'
  }) {
    const base = await this._getProfileBase()
    const id = randomUUID()
    const profilePath = join(base, id)
    this._getDb()
      .prepare(
        `
    INSERT INTO accounts (id, name, retailer, username, password_enc, cvv_enc, proxy, profile_path, shipping_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
      )
      .run(
        id,
        name,
        retailer,
        username,
        encrypt(password, this._key),
        cvv ? encrypt(cvv, this._key) : '',
        proxy,
        profilePath,
        JSON.stringify(shipping),
        status
      )
    return id
  }

  getAll() {
    return this._getDb()
      .prepare(
        'SELECT id, name, retailer, username, proxy, profile_path, shipping_json, status FROM accounts'
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
    const allowed = ['name', 'proxy', 'shipping_json']
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue
      this._getDb().prepare(`UPDATE accounts SET ${k} = ? WHERE id = ?`).run(v, id)
    }
  }

  setStatus(id, status) {
    this._getDb().prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id)
  }

  delete(id) {
    this._getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
