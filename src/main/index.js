import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb, getDb } from './db.js'
import { deriveKeyLegacy } from './crypto.js'
import { AccountManager } from './accounts/AccountManager.js'
import { BrowserPool } from './automation/BrowserPool.js'
import { QueueJoiner } from './automation/QueueJoiner.js'
import { NotificationEngine } from './notify/NotificationEngine.js'
import { TaskManager } from './tasks/TaskManager.js'
import { createPokemonFinder } from './monitor/PokemonFinder.js'
import { ProfileWarmup } from './automation/profileWarmup.js'
import { progressStreamer } from './utils/progressStreamer.js'
import { PaymentManager } from './payments/PaymentManager.js'
import { ShippingManager } from './shipping/ShippingManager.js'
import { ThumbnailCache } from './thumbnails/ThumbnailCache.js'
// import { ConfigManager } from './config/configManager.js'
import { registerIpcHandlers } from './ipc.js'
import { getSupabaseSession } from './supabase/session.js'
import { logger } from './utils/logger.js'
import { IPC } from '../shared/constants.js'

let mainWindow
let taskManager
let pokemonFinder
let queueJoiner
let encryptionKey = null
const TEMP_DEV_VAULT_PASSWORD = 'pokebot-dev-vault'

function getSettings() {
  try {
    const rows = getDb().prepare('SELECT key, value FROM settings').all()
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  } catch {
    return {}
  }
}

async function createMainWindow(encryptionKey) {
  const dbPath = join(app.getPath('userData'), 'pokebot.db')
  initDb(dbPath)

  const accountManager = new AccountManager(getDb, encryptionKey)
  const paymentManager = new PaymentManager(getDb, encryptionKey)
  const shippingManager = new ShippingManager(getDb)
  const thumbnailCache = new ThumbnailCache()
  const settings = getSettings()
  const browserPool = new BrowserPool({ maxConcurrent: settings.maxConcurrent || 3 })
  const notificationEngine = new NotificationEngine(getSettings)
  const profileWarmup = new ProfileWarmup(browserPool)
  queueJoiner = new QueueJoiner({ browserPool })
  // const configManager = new ConfigManager()
  const configManager = null // Temporarily disabled

  // Connect to Supabase (PokeAlert) at startup regardless of monitor mode —
  // the shared session is reused by catalog browsing and task monitoring.
  // No-op (returns null) until bot email/password are set in Settings.
  getSupabaseSession({ getSettings, encryptionKey }).catch((err) => {
    logger.warn('Supabase session not established at startup', { error: err.message })
  })

  taskManager = new TaskManager({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings,
    encryptionKey,
    queueJoiner
  })
  
  // Initialize Pokemon Finder (disabled for now)
  pokemonFinder = createPokemonFinder(getDb)
  pokemonFinder.on('newItems', (items) => {
    // Send notification for new Pokemon items
    items.forEach(item => {
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
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
    encryptionKey,
    mainWindow,
    browserPool,
    notificationEngine,
    queueJoiner
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // mainWindow.webContents.openDevTools() // Disabled - press F12 to open if needed
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.checkForUpdatesAndNotify()
    autoUpdater.on('update-available', () => mainWindow?.webContents?.send('update:available'))
    autoUpdater.on('update-downloaded', () => mainWindow?.webContents?.send('update:downloaded'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.pokebot2.app')

  // Configure logger
  const logDir = join(app.getPath('userData'), 'logs')
  logger.setLogDir(logDir)
  logger.setLevel(is.dev ? 'DEBUG' : 'INFO')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  encryptionKey = deriveKeyLegacy(TEMP_DEV_VAULT_PASSWORD)
  await createMainWindow(encryptionKey)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(encryptionKey)
    }
  })
})

app.on('window-all-closed', () => {
  taskManager?.stopAll()
  queueJoiner?.stopAll()
  if (process.platform !== 'darwin') app.quit()
})
