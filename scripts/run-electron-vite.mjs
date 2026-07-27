import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const command = process.argv[2]
const allowedCommands = new Set(['dev', 'preview'])

if (!allowedCommands.has(command)) {
  console.error('Usage: node scripts/run-electron-vite.mjs <dev|preview>')
  process.exit(1)
}

// Some automation shells set this flag so Electron can be used as a plain Node
// executable. If it leaks into the app launch, Electron exits before creating a
// BrowserWindow and users see the renderer in Chrome without the preload IPC bridge.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const cliPath = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)
)
const child = spawn(process.execPath, [cliPath, command], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`Could not start electron-vite: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
