/**
 * Akamai Sensor Data Regeneration & Session Validation
 */
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('AkamaiSensor')

const PROTECTED_PROBE_ENDPOINTS = [
  'https://www.target.com/account?prehydrateClick=true',
  'https://www.target.com/co-cart'
]

const CHALLENGE_MARKERS = [
  /_abck/i,
  /sensor_data/i,
  /akamai/i,
  /access denied/i,
  /verify you are human/i,
  /robot or human/i,
  /captcha/i,
  /challenge/i
]

const FINGERPRINT_DIMENSIONS = [
  'webglVendor',
  'webglRenderer',
  'canvasHash',
  'audioHash',
  'hardwareConcurrency',
  'deviceMemory',
  'platform',
  'screenWidth',
  'screenHeight',
  'colorDepth',
  'timezoneOffset',
  'language'
]

export async function regenerateTargetSensorData(
  page,
  { endpoint = 'https://www.target.com/co-cart', timeoutMs = 15000 } = {}
) {
  const startedAt = Date.now()
  log.info('Regenerating Target Akamai sensor data', { endpoint })

  try {
    const response = await page.goto(endpoint, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(timeoutMs, 30000)
    })
    const status = response?.status() ?? 0
    const abckPresent = await waitForAbckCookie(page, timeoutMs)
    const durationMs = Date.now() - startedAt

    log.info('Target sensor data regeneration complete', { status, abckPresent, durationMs })
    return { success: abckPresent, abckPresent, status, durationMs }
  } catch (err) {
    log.warn('Target sensor data regeneration failed', { error: err.message })
    return { success: false, abckPresent: false, status: 0, error: err.message }
  }
}

export async function validateTargetSession(page, { endpoint = null } = {}) {
  const probeUrl = endpoint || PROTECTED_PROBE_ENDPOINTS[0]
  const abckPresent = await hasAbckCookie(page)

  try {
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        })
        const text = await res.text()
        return { status: res.status, body: text.slice(0, 2000) }
      } catch (err) {
        return { status: 0, body: String(err?.message || '') }
      }
    }, probeUrl)

    const challengeDetected = CHALLENGE_MARKERS.some((marker) => marker.test(result.body || ''))
    const valid = !challengeDetected && result.status !== 403 && result.status !== 429

    log.info('Target session validation result', {
      status: result.status,
      abckPresent,
      challengeDetected,
      valid
    })

    return { valid, status: result.status, challengeDetected, abckPresent }
  } catch (err) {
    log.warn('Target session validation failed', { error: err.message })
    return { valid: false, status: 0, challengeDetected: false, abckPresent, error: err.message }
  }
}

export async function hasAbckCookie(page) {
  try {
    const context = page.context?.()
    if (!context || typeof context.cookies !== 'function') return false
    const cookies = await context.cookies('https://www.target.com')
    return cookies.some((c) => c.name === '_abck' && c.value && c.value.length > 10)
  } catch {
    return false
  }
}

async function waitForAbckCookie(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await hasAbckCookie(page)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

export async function computeTargetFingerprint(page) {
  try {
    const dimensions = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
      const glInfo = gl
        ? { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) }
        : { vendor: null, renderer: null }

      const ctx = canvas.getContext('2d')
      let canvasHash = null
      if (ctx) {
        ctx.textBaseline = 'top'
        ctx.font = '14px Arial'
        ctx.fillText('PokeBot2-fingerprint-check', 2, 2)
        canvasHash = canvas.toDataURL().slice(0, 100)
      }

      let audioHash = null
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (AudioCtx) {
          const audio = new AudioCtx()
          audioHash = `${audio.sampleRate}:${audio.state}`
          audio.close?.()
        }
      } catch {
        audioHash = null
      }

      return {
        webglVendor: glInfo.vendor,
        webglRenderer: glInfo.renderer,
        canvasHash,
        audioHash,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemory: navigator.deviceMemory || null,
        platform: navigator.platform || null,
        screenWidth: window.screen?.width || null,
        screenHeight: window.screen?.height || null,
        colorDepth: window.screen?.colorDepth || null,
        timezoneOffset: new Date().getTimezoneOffset(),
        language: navigator.language || null
      }
    })

    const source = FINGERPRINT_DIMENSIONS.map((key) => `${key}=${dimensions[key] ?? ''}`).join('|')
    let hash = 0
    for (let i = 0; i < source.length; i += 1) {
      hash = (hash << 5) - hash + source.charCodeAt(i)
      hash |= 0
    }

    return { hash: String(hash >>> 0), dimensions }
  } catch (err) {
    log.warn('Fingerprint computation failed', { error: err.message })
    return { hash: null, dimensions: null, error: err.message }
  }
}

export function fingerprintMatches(expectedHash, actualHash) {
  if (!expectedHash || !actualHash) return true
  return expectedHash === actualHash
}
