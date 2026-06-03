import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC, RETAILER_BUY_LIMITS } from '../shared/constants.js'
import {
  addCatalogItemFromUrl,
  deleteCatalogItem,
  getCatalogItems
} from './products/ProductCatalog.js'
import { downloadProxies } from './proxies/ProxyImport.js'
import { testProxy } from './proxies/ProxyTest.js'
import { checkTargetSession } from './automation/flows/check-target-session.js'
import { runTargetAutoLogin } from './automation/flows/target-auto-login.js'
import { runTargetRegistration } from './automation/flows/register-target.js'
import { runWalmartRegistration } from './automation/flows/register-walmart.js'
import { buildTaskReadiness } from './tasks/TaskReadiness.js'

const SUPPORTED_TASK_RETAILERS = new Set(['target', 'walmart'])
const TASK_UPDATE_COLUMNS = {
  retailer: 'retailer',
  productUrl: 'product_url',
  productName: 'product_name',
  productImageUrl: 'product_image_url',
  buyLimit: 'buy_limit',
  maxPrice: 'max_price',
  mode: 'mode',
  accountIds: 'account_ids',
  intervalMs: 'interval_ms'
}

export function registerIpcHandlers({
  getDb,
  accountManager,
  taskManager,
  getSettings,
  mainWindow,
  browserPool,
  notificationEngine
}) {
  // Settings
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_, key, value) => {
    if (typeof key !== 'string' || !key) throw new Error('settings key must be a non-empty string')
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value))
    return true
  })

  // Accounts
  ipcMain.handle(IPC.ACCOUNTS_GET, () => accountManager.getAll())
  ipcMain.handle(IPC.ACCOUNTS_CREATE, async (_, data) => accountManager.create(data))
  ipcMain.handle(IPC.ACCOUNTS_UPDATE, (_, id, fields) => {
    accountManager.update(id, fields)
    return true
  })
  ipcMain.handle(IPC.ACCOUNTS_DELETE, (_, id) => {
    accountManager.delete(id)
    return true
  })
  ipcMain.handle(IPC.ACCOUNTS_REGISTER, async (_, data) => {
    const {
      retailer,
      email,
      password,
      firstName,
      lastName,
      phone = '',
      proxy = '',
      shipping = {},
      cvv = ''
    } = data || {}
    if (!retailer || !email || !password || !firstName || !lastName) {
      throw new Error('retailer, email, password, firstName, and lastName are required')
    }

    const tempId = `reg-${randomUUID()}`
    const tempProfilePath = join(tmpdir(), tempId)
    const context = await browserPool.launch(tempId, { profilePath: tempProfilePath, proxy })

    let result
    try {
      const flowArgs = { email, password, firstName, lastName, phone, notificationEngine }
      if (retailer === 'target') {
        result = await runTargetRegistration(context, flowArgs)
      } else if (retailer === 'walmart') {
        result = await runWalmartRegistration(context, flowArgs)
      } else {
        throw new Error(`Registration not supported for retailer: ${retailer}`)
      }
    } finally {
      await browserPool.close(tempId)
    }

    if (result.success) {
      const accountId = await accountManager.create({
        name: `${retailer}-${email}`,
        retailer,
        username: email,
        password,
        cvv,
        proxy,
        shipping,
        status: 'unverified'
      })
      mainWindow?.webContents?.send(IPC.ACCOUNT_STATUS, {
        id: accountId,
        email,
        status: 'unverified',
        message: `Account created — check ${email} to verify`
      })
      return { success: true, accountId, needsVerification: true }
    }

    return result
  })
  ipcMain.handle(IPC.ACCOUNTS_SET_STATUS, (_, id, status) => {
    accountManager.setStatus(id, status)
    return true
  })
  ipcMain.handle(IPC.ACCOUNTS_OPEN_SESSION, async (_, id) => {
    const account = accountManager.getDecrypted(id)
    if (!account) throw new Error('Account not found')
    const context = await browserPool.launch(account.id, {
      profilePath: account.profile_path,
      proxy: account.proxy
    })
    const page = await context.newPage()
    if (account.retailer === 'target') {
      await page.goto('https://www.target.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    } else if (account.retailer === 'walmart') {
      await page.goto('https://www.walmart.com/account/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } else {
      throw new Error('Only Target and Walmart account sessions are supported')
    }
    return true
  })
  ipcMain.handle(IPC.ACCOUNTS_CHECK_SESSION, async (_, id) => {
    const account = accountManager.getDecrypted(id)
    if (!account) throw new Error('Account not found')
    if (account.retailer !== 'target') {
      throw new Error('Session check is currently wired for Target accounts only')
    }
    const context = await browserPool.launch(account.id, {
      profilePath: account.profile_path,
      proxy: account.proxy
    })
    const result = await checkTargetSession(context, {
      accountName: account.name,
      notificationEngine,
      dropEvent: {
        retailer: 'target',
        productName: 'Target session check',
        dropType: 'account_session_check'
      },
      onStep: (message) => {
        console.log(`[target-session] [${account.name}] ${message}`)
        mainWindow?.webContents?.send(IPC.FEED_EVENT, {
          id: randomUUID(),
          retailer: 'target',
          productName: account.name,
          dropType: 'account_session_check_step',
          message,
          createdAt: new Date().toISOString()
        })
      }
    })
    if (result.success) accountManager.setStatus(account.id, 'verified')
    return result
  })
  ipcMain.handle(IPC.ACCOUNTS_AUTO_LOGIN, async (_, id) => {
    const account = accountManager.getDecrypted(id)
    if (!account) throw new Error('Account not found')
    if (account.retailer !== 'target') {
      throw new Error('Auto-login is currently wired for Target accounts only')
    }
    const context = await browserPool.launch(account.id, {
      profilePath: account.profile_path,
      proxy: account.proxy
    })
    const result = await runTargetAutoLogin(context, {
      account,
      notificationEngine,
      dropEvent: {
        retailer: 'target',
        productName: 'Target auto-login',
        dropType: 'account_auto_login'
      },
      onStep: (message) => {
        console.log(`[target-auto-login] [${account.name}] ${message}`)
        mainWindow?.webContents?.send(IPC.FEED_EVENT, {
          id: randomUUID(),
          retailer: 'target',
          productName: account.name,
          dropType: 'account_auto_login_step',
          message,
          createdAt: new Date().toISOString()
        })
      }
    })
    if (result.success) accountManager.setStatus(account.id, 'verified')
    return result
  })
  // Tasks
  ipcMain.handle(IPC.TASKS_GET, () => getDb().prepare('SELECT * FROM tasks').all())
  ipcMain.handle(IPC.TASKS_READINESS, () => {
    const tasks = getDb().prepare('SELECT * FROM tasks').all()
    return buildTaskReadiness({ tasks, accountManager, settings: getSettings() })
  })
  ipcMain.handle(IPC.TASKS_CREATE, (_, data) => {
    if (!data?.retailer || !data?.productUrl) {
      throw new Error('retailer and productUrl are required to create a task')
    }
    if (!SUPPORTED_TASK_RETAILERS.has(data.retailer)) {
      throw new Error('Task creation is currently supported for Target and Walmart only')
    }
    const id = randomUUID()
    getDb()
      .prepare(
        `
      INSERT INTO tasks (id, retailer, product_url, product_name, product_image_url, buy_limit, max_price, mode, account_ids, interval_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        data.retailer,
        data.productUrl,
        data.productName || null,
        data.productImageUrl || null,
        normalizeBuyLimit(data.buyLimit, data.retailer),
        data.maxPrice || null,
        data.mode || 'monitor-and-buy',
        JSON.stringify(data.accountIds || []),
        data.intervalMs || 4000
      )
    return id
  })
  ipcMain.handle(IPC.TASKS_UPDATE, (_, id, data) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!task) throw new Error('Task not found')
    const retailer = data.retailer || task.retailer
    if (!SUPPORTED_TASK_RETAILERS.has(retailer)) {
      throw new Error('Task editing is currently supported for Target and Walmart only')
    }

    const fields = {
      ...data,
      retailer,
      buyLimit: normalizeBuyLimit(data.buyLimit, retailer),
      accountIds: JSON.stringify(data.accountIds || [])
    }
    for (const [key, column] of Object.entries(TASK_UPDATE_COLUMNS)) {
      if (!(key in fields)) continue
      getDb()
        .prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`)
        .run(fields[key] ?? null, id)
    }
    return true
  })
  ipcMain.handle(IPC.CATALOG_GET, () => getCatalogItems(getDb))
  ipcMain.handle(IPC.CATALOG_ADD_URL, async (_, productUrl) =>
    addCatalogItemFromUrl(getDb, productUrl, {
      onScraplingFallback: ({ error }) =>
        emitCatalogLookupFallback({ mainWindow, notificationEngine, productUrl, error })
    })
  )
  ipcMain.handle(IPC.CATALOG_DELETE, (_, id) => deleteCatalogItem(getDb, id))
  ipcMain.handle(IPC.PROXIES_DOWNLOAD, async (_, url) => downloadProxies(url))
  ipcMain.handle(IPC.PROXIES_TEST, async (_, proxy) => testProxy(proxy))
  ipcMain.handle(IPC.TASKS_START, (_, id) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (task) taskManager.startTask(task)
    return true
  })
  ipcMain.handle(IPC.TASKS_TEST, async (_, id) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!task) throw new Error('Task not found')
    return taskManager.testTask(task)
  })
  ipcMain.handle(IPC.TASKS_STOP, (_, id) => {
    taskManager.stopTask(id)
    return true
  })
  ipcMain.handle(IPC.TASKS_DELETE, (_, id) => {
    taskManager.stopTask(id)
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return true
  })

  // Push events to renderer
  taskManager.on('drop', (event) => mainWindow?.webContents?.send(IPC.FEED_EVENT, event))
  taskManager.on('taskStatus', (data) => mainWindow?.webContents?.send(IPC.TASK_STATUS, data))
}

