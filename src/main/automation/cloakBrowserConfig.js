import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('CloakBrowser')

const DEFAULT_LOCALE = 'en-US'
const DEFAULT_TIMEZONE = 'America/Los_Angeles'

// Keep this list intentionally small. CloakBrowser supplies its own stealth and
// fingerprint switches; duplicating them here can create contradictory signals.
const SAFE_BROWSER_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--mute-audio',
  '--disable-sync'
]

export function buildCloakBrowserOptions({
  identity,
  proxyUrl = null,
  headless = false,
  extraArgs = [],
  debugMarkerDir = null
}) {
  const debugArgs = buildRemoteDebuggingArgs(process.env.POKEBOT_DEBUG_PORT, debugMarkerDir)
  const locale = import.meta.env?.MAIN_VITE_BROWSER_LOCALE?.trim() || DEFAULT_LOCALE
  const timezone = import.meta.env?.MAIN_VITE_BROWSER_TIMEZONE?.trim() || DEFAULT_TIMEZONE

  return {
    headless,
    humanize: true,
    // GeoIP still resolves the proxy exit IP for WebRTC consistency. Explicit
    // locale/timezone take precedence and avoid gateway-location ambiguity.
    geoip: Boolean(proxyUrl),
    locale,
    timezone,
    args: [
      ...SAFE_BROWSER_ARGS,
      ...debugArgs,
      ...extraArgs,
      `--fingerprint=${stableFingerprintSeed(identity)}`
    ],
    ...(proxyUrl ? { proxy: proxyUrl } : {})
  }
}

/**
 * Opt-in Chromium remote debugging, for attaching DevTools or a CDP client to a live
 * checkout run. Off unless POKEBOT_DEBUG_PORT is set, because it is a diagnostic hole,
 * not something to leave open during real drops.
 *
 * Use 0 (or "auto") to let Chromium pick a free port - each account launches its own
 * browser process, so a fixed port collides as soon as a second one starts. Chromium
 * writes the chosen port to <userDataDir>/DevToolsActivePort.
 */
export function buildRemoteDebuggingArgs(
  rawPort = process.env.POKEBOT_DEBUG_PORT,
  markerDir = null
) {
  // Env vars do not survive launching the app from a shortcut or a different shell,
  // which is exactly how this silently stayed off. A marker file works either way:
  //   echo auto > %APPDATA%\pokebot2\debug-port
  const value = (String(rawPort ?? '').trim() || readDebugMarker(markerDir)).trim()
  if (!value) return []
  const port = value.toLowerCase() === 'auto' ? 0 : Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return []
  return [
    `--remote-debugging-port=${port}`,
    // Never expose the debugger beyond this machine.
    '--remote-debugging-address=127.0.0.1'
  ]
}

export function stableFingerprintSeed(identity) {
  const source = String(identity || 'pokebot-default-profile')
  const digest = createHash('sha256').update(source).digest()
  // CloakBrowser accepts a numeric fingerprint seed. Keep it positive and
  // non-zero while deriving it deterministically from the persistent identity.
  return digest.readUInt32BE(0) & 0x7fffffff || 1
}

export function redactProxyUrl(proxyUrl) {
  if (!proxyUrl) return null
  try {
    const parsed = new URL(proxyUrl)
    const username = parsed.username ? `${decodeURIComponent(parsed.username).slice(0, 4)}…` : ''
    return `${parsed.protocol}//${username ? `${username}@` : ''}${parsed.host}`
  } catch {
    return '[configured proxy]'
  }
}

function readDebugMarker(markerDir) {
  if (!markerDir) return ''
  try {
    return readFileSync(join(markerDir, 'debug-port'), 'utf8').split(/\r?\n/)[0].trim()
  } catch {
    return ''
  }
}

/**
 * Chromium writes the port it actually bound to into <userDataDir>/DevToolsActivePort
 * (line 1). Surface it so a CDP client can attach without guessing.
 */
export function readDevToolsPort(profilePath) {
  try {
    const contents = readFileSync(join(profilePath, 'DevToolsActivePort'), 'utf8')
    const parsed = Number(contents.split(/\r?\n/)[0].trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export function logRemoteDebuggingEndpoint(accountId, profilePath, logger = log) {
  const markerDir = dirname(dirname(profilePath))
  if (buildRemoteDebuggingArgs(process.env.POKEBOT_DEBUG_PORT, markerDir).length === 0) return null
  const port = readDevToolsPort(profilePath)
  if (!port) {
    logger.warn('Remote debugging requested but no DevToolsActivePort was written', {
      accountId,
      profilePath
    })
    return null
  }
  logger.info('Chromium remote debugging is open for this account', {
    accountId,
    cdpEndpoint: `http://127.0.0.1:${port}`,
    attachWith: `chromium.connectOverCDP('http://127.0.0.1:${port}')`
  })
  return port
}
