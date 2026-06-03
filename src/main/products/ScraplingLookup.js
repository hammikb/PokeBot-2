import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/scrapling_lookup.py'
)
const DEFAULT_TIMEOUT_MS = 30000

export async function lookupProductWithScrapling(productUrl, options = {}) {
  if (!existsSync(SCRIPT_PATH)) return null

  const candidates = buildPythonCandidates(options.pythonCommand)
  let lastResult = null
  for (const candidate of candidates) {
    const result = await runScraplingLookup(
      candidate.command,
      [...candidate.args, SCRIPT_PATH, productUrl],
      options.timeoutMs
    )
    lastResult = result
    if (result.unavailable) {
      lastResult = result
      continue
    }
    if (result.product) return result.product
    if (result.blocked) throw retailerBlockError(productUrl, result)
    return null
  }

  if (lastResult?.blocked) throw retailerBlockError(productUrl, lastResult)
  if (lastResult?.unavailable) {
    const err = new Error(lastResult.error || 'Scrapling lookup unavailable')
    err.code = 'SCRAPLING_UNAVAILABLE'
    throw err
  }
  return null
}

function buildPythonCandidates(pythonCommand) {
  if (pythonCommand) return [{ command: pythonCommand, args: [] }]
  if (process.platform === 'win32') {
    return [
      { command: 'python', args: [] },
      { command: 'py', args: ['-3'] }
    ]
  }
  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] }
  ]
}

function runScraplingLookup(command, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolveResult({ unavailable: true, error: 'Scrapling lookup timed out' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolveResult({ unavailable: true, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const payload = parsePayload(stdout) || parsePayload(stderr)
      if (payload?.ok && payload.product) {
        resolveResult({ product: payload.product })
        return
      }
      if (payload?.code === 'blocked' || payload?.status === 403) {
        resolveResult({ blocked: true, status: 403, error: payload.error })
        return
      }
      if (payload?.code === 'missing_dependency' || code === 3) {
        resolveResult({ unavailable: true, error: payload?.error || 'Scrapling is not installed' })
        return
      }
      resolveResult({ unavailable: true, error: payload?.error || stderr || stdout })
    })
  })
}

function parsePayload(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const lines = text.split(/\r?\n/).reverse()
  for (const line of lines) {
    try {
      return JSON.parse(line)
    } catch {
      // Scrapling or Python may write non-JSON logs before the payload.
    }
  }
  return null
}

function retailerBlockError(productUrl, result) {
  const err = new Error(result.error || 'Retailer page is showing a CAPTCHA or robot check')
  err.status = result.status || 403
  err.response = { status: err.status, data: { captchaRelativeURL: productUrl } }
  return err
}
