import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb, getDb } from './db.js'
import { deriveKey } from './crypto.js'
import { AccountManager } from './accounts/AccountManager.js'
import { BrowserPool } from './automation/BrowserPool.js'
import { NotificationEngine } from './notify/NotificationEngine.js'
import { TaskManager } from './tasks/TaskManager.js'
import { registerIpcHandlers } from './ipc.js'
import { IPC } from '../shared/constants.js'

let mainWindow
let taskManager
let encryptionKey = null

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
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  registerIpcHandlers({ getDb, accountManager, taskManager, getSettings, mainWindow })

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

async function showUnlockWindow() {
  return new Promise((resolve) => {
    const unlockWindow = new BrowserWindow({
      width: 420,
      height: 220,
      resizable: false,
      backgroundColor: '#0f0f0f',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    ipcMain.handleOnce(IPC.UNLOCK, (_, password) => {
      const key = deriveKey(password)
      unlockWindow.close()
      resolve(key)
      return true
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      unlockWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/unlock')
    } else {
      unlockWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/unlock' })
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.pokebot2.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  encryptionKey = await showUnlockWindow()
  await createMainWindow(encryptionKey)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && encryptionKey) {
      createMainWindow(encryptionKey)
    }
  })
})

app.on('window-all-closed', () => {
  taskManager?.stopAll()
  if (process.platform !== 'darwin') app.quit()
})
