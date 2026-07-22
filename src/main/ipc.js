import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC, RETAILER_BUY_LIMITS, DROP_TYPES } from '../shared/constants.js'
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
import { cookieManager } from './automation/cookieManager.js'
import { buildTaskReadiness } from './tasks/TaskReadiness.js'
import { getPublicClient } from './supabase/session.js'
import { findWalmartMatch, findWalmartMatchCached } from './products/WalmartMatch.js'
import { persistTaskState, TASK_STATE } from './tasks/TaskState.js'

const SUPPORTED_TASK_RETAILERS = new Set(['target', 'walmart', 'pokemon-center', 'samsclub'])
const TASK_UPDATE_COLUMNS = {
  retailer: 'retailer',
  productUrl: 'product_url',
  productName: 'product_name',
  productImageUrl: 'product_image_url',
  buyLimit: 'buy_limit',
  ordersPerDrop: 'orders_per_drop',
  maxPrice: 'max_price',
  mode: 'mode',
  accountIds: 'account_ids',
  intervalMs: 'interval_ms'
}

export function registerIpcHandlers({
  getDb,
  accountManager,
  paymentManager,
  shippingManager,
  thumbnailCache,
  taskManager,
  pokemonFinder,
  profileWarmup,
  getSettings,
  mainWindow,
  browserPool,
  notificationEngine,
  queueJoiner,
  pokemonCenterQueueJoiner,
  authSessionManager
}) {
  async function syncWalmartListing(productKey, candidate, verificationStatus = 'unverified') {
    try {
      const client = authSessionManager?.getClient?.()
      if (!client || !productKey || !candidate?.url) return
      const { data: item, error: itemError } = await client
        .from('catalog_items')
        .select('id')
        .eq('product_key', productKey)
        .maybeSingle()
      if (itemError || !item) return
      const { error } = await client.from('catalog_listings').upsert(
        {
          catalog_item_id: item.id,
          retailer: 'walmart',
          retailer_item_id: candidate.itemId || null,
          product_url: candidate.url,
          title: candidate.name || null,
          image_url: candidate.imageUrl || null,
          seller: candidate.sellerName || null,
          confidence: candidate.confidence || null,
          verification_status: verificationStatus
        },
        { onConflict: 'catalog_item_id,retailer' }
      )
      if (error) console.warn('Supabase Walmart listing sync skipped', error.message)
    } catch (error) {
      console.warn('Supabase Walmart listing sync skipped', error.message)
    }
  }

  // Settings
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, async (_, key, value) => {
    if (typeof key !== 'string' || !key) throw new Error('settings key must be a non-empty string')
    // Persist intent before activating integrations. A temporary auth/network
    // failure must not make a durable dashboard setting impossible to save.
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value))
    if (key === 'pokemonCenterAutoJoin') {
      return taskManager.setPokemonCenterAutoJoin(value === true)
    }
    return true
  })

  // Monitor mode (local vs supabase)
  ipcMain.handle(IPC.MONITOR_SET_MODE, async (_, mode) => {
    const next = mode === 'supabase' ? 'supabase' : 'local'
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('monitorMode', JSON.stringify(next))
    await taskManager.setMonitorMode(next)
    return next
  })

  // Per-user Supabase Auth — replaces the old shared "bot account" (email/password
  // settings) with a real signed-in user. authSessionManager owns the one session for
  // the app's lifetime and persists it (encrypted) across restarts.
  ipcMain.handle(IPC.AUTH_GET_STATUS, () => authSessionManager.getStatus())

  ipcMain.handle(IPC.AUTH_SIGN_IN, async (_, { email, password, rememberMe = true }) => {
    await authSessionManager.signIn(email, password, rememberMe)
    return authSessionManager.getStatus()
  })

  ipcMain.handle(IPC.AUTH_SIGN_UP, async (_, { email, password, rememberMe = true }) => {
    await authSessionManager.signUp(email, password, rememberMe)
    return authSessionManager.getStatus()
  })

  ipcMain.handle(IPC.AUTH_SIGN_OUT, async () => {
    await authSessionManager.signOut()
    return authSessionManager.getStatus()
  })

  // Read-only browse of the known-Target reference catalog (261+ items) —
  // anon-key read, no login required. The app has no write access here either;
  // this table is maintained by the PokeAlert worker.
  ipcMain.handle(IPC.SUPABASE_CATALOG_LIST, async () => {
    const table = getPublicClient().client.from('target_catalog')
    let result = await table
      .select(
        'id, product_key, name, image, category, upc, regular_price, current_price, price_checked_at'
      )
      .order('sort_order', { ascending: true, nullsFirst: false })
    if (isMissingCatalogPriceColumn(result.error)) {
      result = await table
        .select('id, product_key, name, image, category, upc')
        .order('sort_order', { ascending: true, nullsFirst: false })
    }
    const { data, error } = result
    if (error) throw new Error(`Supabase catalog list failed: ${error.message}`)
    return data.map((item) => ({
      id: item.id,
      retailer: 'target',
      product_key: item.product_key,
      product_url: `https://www.target.com/p/-/A-${item.product_key}`,
      name: item.name,
      image: item.image,
      category: item.category,
      upc: item.upc,
      regular_price: item.regular_price,
      current_price: item.current_price,
      price_checked_at: item.price_checked_at
    }))
  })

  // Suggest Walmart matches for a Target Catalog item (UPC search first, name
  // search as a lower-confidence fallback). Read-only — never saves anything;
  // the user picks a candidate and CATALOG_SAVE_WALMART_MATCH persists it.
  ipcMain.handle(IPC.CATALOG_FIND_WALMART_MATCH, async (_, { upc, name }) => {
    return findWalmartMatch({ upc, name })
  })

  // Search the central catalog in a throttled, cache-backed pass. Exact UPC
  // matches are safe to save automatically; name matches remain review-only.
  ipcMain.handle(IPC.CATALOG_BULK_FIND_WALMART_MATCHES, async (_, items = []) => {
    const db = getDb()
    const rows = []
    let searched = 0
    for (const item of Array.isArray(items) ? items.slice(0, 2000) : []) {
      const productKey = item.productKey || item.product_key
      if (!productKey || (!item.upc && !item.name)) continue
      const existing = db
        .prepare('SELECT * FROM catalog_walmart_matches WHERE target_product_key = ?')
        .get(productKey)
      const skipped = db
        .prepare('SELECT * FROM catalog_walmart_skips WHERE target_product_key = ?')
        .get(productKey)
      if (existing) {
        rows.push({ productKey, match: existing, saved: true, cached: true })
        continue
      }
      if (skipped) {
        rows.push({ productKey, skipped: true, saved: true, cached: true })
        continue
      }
      const query = item.upc ? String(item.upc).trim() : String(item.name || '').trim()
      const queryKey = `${item.upc ? 'upc' : 'name'}:${query.toLowerCase()}`
      const cached = db
        .prepare('SELECT 1 FROM walmart_match_search_cache WHERE query_key = ? AND expires_at > ?')
        .get(queryKey, Math.floor(Date.now() / 1000))
      if (!cached && searched > 0) {
        // Keep the bulk pass gentle on Walmart. Cached entries never incur a delay.
        await new Promise((resolve) => setTimeout(resolve, 750))
      }
      if (!cached) searched += 1
      const candidates = await findWalmartMatchCached({ db, upc: item.upc, name: item.name })
      const exact = item.upc && candidates.length === 1 ? candidates[0] : null
      if (exact) {
        db.prepare(
          `INSERT OR REPLACE INTO catalog_walmart_matches
              (target_product_key, walmart_item_id, walmart_url, walmart_name, confidence)
             VALUES (?, ?, ?, ?, ?)`
        ).run(productKey, exact.itemId, exact.url, exact.name, 'upc')
        await syncWalmartListing(productKey, exact, 'auto-matched')
      }
      rows.push({
        productKey,
        candidates,
        match: exact,
        saved: Boolean(exact),
        sourceName: item.name,
        sourceUrl: item.productUrl || item.product_url
      })
    }
    return rows
  })

  // Persist the confirmed match locally. This never touches the shared
  // Supabase target_catalog — it's PokeBot-only enrichment data.
  ipcMain.handle(IPC.CATALOG_SAVE_WALMART_MATCH, async (_, { productKey, candidate }) => {
    getDb()
      .prepare(
        `
      INSERT OR REPLACE INTO catalog_walmart_matches
        (target_product_key, walmart_item_id, walmart_url, walmart_name, confidence)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(productKey, candidate.itemId, candidate.url, candidate.name, candidate.confidence)
    await syncWalmartListing(productKey, candidate, 'verified')
    return true
  })

  ipcMain.handle(IPC.CATALOG_LIST_WALMART_MATCHES, () =>
    getDb().prepare('SELECT * FROM catalog_walmart_matches').all()
  )

  ipcMain.handle(IPC.CATALOG_SKIP_WALMART_MATCH, (_, { productKey, reason = 'not-carried' }) => {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO catalog_walmart_skips (target_product_key, reason)
         VALUES (?, ?)`
      )
      .run(productKey, reason)
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
    } else if (account.retailer === 'pokemon-center') {
      await page.goto('https://www.pokemoncenter.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } else if (account.retailer === 'samsclub') {
      await page.goto('https://www.samsclub.com/account', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } else {
      throw new Error('This retailer account session is not supported')
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

  // Profile Warmup
  ipcMain.handle(IPC.ACCOUNTS_WARMUP, async (_, id, options) => {
    const account = accountManager.getDecrypted(id)
    if (!account) throw new Error('Account not found')
    const result = await profileWarmup.prepareProfile(account, options)

    // Notify renderer of progress
    mainWindow?.webContents?.send(IPC.FEED_EVENT, {
      id: randomUUID(),
      retailer: account.retailer,
      productName: `Session preparation: ${account.name}`,
      dropType: 'session_preparation',
      message: result.success ? result.message : `Failed: ${result.error}`,
      createdAt: new Date().toISOString()
    })

    return result
  })
  ipcMain.handle(IPC.ACCOUNTS_COOKIE_HEALTH, async (_, id) => {
    const account = accountManager.getDecrypted(id)
    if (!account) throw new Error('Account not found')
    const context = await browserPool.launch(account.id, {
      profilePath: account.profile_path,
      proxy: account.proxy
    })
    return cookieManager.inspectCookies(context, account.retailer)
  })

  // Tasks
  ipcMain.handle(IPC.TASKS_GET, () => {
    const activeTaskIds = new Set(taskManager.getActiveTasks())
    return getDb()
      .prepare('SELECT * FROM tasks')
      .all()
      .map((task) => ({
        ...task,
        status: activeTaskIds.has(task.id) ? 'monitoring' : task.status || 'idle'
      }))
  })
  ipcMain.handle(IPC.TASKS_READINESS, () => {
    const tasks = getDb().prepare('SELECT * FROM tasks').all()
    return buildTaskReadiness({ tasks, accountManager, paymentManager, settings: getSettings() })
  })
  ipcMain.handle(IPC.TASKS_CREATE, (_, data) => {
    if (!data?.retailer || !data?.productUrl) {
      throw new Error('retailer and productUrl are required to create a task')
    }
    if (!SUPPORTED_TASK_RETAILERS.has(data.retailer)) {
      throw new Error('Task creation is not supported for this retailer')
    }
    const id = randomUUID()
    getDb()
      .prepare(
        `
      INSERT INTO tasks (id, retailer, product_url, product_name, product_image_url, buy_limit, orders_per_drop, max_price, mode, account_ids, interval_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        data.retailer,
        data.productUrl,
        data.productName || null,
        data.productImageUrl || null,
        normalizeBuyLimit(data.buyLimit, data.retailer),
        normalizeOrdersPerDrop(data.ordersPerDrop, data.retailer),
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
      throw new Error('Task editing is not supported for this retailer')
    }

    const fields = {
      ...data,
      retailer,
      buyLimit: normalizeBuyLimit(data.buyLimit, retailer),
      ordersPerDrop: normalizeOrdersPerDrop(data.ordersPerDrop, retailer),
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
  ipcMain.handle(IPC.MONITORS_LIST, () => listProductMonitors(getDb()))
  ipcMain.handle(IPC.MONITORS_SAVE, (_, data) => {
    if (!data?.name || !Array.isArray(data.sources)) {
      throw new Error('Monitor name and retailer sources are required')
    }
    const db = getDb()
    const monitorId = data.id || randomUUID()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO product_monitors
        (id, product_key, name, image_url, category, catalog_msrp, action_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        product_key = excluded.product_key,
        name = excluded.name,
        image_url = excluded.image_url,
        category = excluded.category,
        catalog_msrp = excluded.catalog_msrp,
        action_mode = excluded.action_mode,
        updated_at = excluded.updated_at`
    ).run(
      monitorId,
      data.productKey || null,
      data.name,
      data.imageUrl || null,
      data.category || null,
      toNullablePrice(data.catalogMsrp),
      data.actionMode || 'auto-checkout',
      now,
      now
    )

    for (const source of data.sources) {
      if (!SUPPORTED_TASK_RETAILERS.has(source.retailer)) continue
      const existing = db
        .prepare('SELECT * FROM monitor_sources WHERE monitor_id = ? AND retailer = ?')
        .get(monitorId, source.retailer)
      const sourceId = existing?.id || randomUUID()
      let taskId = existing?.task_id || null
      const enabled = source.enabled === true && Boolean(source.productUrl)
      const msrp = toNullablePrice(source.msrp)
      const priceCeiling = toNullablePrice(source.priceCeiling)
      if (enabled && source.retailer !== 'pokemon-center' && !(priceCeiling > 0)) {
        throw new Error(`A price limit is required for ${source.retailer}`)
      }
      const accountIds = Array.isArray(source.accountIds) ? source.accountIds : []

      if (enabled) {
        taskId ||= randomUUID()
        db.prepare(
          `INSERT INTO tasks
            (id, retailer, product_url, product_name, product_image_url, buy_limit, orders_per_drop, max_price, mode, account_ids, interval_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
            retailer = excluded.retailer,
            product_url = excluded.product_url,
            product_name = excluded.product_name,
            product_image_url = excluded.product_image_url,
            buy_limit = excluded.buy_limit,
            orders_per_drop = excluded.orders_per_drop,
            max_price = excluded.max_price,
            mode = excluded.mode,
            account_ids = excluded.account_ids,
            interval_ms = excluded.interval_ms`
        ).run(
          taskId,
          source.retailer,
          source.productUrl,
          source.productName || data.name,
          source.imageUrl || data.imageUrl || null,
          normalizeBuyLimit(source.buyLimit, source.retailer),
          normalizeOrdersPerDrop(source.ordersPerDrop, source.retailer),
          priceCeiling,
          source.actionMode || data.actionMode || 'auto-checkout',
          JSON.stringify(accountIds),
          source.intervalMs || 4000
        )
      } else if (taskId) {
        taskManager.stopTask(taskId)
        db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
        taskId = null
      }

      db.prepare(
        `INSERT INTO monitor_sources
          (id, monitor_id, retailer, product_url, retailer_item_id, msrp, current_price,
           price_ceiling, buy_limit, orders_per_drop, account_ids, action_mode, enabled, verification_status,
           task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(monitor_id, retailer) DO UPDATE SET
          product_url = excluded.product_url,
          retailer_item_id = excluded.retailer_item_id,
          msrp = excluded.msrp,
          current_price = excluded.current_price,
          price_ceiling = excluded.price_ceiling,
          buy_limit = excluded.buy_limit,
          orders_per_drop = excluded.orders_per_drop,
          account_ids = excluded.account_ids,
          action_mode = excluded.action_mode,
          enabled = excluded.enabled,
          verification_status = excluded.verification_status,
          task_id = excluded.task_id,
          updated_at = excluded.updated_at`
      ).run(
        sourceId,
        monitorId,
        source.retailer,
        source.productUrl || null,
        source.retailerItemId || null,
        msrp,
        toNullablePrice(source.currentPrice),
        priceCeiling,
        normalizeBuyLimit(source.buyLimit, source.retailer),
        normalizeOrdersPerDrop(source.ordersPerDrop, source.retailer),
        JSON.stringify(accountIds),
        source.actionMode || data.actionMode || 'auto-checkout',
        enabled ? 1 : 0,
        source.verificationStatus || 'unverified',
        taskId,
        now,
        now
      )
    }
    return listProductMonitors(db).find((monitor) => monitor.id === monitorId)
  })
  ipcMain.handle(IPC.MONITORS_DELETE, async (_, id) => {
    const db = getDb()
    const sources = db.prepare('SELECT task_id FROM monitor_sources WHERE monitor_id = ?').all(id)
    for (const source of sources) {
      if (!source.task_id) continue
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(source.task_id)
      taskManager.stopTask(source.task_id)
      if (task) await taskManager.unsubscribeCentral(task).catch(() => {})
      db.prepare('DELETE FROM tasks WHERE id = ?').run(source.task_id)
    }
    db.prepare('DELETE FROM monitor_sources WHERE monitor_id = ?').run(id)
    db.prepare('DELETE FROM product_monitors WHERE id = ?').run(id)
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
    const db = getDb()
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (task) {
      persistTaskState(db, id, TASK_STATE.MONITORING)
      taskManager.startTask({ ...task, status: TASK_STATE.MONITORING })
    }
    return true
  })
  ipcMain.handle(IPC.TASKS_TEST, async (_, id) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!task) throw new Error('Task not found')
    return taskManager.testTask(task)
  })
  ipcMain.handle(IPC.TASKS_STOP, (_, id) => {
    persistTaskState(getDb(), id, TASK_STATE.IDLE)
    taskManager.stopTask(id)
    return true
  })
  ipcMain.handle(IPC.TASKS_DELETE, async (_, id) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    taskManager.stopTask(id)
    // stopTask only unsubscribes tasks running in this session; a deleted task
    // that was stopped (or from a previous session) must still drop its central
    // subscription or the Pi keeps monitoring it. Idempotent if both run.
    if (task) await taskManager.unsubscribeCentral(task).catch(() => {})
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return true
  })

  // Payment Methods
  ipcMain.handle(IPC.PAYMENTS_GET, () => paymentManager.getAllSafe())
  ipcMain.handle(IPC.PAYMENTS_CREATE, (_, data) => paymentManager.create(data))
  ipcMain.handle(IPC.PAYMENTS_UPDATE, (_, id, fields) => {
    paymentManager.update(id, fields)
    return true
  })
  ipcMain.handle(IPC.PAYMENTS_DELETE, (_, id) => {
    paymentManager.delete(id)
    return true
  })

  // Shipping Addresses
  ipcMain.handle(IPC.SHIPPING_GET, () => shippingManager.getAll())
  ipcMain.handle(IPC.SHIPPING_CREATE, (_, data) => shippingManager.create(data))
  ipcMain.handle(IPC.SHIPPING_UPDATE, (_, id, fields) => {
    shippingManager.update(id, fields)
    return true
  })
  ipcMain.handle(IPC.SHIPPING_DELETE, (_, id) => {
    shippingManager.delete(id)
    return true
  })
  ipcMain.handle(IPC.SHIPPING_SET_DEFAULT, (_, id) => {
    shippingManager.setDefault(id)
    return true
  })

  // Thumbnails
  ipcMain.handle('thumbnails:download', async (_, imageUrl) => {
    return await thumbnailCache.downloadThumbnail(imageUrl)
  })
  ipcMain.handle('thumbnails:get', async (_, imageUrl) => {
    return thumbnailCache.getThumbnailPath(imageUrl)
  })
  ipcMain.handle('thumbnails:clear', async () => {
    await thumbnailCache.clearCache()
    return true
  })

  // Alerts
  ipcMain.handle('alerts:getHistory', () => {
    return getDb().prepare('SELECT * FROM alert_history ORDER BY created_at DESC LIMIT 100').all()
  })
  ipcMain.handle('alerts:markSeen', (_, id) => {
    getDb()
      .prepare('UPDATE alert_history SET seen = 1, acknowledged_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), id)
    return true
  })
  ipcMain.handle('alerts:getUnseen', () => {
    return getDb()
      .prepare('SELECT * FROM alert_history WHERE seen = 0 ORDER BY created_at DESC')
      .all()
  })
  ipcMain.handle('alerts:clearHistory', () => {
    getDb().prepare('DELETE FROM alert_history').run()
    return true
  })

  // Config Management - Temporarily disabled
  // ipcMain.handle(IPC.CONFIG_EXPORT, async () => {
  //   return await configManager.exportToConfig(getDb, accountManager)
  // })

  // ipcMain.handle(IPC.CONFIG_IMPORT, async (_, filePath) => {
  //   return await configManager.importFromConfig(filePath, getDb, accountManager)
  // })

  // ipcMain.handle(IPC.CONFIG_CREATE_EXAMPLE, () => {
  //   return configManager.createExampleConfig()
  // })

  // Pokemon Finder
  ipcMain.handle('pokemon:getAll', () => pokemonFinder.getAllItems())
  ipcMain.handle('pokemon:getNew', () => pokemonFinder.getNewItems())
  ipcMain.handle('pokemon:markSeen', (_, id) => {
    pokemonFinder.markAsSeen(id)
    return true
  })
  ipcMain.handle('pokemon:scanNow', async () => {
    const items = await pokemonFinder.scanAll()
    return items
  })

  // Walmart queue auto-join. One real session per item — takes a legitimate spot,
  // tracks position, pings on "your turn". Human finishes checkout.
  ipcMain.handle(IPC.QUEUE_JOIN, (_, { id, productUrl, label }) => {
    if (!id || !productUrl) throw new Error('id and productUrl are required to join a queue')
    // Resolve the task's first assigned account so the queue rides its logged-in
    // Walmart session. No account → joiner runs logged-out and says so.
    const task = getDb().prepare('SELECT account_ids FROM tasks WHERE id = ?').get(id)
    let account = null
    try {
      const accountIds = JSON.parse(task?.account_ids || '[]')
      if (accountIds.length) account = accountManager.getDecrypted(accountIds[0]) || null
    } catch {
      /* no/invalid account_ids — run logged-out */
    }
    queueJoiner.start(id, { productUrl, label, account })
    return true
  })
  ipcMain.handle(IPC.QUEUE_STOP, (_, id) => {
    if (queueJoiner.isJoining(id)) return queueJoiner.stop(id)
    return pokemonCenterQueueJoiner?.stop(id)
  })

  queueJoiner.on('progress', (p) => mainWindow?.webContents?.send(IPC.QUEUE_PROGRESS, p))
  queueJoiner.on('turn', ({ label, status }) =>
    notificationEngine?.fire({
      retailer: 'walmart',
      productName: `🎟️ YOUR TURN: ${status?.itemName || label}`,
      dropType: DROP_TYPES.QUEUE_OPEN,
      price: status?.price
    })
  )
  pokemonCenterQueueJoiner?.on('progress', (p) =>
    mainWindow?.webContents?.send(IPC.QUEUE_PROGRESS, p)
  )
  pokemonCenterQueueJoiner?.on('turn', ({ label }) =>
    notificationEngine?.fire({
      retailer: 'pokemon-center',
      productName: `POKEMON CENTER ADMITTED: ${label}`,
      dropType: DROP_TYPES.QUEUE_OPEN
    })
  )

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

function normalizeOrdersPerDrop(value, retailer) {
  if (retailer !== 'target') return 1
  const numericValue = Number.parseInt(value, 10)
  return numericValue === 2 ? 2 : 1
}

function toNullablePrice(value) {
  if (value === '' || value == null) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function listProductMonitors(db) {
  const monitors = db.prepare('SELECT * FROM product_monitors ORDER BY created_at DESC').all()
  const sourceStatement = db.prepare(
    'SELECT * FROM monitor_sources WHERE monitor_id = ? ORDER BY retailer'
  )
  return monitors.map((monitor) => ({
    ...monitor,
    sources: sourceStatement.all(monitor.id).map((source) => ({
      ...source,
      enabled: source.enabled === 1,
      account_ids: safeJsonArray(source.account_ids)
    }))
  }))
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isMissingCatalogPriceColumn(error) {
  if (!error) return false
  return (
    error.code === '42703' ||
    /column\s+target_catalog\.(regular_price|current_price|price_checked_at)\s+does not exist/i.test(
      error.message || ''
    )
  )
}
