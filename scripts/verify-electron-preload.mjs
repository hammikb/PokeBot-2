import { _electron as electron } from 'playwright-core'
import electronExecutable from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let electronApp
try {
  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: ['.'],
    cwd: process.cwd(),
    env
  })
  const window = await electronApp.firstWindow({ timeout: 30_000 })
  const result = await window.evaluate(async () => {
    const ipc = window.electron?.ipcRenderer
    if (!ipc?.invoke) return { bridge: false, authIpc: false }
    try {
      await ipc.invoke('auth:get-status')
      return { bridge: true, authIpc: true }
    } catch (error) {
      return { bridge: true, authIpc: false, error: error.message }
    }
  })

  if (!result.bridge || !result.authIpc) {
    throw new Error(`Electron preload verification failed: ${JSON.stringify(result)}`)
  }
  const eventPromise = window.evaluate(
    () =>
      new Promise((resolve) => {
        const unsubscribe = window.electron.ipcRenderer.on('task:status', (...args) => {
          unsubscribe()
          resolve({ argCount: args.length, payload: args[0] })
        })
        window.__pb2BridgeListenerReady = true
      })
  )
  await window.waitForFunction(() => window.__pb2BridgeListenerReady === true)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('task:status', {
      taskId: 'preload-smoke',
      status: 'monitoring'
    })
  })
  const eventResult = await eventPromise
  if (
    eventResult.argCount !== 1 ||
    eventResult.payload?.taskId !== 'preload-smoke' ||
    eventResult.payload?.status !== 'monitoring'
  ) {
    throw new Error(`Electron event bridge exposed an unsafe payload: ${JSON.stringify(eventResult)}`)
  }
  const visibleText = await window.locator('body').innerText()
  if (visibleText.includes('IPC not available')) {
    throw new Error('Renderer still reports that IPC is unavailable')
  }
  const screenshotPath = join(tmpdir(), 'pokebot-electron-smoke.png')
  await window.screenshot({ path: screenshotPath })
  console.log('Electron preload bridge and auth IPC verified.')
  console.log(`Screenshot: ${screenshotPath}`)
} finally {
  await electronApp?.close().catch(() => {})
}
