import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb, getDb } from './db.js'
import { deriveKeyLegacy } from './crypto.js'
import { AccountManager } from './accounts/AccountManager.js'
import { BrowserPool } from './automation/BrowserPool.js'
import { NotificationEngine } from './notify/NotificationEngine.js'
import { TaskManager } from './tasks/TaskManager.js'
import { createPokemonFinder } from './monitor/PokemonFinder.js'
import { ProfileWarmup } from './automation/profileWarmup.js'
import { registerIpcHandlers } from './ipc.js'
import { logger } from './utils/logger.js'

let mainWindow
let taskManager
let pokemonFinder
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
  const settings = getSettings()
  const browserPool = new BrowserPool({ maxConcurrent: settings.maxConcurrent || 3 })
  const notificationEngine = new NotificationEngine(getSettings)
  const profileWarmup = new ProfileWarmup(browserPool)
  taskManager = new TaskManager({ accountManager, notificationEngine, browserPool, getDb })
  
  // Initialize Pokemon Finder
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
  // Start scanning every 30 minutes
  pokemonFinder.startScanning(30)

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
    taskManager,
    pokemonFinder,
    profileWarmup,
    getSettings,
    mainWindow,
    browserPool,
    notificationEngine
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
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
  if (process.platform !== 'darwin') app.quit()
})
