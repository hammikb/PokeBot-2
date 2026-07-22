import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('TargetPageCoordinator')
const COORDINATOR_VERSION = 1

/**
 * Installs a tiny, page-local signal bus. Target updates most checkout UI through
 * React without navigating, so waiting only for load events misses important state
 * changes. The observer does no network work and persists across future documents
 * through addInitScript.
 */
function installCoordinatorInPage(version) {
  const install = () => {
    if (window.__pb2TargetCoordinator?.version === version) return

    const state = {
      version: 0,
      changedAt: Date.now(),
      actions: Object.create(null)
    }
    let observer = null
    const signal = () => {
      state.version += 1
      state.changedAt = Date.now()
      window.dispatchEvent(new CustomEvent('__pb2_target_page_change__'))
    }
    const start = () => {
      if (observer || !document.documentElement) return
      observer = new MutationObserver(signal)
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'aria-label', 'class', 'disabled', 'href']
      })
      signal()
    }

    window.__pb2TargetCoordinator = {
      version,
      state,
      claimAction(name, cooldownMs) {
        const now = Date.now()
        const previous = Number(state.actions[name] || 0)
        if (now - previous < cooldownMs) return false
        state.actions[name] = now
        return true
      },
      waitForChange(sinceVersion, timeoutMs) {
        if (state.version !== sinceVersion) return Promise.resolve(state.version)
        return new Promise((resolve) => {
          let timer
          const done = () => {
            clearTimeout(timer)
            window.removeEventListener('__pb2_target_page_change__', done)
            resolve(state.version)
          }
          window.addEventListener('__pb2_target_page_change__', done, { once: true })
          timer = setTimeout(done, timeoutMs)
        })
      },
      dispose() {
        observer?.disconnect()
        observer = null
      }
    }

    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  }

  install()
}

export class TargetPageCoordinator {
  constructor(page, { backupScanMs = 3000 } = {}) {
    this.page = page
    this.backupScanMs = backupScanMs
    this.actions = new Map()
  }

  static async attach(page, options) {
    const coordinator = new TargetPageCoordinator(page, options)
    await page.addInitScript?.(installCoordinatorInPage, COORDINATOR_VERSION)
    await coordinator.ensureInstalled()
    return coordinator
  }

  async ensureInstalled() {
    await this.page.evaluate(installCoordinatorInPage, COORDINATOR_VERSION).catch((error) => {
      log.debug('Target coordinator will install after navigation', { error: error.message })
    })
  }

  async snapshot() {
    return this.page
      .evaluate(() => {
        const coordinator = window.__pb2TargetCoordinator
        const visible = (element) => {
          if (!element) return false
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          )
        }
        const controls = [...document.querySelectorAll('button, a')].filter(visible)
        const normalizedText = (element) =>
          String(element?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
        const findControl = (pattern) =>
          controls.find((element) => pattern.test(normalizedText(element)))
        const addToCart =
          [
            ...document.querySelectorAll(
              'button[data-test="@web/AddToCartButton"], button[data-test="orderPickupButton"]'
            )
          ].find(visible) || findControl(/^add to cart$/i)
        const placeOrder =
          [...document.querySelectorAll('button[data-test="placeOrderButton"]')].find(visible) ||
          findControl(/^place (your )?order$/i)
        const bodyText = String(document.body?.innerText || '').toLowerCase()

        return {
          version: Number(coordinator?.state?.version || 0),
          changedAt: Number(coordinator?.state?.changedAt || Date.now()),
          url: location.href,
          addToCartVisible: Boolean(addToCart),
          addToCartReady: Boolean(
            addToCart && !addToCart.disabled && addToCart.getAttribute('aria-disabled') !== 'true'
          ),
          fulfillmentLoading: Boolean(
            document.querySelector(
              '[data-test^="fulfillment-cell"][aria-label*="loading" i], [data-test*="fulfillment"][aria-label*="loading" i]'
            ) || bodyText.includes('still loading')
          ),
          outOfStock: Boolean(
            findControl(/^(out of stock|sold out)$/i) ||
            document.querySelector('[data-test*="outOfStock" i], [data-test*="soldOut" i]')
          ),
          challenge: Boolean(
            document.querySelector(
              'iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[src*="recaptcha" i]'
            )
          ),
          viewCart: Boolean(findControl(/view cart/i)),
          placeOrderVisible: Boolean(placeOrder),
          placeOrderReady: Boolean(
            placeOrder &&
            !placeOrder.disabled &&
            placeOrder.getAttribute('aria-disabled') !== 'true'
          ),
          retryableDialog:
            /little busier than we expected|could not complete your order|high demand/.test(
              bodyText
            ),
          paymentVerification: Boolean(
            document.querySelector(
              'input[id*="cvv" i], input[name*="cvv" i], input[autocomplete="cc-number"]'
            )
          ),
          confirmed:
            /order confirmed|your order is confirmed|thank you for your order/.test(bodyText) ||
            /order-confirmation|order-details/i.test(location.pathname),
          emptyCart:
            /your cart is empty/.test(bodyText) ||
            Boolean(document.querySelector('[data-test="empty-cart"]'))
        }
      })
      .catch(() => ({ version: 0, changedAt: Date.now(), url: this.page.url?.() || '' }))
  }

  async signalState() {
    return this.page
      .evaluate(() => ({
        version: Number(window.__pb2TargetCoordinator?.state?.version || 0),
        changedAt: Number(window.__pb2TargetCoordinator?.state?.changedAt || Date.now())
      }))
      .catch(() => ({ version: 0, changedAt: Date.now() }))
  }

  async waitForChange(sinceVersion = 0, timeoutMs = this.backupScanMs) {
    const boundedTimeout = Math.max(25, Math.min(timeoutMs, this.backupScanMs))
    return this.page
      .evaluate(
        ({ version, timeout }) =>
          window.__pb2TargetCoordinator?.waitForChange(version, timeout) ??
          new Promise((resolve) => setTimeout(() => resolve(version), timeout)),
        { version: sinceVersion, timeout: boundedTimeout }
      )
      .catch(async () => {
        await this.page.waitForTimeout(boundedTimeout).catch(() => {})
        await this.ensureInstalled()
        return sinceVersion
      })
  }

  async waitForNextScan(snapshot, timeoutMs) {
    return this.waitForChange(snapshot?.version || 0, timeoutMs)
  }

  async claimAction(name, cooldownMs = 1500) {
    const now = Date.now()
    const previous = Number(this.actions.get(name) || 0)
    if (now - previous < cooldownMs) return false

    const claimedInPage = await this.page
      .evaluate(
        ({ action, cooldown }) =>
          window.__pb2TargetCoordinator?.claimAction(action, cooldown) ?? true,
        { action: name, cooldown: cooldownMs }
      )
      .catch(() => true)
    if (!claimedInPage) return false
    this.actions.set(name, now)
    return true
  }
}