async function emitCatalogLookupFallback({ mainWindow, notificationEngine, productUrl, error }) {
  const event = {
    id: randomUUID(),
    retailer: detectRetailer(productUrl) || 'catalog',
    productName: `Scrapling failed; using retailer fallback: ${shortError(error)}`,
    productUrl,
    dropType: 'catalog_lookup_fallback',
    timestamp: Date.now(),
    createdAt: new Date().toISOString()
  }
  console.warn(`[catalog] ${event.productName} (${productUrl})`)
  mainWindow?.webContents?.send(IPC.FEED_EVENT, event)
  await notificationEngine?.fire(event)
}

function shortError(error) {
  return String(error?.message || error || 'unknown error').slice(0, 180)
}

function detectRetailer(productUrl) {
  try {
    const hostname = new URL(productUrl).hostname
    if (hostname.includes('target.com')) return 'target'
    if (hostname.includes('walmart.com')) return 'walmart'
  } catch {
    return null
  }
  return null
}

function normalizeBuyLimit(value, retailer) {
  const fallback = RETAILER_BUY_LIMITS[retailer] || 1
  const numericValue = Number.parseInt(value, 10)
  if (!Number.isFinite(numericValue) || numericValue < 1) return fallback
  return Math.min(numericValue, fallback)
}
