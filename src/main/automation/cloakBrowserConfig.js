import { createHash } from 'node:crypto'

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
  extraArgs = []
}) {
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
    args: [...SAFE_BROWSER_ARGS, ...extraArgs, `--fingerprint=${stableFingerprintSeed(identity)}`],
    ...(proxyUrl ? { proxy: proxyUrl } : {})
  }
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
