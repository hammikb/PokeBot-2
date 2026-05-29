import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/constants.js'

export function registerIpcHandlers({ db, accountManager, taskManager, getSettings, mainWindow }) {
  // Settings
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_, key, value) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
    return true
  })

  // Accounts
  ipcMain.handle(IPC.ACCOUNTS_GET, () => accountManager.getAll())
  ipcMain.handle(IPC.ACCOUNTS_CREATE, async (_, data) => accountManager.create(data))
  ipcMain.handle(IPC.ACCOUNTS_UPDATE, (_, id, fields) => { accountManager.update(id, fields); return true })
  ipcMain.handle(IPC.ACCOUNTS_DELETE, (_, id) => { accountManager.delete(id); return true })

  // Tasks
  ipcMain.handle(IPC.TASKS_GET, () => db.prepare('SELECT * FROM tasks').all())
  ipcMain.handle(IPC.TASKS_CREATE, (_, data) => {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO tasks (id, retailer, product_url, product_name, max_price, mode, account_ids, interval_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.retailer,
      data.productUrl,
      data.productName || null,
      data.maxPrice || null,
      data.mode || 'monitor-and-buy',
      JSON.stringify(data.accountIds || []),
      data.intervalMs || 4000
    )
    return id
  })
  ipcMain.handle(IPC.TASKS_START, (_, id) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (task) taskManager.startTask(task)
    return true
  })
  ipcMain.handle(IPC.TASKS_STOP, (_, id) => { taskManager.stopTask(id); return true })
  ipcMain.handle(IPC.TASKS_DELETE, (_, id) => {
    taskManager.stopTask(id)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return true
  })

  // Push events to renderer
  taskManager.on('drop', (event) => mainWindow?.webContents?.send(IPC.FEED_EVENT, event))
  taskManager.on('taskStatus', (data) => mainWindow?.webContents?.send(IPC.TASK_STATUS, data))
}
