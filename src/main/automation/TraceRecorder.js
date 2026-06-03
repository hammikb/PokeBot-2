import { mkdir } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'

const DEBUG_DIR = 'debug-traces'

export async function startTrace(context, { retailer, accountName, taskId = 'checkout' } = {}) {
  const dir = await getTraceDir()
  const safeAccount = safeSegment(accountName || 'account')
  const safeRetailer = safeSegment(retailer || 'retailer')
  const safeTask = safeSegment(taskId)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = `${stamp}-${safeRetailer}-${safeAccount}-${safeTask}`
  const tracePath = join(dir, `${baseName}.zip`)
  const screenshotPath = join(dir, `${baseName}.png`)
  let tracingStarted = false

  if (context?.tracing?.start) {
    await context.tracing
      .start({ screenshots: true, snapshots: true, sources: false })
      .then(() => {
        tracingStarted = true
      })
      .catch(() => {})
  }

  return {
    tracePath,
    screenshotPath,
    async capture(page) {
      if (page?.screenshot) {
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
      }
    },
    async stop() {
      if (tracingStarted && context?.tracing?.stop) {
        await context.tracing.stop({ path: tracePath }).catch(() => {})
      }
    }
  }
}

async function getTraceDir() {
  const base = typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd()
  const dir = join(base, DEBUG_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .slice(0, 80)
}
