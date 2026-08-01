import { app, BrowserWindow, dialog, powerMonitor, safeStorage, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb, getDb } from './db.js'
import { initializeVaultKey } from './security/VaultKeyManager.js'
import { AccountManager } from './accounts/AccountManager.js'
import { BrowserPool } from './automation/BrowserPool.js'
import { QueueJoiner } from './automation/QueueJoiner.js'
import { PokemonCenterQueueJoiner } from './automation/PokemonCenterQueueJoiner.js'
import { NotificationEngine } from './notify/NotificationEngine.js'
import { TaskManager } from './tasks/TaskManager.js'
import { createPokemonFinder } from './monitor/PokemonFinder.js'
import { ProfileWarmup } from './automation/profileWarmup.js'
import { listTasksToResume } from './tasks/TaskState.js'
import { progressStreamer } from './utils/progressStreamer.js'
import { PaymentManager } from './payments/PaymentManager.js'
import { ShippingManager } from './shipping/ShippingManager.js'
import { ThumbnailCache } from './thumbnails/ThumbnailCache.js'
import { registerIpcHandlers } from './ipc.js'
import { AuthSessionManager } from './supabase/AuthSessionManager.js'
import { CheckoutTelemetry } from './telemetry/CheckoutTelemetry.js'
import { logger } from './utils/logger.js'
import { IPC } from '../shared/constants.js'
import { runStartupDiagnostics } from './health/StartupDiagnostics.js'
import { MonitorHealth } from './health/MonitorHealth.js'
import { configureRendererSecurity } from './security/RendererSecurity.js'
import { attachRendererRecovery } from './lifecycle/RendererRecovery.js'

let mainWindow
let taskManager
let pokemonFinder
let queueJoiner
let pokemonCenterQueueJoiner
let browserPool
let encryptionKey = null
let shutdownPromise = null
let startupDiagnostics = null
let authSessionManager
let checkoutTelemetry
let monitorHealth
let rendererRecovery
const CAPSOLVER_API_KEY = import.meta.env.MAIN_VITE_CAPSOLVER_API_KEY || null

function getSettings() {
  try {
    const rows = getDb().prepare('SELECT key, value FROM settings').all()
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  } catch {
    return {}
  }
}

