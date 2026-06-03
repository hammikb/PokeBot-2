import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb, getDb } from './db.js'
import { deriveKeyLegacy } from './crypto.js'
import { AccountManager } from './accounts/AccountManager.js'
import { BrowserPool } from './automation/BrowserPool.js'
import { NotificationEngine } from './notify/NotificationEngine.js'
import { TaskManager } from './tasks/TaskManager.js'
import { registerIpcHandlers } from './ipc.js'
import { logger } from './utils/logger.js'

let mainWindow
let taskManager
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
  taskManager = new TaskManager({ accountManager, notificationEngine, browserPool, getDb })

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
