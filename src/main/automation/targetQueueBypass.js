/**
 * Target Queue Bypass Module
 *
 * For hyped drops, Target often places you in a virtual waiting room. The web queue
 * system is brittle. This module:
 *
 *   1. Probes direct checkout/cart links while the queue is active.
 *   2. Attempts cart injection via the API while the queue is counting down.
 *   3. Injects queue-bypass query parameters when detected.
 */
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('TargetQueueBypass')

const QUEUE_MARKERS = [
  /waiting room/i,
  /virtual queue/i,
  /you're in line/i,
  /you are in line/i,
  /hold tight/i,
  /queue/i,
  /waiting/i
]

const QUEUE_BYPASS_PARAMS = ['forceCheckout=true', 'bypassQueue=true', 'skipQueue=true']

const DIRECT_CHECKOUT_URLS = [
  'https://www.target.com/co-cart',
  'https://www.target.com/co-checkout',
  'https://www.target.com/checkout'
]

export async function isTargetQueueActive(page) {
  try {
    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 3000 })
      .catch(() => '')
    return QUEUE_MARKERS.some((marker) => marker.test(bodyText))
  } catch {
    return false
  }
}

export async function attemptTargetQueueBypass(page, { onStep = () => {} } = {}) {
  const currentUrl = page.url?.() || ''
  const queueActive = await isTargetQueueActive(page)

  if (!queueActive) {
    return { bypassed: false, reason: 'no-queue-detected' }
  }

  onStep('Target queue detected - attempting direct checkout link bypass')

  // Try direct checkout URLs first. The queue often only gatekeeps the product
  // page or add-to-cart; a pre-built cart can still be checked out.
  for (const url of DIRECT_CHECKOUT_URLS) {
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      const status = response?.status() ?? 0
      const stillQueued = await isTargetQueueActive(page)

      if (!stillQueued && status !== 403 && status !== 429) {
        onStep(`Queue bypassed via direct link: ${url}`)
        log.info('Target queue bypassed via direct checkout link', { url, status })
        return { bypassed: true, method: 'direct-link', url, status }
      }
    } catch (err) {
      log.debug('Direct checkout link probe failed', { url, error: err.message })
    }
  }

  // Try queue-bypass query parameters on the current URL
  for (const param of QUEUE_BYPASS_PARAMS) {
    try {
      const separator = currentUrl.includes('?') ? '&' : '?'
      const bypassUrl = `${currentUrl}${separator}${param}`
      const response = await page.goto(bypassUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      const status = response?.status() ?? 0
      const stillQueued = await isTargetQueueActive(page)

      if (!stillQueued && status !== 403 && status !== 429) {
        onStep(`Queue bypassed via query parameter: ${param}`)
        log.info('Target queue bypassed via query parameter', { param, status })
        return { bypassed: true, method: 'query-param', param, status }
      }
    } catch (err) {
      log.debug('Queue bypass query parameter probe failed', { param, error: err.message })
    }
  }

  onStep('Queue bypass attempts failed - continuing with normal flow')
  return { bypassed: false, reason: 'all-bypass-attempts-failed' }
}