async function createMainWindow(encryptionKey) {
  const accountManager = new AccountManager(getDb, encryptionKey)
  const paymentManager = new PaymentManager(getDb, encryptionKey)
  const shippingManager = new ShippingManager(getDb)
  const thumbnailCache = new ThumbnailCache()
  const settings = getSettings()
  browserPool = new BrowserPool({
    maxConcurrent: settings.maxConcurrent || 3,
    // A keepalive that sees a block must stop the whole retailer, not just itself —
    // requests made after the first block are what escalated the 2026-07-17 rate limit
    // from a soft fallback into lost carts. taskManager is assigned further below; this
    // only fires once a pinned context exists, which is well after that point.
    onBlocked: ({ accountId, retailer, reason }) => {
      taskManager?.reportRetailerBlocked?.(retailer, `${reason} (keepalive, ${accountId})`)
    }
  })
  const notificationEngine = new NotificationEngine()
  const profileWarmup = new ProfileWarmup(browserPool)
  queueJoiner = new QueueJoiner({ browserPool })
  pokemonCenterQueueJoiner = new PokemonCenterQueueJoiner({
    browserPool,
    maxWaitMin: 180,
    notificationEngine,
    openExternal: (url) => shell.openExternal(url),
    capsolverApiKey: CAPSOLVER_API_KEY
  })
  const configManager = null // Placeholder for future use

  // Per-user Supabase Auth session, reused by catalog browsing and task monitoring.
  // Silently restores a prior sign-in (encrypted refresh token in `settings`) before the
  // window loads, so the renderer's first AUTH_GET_STATUS call already reflects the real
  // state — no login-screen flash for an already-signed-in user. `mainWindow` is assigned
  // further below; the 'change' listener only fires after that point, via closure.
  authSessionManager = new AuthSessionManager({ getDb, encryptionKey })
  // restoreSession() itself never rejects, so the only startup-blocking risk is the
  // underlying network call hanging with no timeout. Bound the wait so a bad connection
  // delays the window by at most 8s instead of indefinitely — the renderer's own
  // AUTH_GET_STATUS pull is still the source of truth once this resolves either way.
  await Promise.race([
    authSessionManager.restoreSession().catch((err) => {
      logger.warn('Supabase session restore failed at startup', { error: err.message })
    }),
    new Promise((resolve) => setTimeout(resolve, 8000))
  ])
  authSessionManager.on('change', (state) => {
    mainWindow?.webContents?.send(IPC.AUTH_STATE_CHANGED, state)
    Promise.resolve(taskManager?.handleAuthChange?.(state))
      .then(async () => {
        if (!state.authenticated) return
        if (getSettings().pokemonCenterAutoJoin === true) {
          await taskManager?.setPokemonCenterAutoJoin(true)
        }
        // TaskManager.handleAuthChange reconnects this feed itself. Calling it
        // here only covers a manager created after the auth event was emitted.
        if (
          getSettings().walmartJoinAllQueues === true &&
          !taskManager?.isWalmartJoinAllQueuesEnabled?.()
        ) {
          await taskManager?.setWalmartJoinAllQueues(true)
        }
      })
      .catch((err) => {
        logger.warn('TaskManager', 'Could not switch central monitoring account cleanly', {
          error: err.message
        })
      })
  })
  authSessionManager.on('realtime-heartbeat', (status) => {
    taskManager?.handleRealtimeHeartbeat?.(status)
  })

  checkoutTelemetry = new CheckoutTelemetry({
    getDb,
    authSessionManager,
    getSettings,
    appVersion: app.getVersion()
  })
  checkoutTelemetry.flushPending().catch((err) => {
    logger.warn('CheckoutTelemetry', 'Could not flush pending checkout telemetry', {
      error: err.message
    })
  })

  taskManager = new TaskManager({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings,
    authSessionManager,
    queueJoiner,
    pokemonCenterQueueJoiner,
    checkoutTelemetry,
    paymentManager
  })
  monitorHealth = new MonitorHealth({
    authSessionManager,
    taskManager
  })
  taskManager.retryPendingUnsubscribes().catch((error) => {
    logger.warn('TaskManager', 'Could not clear pending central monitor stops yet', {
      error: error.message
    })
  })

  if (settings.pokemonCenterAutoJoin === true) {
    taskManager.setPokemonCenterAutoJoin(true).catch((err) => {
      logger.warn('TaskManager', 'Could not resume Pokemon Center auto-join', {
        error: err.message
      })
    })
  }
  if (settings.walmartJoinAllQueues === true) {
    taskManager.setWalmartJoinAllQueues(true).catch((err) => {
      logger.warn('TaskManager', 'Could not resume Walmart join-all-queues', {
        error: err.message
      })
    })
  }

  // A retailer source can remain configured while its task is paused. Resume
  // only sources whose task was explicitly left monitoring; Stop must survive
  // an app restart without deleting the product from the watchlist.
  try {
    // Use simple selects so this also works with the app's JSON database fallback,
    // whose intentionally small SQL parser does not implement JOINs.
    const db = getDb()
    const enabledTasks = listTasksToResume(db)
    const resumeResults = await Promise.allSettled(
      enabledTasks.map((task) => taskManager.startTask(task))
    )
    const resumedCount = resumeResults.filter((result) => result.status === 'fulfilled').length
    logger.info('TaskManager', 'Resumed enabled monitor tasks', {
      count: resumedCount,
      failed: enabledTasks.length - resumedCount
    })
  } catch (err) {
    logger.warn('TaskManager', 'Could not resume enabled monitor tasks', { error: err.message })
  }

  // Initialize Pokemon Finder (disabled for now)
  pokemonFinder = createPokemonFinder(getDb)
  pokemonFinder.on('newItems', (items) => {
    // Send notification for new Pokemon items
    items.forEach((item) => {
      notificationEngine.fire({
        retailer: item.retailer,
        productName: `🆕 NEW: ${item.productName}`,
        productUrl: item.productUrl,
        dropType: 'in_stock',
        price: item.price
      })
    })
    // Notify renderer
    mainWindow?.webContents?.send('pokemon:newItems', items)
  })
  // Start scanning every 30 minutes - DISABLED
  // pokemonFinder.startScanning(30)

  // Forward progress stream events to renderer
  progressStreamer.on('stream:start', (data) => {
    mainWindow?.webContents?.send(IPC.PROGRESS_STREAM_START, data)
  })
  progressStreamer.on('stream:step', (data) => {
    mainWindow?.webContents?.send(IPC.PROGRESS_STREAM_STEP, data)
  })
  progressStreamer.on('stream:update', (data) => {
    mainWindow?.webContents?.send(IPC.PROGRESS_STREAM_UPDATE, data)
  })
  progressStreamer.on('stream:success', (data) => {
    mainWindow?.webContents?.send(IPC.PROGRESS_STREAM_SUCCESS, data)
  })
  progressStreamer.on('stream:error', (data) => {
    mainWindow?.webContents?.send(IPC.PROGRESS_STREAM_ERROR, data)
  })

  const rendererEntry =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    center: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  configureRendererSecurity({
    window: mainWindow,
    trustedRendererUrl: rendererEntry,
    openExternal: (url) => shell.openExternal(url),
    onExternalOpenError: (error, url) => {
      logger.warn('Renderer', 'External link could not be opened', {
        url,
        error: error.message
      })
    }
  })
  rendererRecovery?.dispose?.()
  rendererRecovery = attachRendererRecovery({
    window: mainWindow,
    isShuttingDown: () => Boolean(shutdownPromise),
    onRecovery: (reason) => {
      logger.warn('Renderer', 'Reloading the Electron interface after a renderer failure', {
        reason
      })
    },
    onUnresponsive: () => {
      logger.warn('Renderer', 'The Electron interface became unresponsive')
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.maximize()
  })

  registerIpcHandlers({
    getDb,
    accountManager,
    paymentManager,
    shippingManager,
    thumbnailCache,
    taskManager,
    pokemonFinder,
    profileWarmup,
    configManager,
    getSettings,
    authSessionManager,
    mainWindow,
    browserPool,
    notificationEngine,
    queueJoiner,
    pokemonCenterQueueJoiner,
    checkoutTelemetry,
    monitorHealth,
    getStartupDiagnostics: () => startupDiagnostics
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(rendererEntry)
    // mainWindow.webContents.openDevTools() // Disabled - press F12 to open if needed
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    if (app.isPackaged) {
      try {
        const updaterModule = await import('electron-updater')
        const autoUpdater = updaterModule.autoUpdater || updaterModule.default?.autoUpdater
        if (!autoUpdater) throw new Error('electron-updater did not expose autoUpdater')
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.checkForUpdatesAndNotify()
        autoUpdater.on('update-available', () => mainWindow?.webContents?.send('update:available'))
        autoUpdater.on('update-downloaded', () =>
          mainWindow?.webContents?.send('update:downloaded')
        )
      } catch (error) {
        logger.warn('Updater', 'Automatic update check is unavailable', { error: error.message })
      }
    }
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  // Two processes could replay the same durable drop and race through checkout,
  // especially when the JSON database fallback is active.
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return
    electronApp.setAppUserModelId('com.pokebot2.app')

    // Configure logger
    const logDir = join(app.getPath('userData'), 'logs')
    logger.setLogDir(logDir)
    logger.setLevel(is.dev ? 'DEBUG' : 'INFO')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })
    app.on('child-process-gone', (_event, details) => {
      logger.warn('Electron', 'An Electron child process exited', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode
      })
    })
    powerMonitor.on('suspend', () => {
      logger.info('Power', 'System suspended; preserving monitor and checkout state')
    })
    powerMonitor.on('resume', () => {
      logger.info('Power', 'System resumed; refreshing monitor channels and browser sessions')
      taskManager?.handleSystemResume?.().catch((error) => {
        logger.warn('Power', 'Resume recovery did not complete cleanly', {
          error: error.message
        })
      })
    })

    const userDataPath = app.getPath('userData')
    initDb(join(userDataPath, 'pokebot.db'))
    encryptionKey = initializeVaultKey({
      db: getDb(),
      safeStorage,
      userDataPath,
      legacyPassword: import.meta.env.MAIN_VITE_VAULT_PASSWORD
    })
    startupDiagnostics = runStartupDiagnostics({
      db: getDb(),
      safeStorage,
      settings: getSettings()
    })
    if (startupDiagnostics.status === 'fatal') {
      throw new Error('Startup diagnostics found a fatal configuration error.')
    }
    await createMainWindow(encryptionKey)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow(encryptionKey)
      }
    })
  })
  .catch((error) => {
    logger.error('Startup', 'PokeBot could not start safely', { error: error.message })
    dialog.showErrorBox('PokeBot could not start safely', error.message)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  // Keep central subscriptions on quit — closing the app is not "stop watching";
  // the Pi should keep monitoring this user's products until they explicitly
  // stop or delete the task.
  if (process.platform !== 'darwin') shutdownAndExit()
})

app.on('before-quit', (event) => {
  if (shutdownPromise) return
  event.preventDefault()
  shutdownAndExit()
})

function shutdownAndExit() {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    try {
      await settleShutdownOperations('background services', [
        () => taskManager?.shutdown?.(),
        () => queueJoiner?.stopAll?.(),
        () => pokemonCenterQueueJoiner?.stopAll?.()
      ])
      await settleShutdownOperations('browser pool', [() => browserPool?.closeAll?.()])

      for (const [name, dispose] of [
        ['renderer recovery', () => rendererRecovery?.dispose?.()],
        ['authentication session', () => authSessionManager?.dispose?.()]
      ]) {
        try {
          dispose()
        } catch (error) {
          logger.warn('Shutdown', `Could not dispose ${name} cleanly`, {
            error: error.message
          })
        }
      }
    } finally {
      app.exit(0)
    }
  })()
  return shutdownPromise
}

async function settleShutdownOperations(label, operations, timeoutMs = 5000) {
  let timeoutId
  const cleanup = Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation))
  )
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs)
    timeoutId.unref?.()
  })
  const results = await Promise.race([cleanup, timeout])
  clearTimeout(timeoutId)

  if (!results) {
    logger.warn('Shutdown', `Timed out while stopping ${label}`, { timeoutMs })
    return
  }
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('Shutdown', `Could not stop ${label} cleanly`, {
        error: result.reason?.message || String(result.reason)
      })
    }
  }
}
