/**
 * NativeInputBridge
 *
 * Replaces Playwright's CDP-based mouse/keyboard input with native OS-level
 * input via @nut-tree-fork/nut-js. This is exactly what Guppy does.
 *
 * WHY THIS MATTERS
 * ─────────────────
 * Playwright normally sends input via Chrome DevTools Protocol:
 *   Input.dispatchMouseEvent / Input.dispatchKeyEvent
 *
 * Akamai Bot Manager detects CDP input because:
 *   1. The timing is too precise (no jitter)
 *   2. CDP events bypass the browser's normal input pipeline
 *   3. Certain JS APIs (isTrusted, getCoalescedEvents) behave differently
 *
 * nut-js moves the REAL OS cursor and fires REAL OS keyboard events.
 * From Chrome's perspective these are indistinguishable from a human.
 *
 * LIMITATIONS
 * ───────────
 * - The browser window must be visible (even off-screen at a negative position)
 * - Only one checkout can run at a time (one physical cursor)
 * - Requires the window to be focused for keyboard input
 * - Falls back to CDP if nut-js fails to load (e.g. in tests)
 *
 * USAGE
 * ─────
 *   const bridge = await NativeInputBridge.create(page)
 *   await bridge.click(selector)
 *   await bridge.type(selector, 'hello')
 *   await bridge.press('Enter')
 */

import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('NativeInputBridge')

// Singleton nut-js instance — loaded once, shared across all bridges.
let _nut = null
let _nutLoadAttempted = false

async function loadNut() {
  if (_nutLoadAttempted) return _nut
  _nutLoadAttempted = true
  try {
    _nut = await import('@nut-tree-fork/nut-js')
    // Speed up nut-js mouse movement (default is very slow)
    _nut.mouse.config.mouseSpeed = 2000 // pixels per second
    log.info('nut-js loaded — native OS input enabled (undetectable by Akamai)')
  } catch (err) {
    log.warn(
      'nut-js failed to load — falling back to CDP Input.dispatch*Event (DETECTABLE by tier-1 antibots)',
      { reason: err.message }
    )
    _nut = null
  }
  return _nut
}

export class NativeInputBridge {
  /**
   * @param {import('playwright').Page} page
   * @param {object} [opts]
   * @param {boolean} [opts.forceNative]  Throw if nut-js unavailable (default: false)
   */
  constructor(page, opts = {}) {
    this._page = page
    this._forceNative = opts.forceNative ?? false
    this._nut = null
  }

  /**
   * Create a bridge and pre-load nut-js.
   */
  static async create(page, opts = {}) {
    const bridge = new NativeInputBridge(page, opts)
    bridge._nut = await loadNut()
    if (bridge._forceNative && !bridge._nut) {
      throw new Error('NativeInputBridge: nut-js required but failed to load')
    }
    return bridge
  }

  get isNative() {
    return !!this._nut
  }

  // ---------------------------------------------------------------------------
  // High-level helpers (use these in checkout flows)
  // ---------------------------------------------------------------------------

  /**
   * Click an element. Uses native OS cursor if nut-js is available,
   * falls back to CDP page.click() otherwise.
   */
  async click(selector, opts = {}) {
    const element = await this._page.waitForSelector(selector, { timeout: 10_000 })
    if (!element) throw new Error(`Element not found: ${selector}`)

    if (this._nut) {
      await this._nativeClick(element, opts)
    } else {
      await this._page.click(selector, opts)
    }
  }

  /**
   * Type text into an element. Clears first, then types character by character
   * with realistic timing.
   */
  async type(selector, text, opts = {}) {
    const delay = opts.delay ?? this._humanDelay()

    if (this._nut) {
      // Focus the element via CDP (just focus, not click — less detectable than
      // using CDP for the actual input)
      await this._page.focus(selector)
      await this._sleep(50)

      // Clear existing value
      await this._page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) {
          el.value = ''
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, selector)

      // Type each character via nut-js keyboard
      for (const char of text) {
        await this._nutTypeChar(char)
        await this._sleep(delay)
      }
    } else {
      await this._page.click(selector, { clickCount: 3 }) // select all
      await this._page.type(selector, text, { delay })
    }
  }

  /**
   * Press a key (e.g. 'Enter', 'Tab', 'Escape').
   */
  async press(key, opts = {}) {
    if (this._nut) {
      const nutKey = this._playwrightKeyToNut(key)
      if (nutKey != null) {
        await this._nut.keyboard.pressKey(nutKey)
        await this._sleep(opts.delay ?? 30)
        await this._nut.keyboard.releaseKey(nutKey)
      } else {
        // Unknown key — fall back to CDP for this one key
        await this._page.keyboard.press(key)
      }
    } else {
      await this._page.keyboard.press(key, opts)
    }
  }

  /**
   * Select all text in an element and replace with new value.
   * Useful for CVV/price fields.
   */
  async fill(selector, value) {
    if (this._nut) {
      await this._page.focus(selector)
      await this._sleep(30)
      // Select all via Ctrl+A then type
      await this._nut.keyboard.pressKey(this._nut.Key.LeftControl, this._nut.Key.A)
      await this._nut.keyboard.releaseKey(this._nut.Key.LeftControl, this._nut.Key.A)
      await this._sleep(30)
      for (const char of value) {
        await this._nutTypeChar(char)
        await this._sleep(this._humanDelay())
      }
    } else {
      await this._page.fill(selector, value)
    }
  }

  // ---------------------------------------------------------------------------
  // Native click implementation
  // ---------------------------------------------------------------------------
  async _nativeClick(element, opts = {}) {
    // Get the element's bounding box in page coordinates
    const box = await element.boundingBox()
    if (!box) throw new Error('Element has no bounding box (not visible?)')

    // Convert page coordinates to screen coordinates.
    // We need the browser window's position on screen.
    const windowPos = await this._getWindowScreenPosition()

    // Account for the browser chrome (address bar, tabs, etc.)
    // Playwright's viewport starts below the browser chrome.
    const chromeHeight = await this._getBrowserChromeHeight()

    const screenX = Math.round(windowPos.x + box.x + box.width / 2)
    const screenY = Math.round(windowPos.y + chromeHeight + box.y + box.height / 2)

    // Add small random offset to avoid clicking the exact center every time
    const jitterX = Math.round((Math.random() - 0.5) * 4)
    const jitterY = Math.round((Math.random() - 0.5) * 4)

    log.debug('Native click', {
      selector: opts._selector,
      screenX: screenX + jitterX,
      screenY: screenY + jitterY
    })

    // Move mouse to position with human-like curve
    await this._nut.mouse.setPosition(new this._nut.Point(screenX + jitterX, screenY + jitterY))
    await this._sleep(this._humanDelay(30, 80))

    // Click
    const button = opts.button === 'right' ? this._nut.Button.RIGHT : this._nut.Button.LEFT
    await this._nut.mouse.pressButton(button)
    await this._sleep(this._humanDelay(40, 120))
    await this._nut.mouse.releaseButton(button)
  }

  // ---------------------------------------------------------------------------
  // Window position helpers
  // ---------------------------------------------------------------------------
  async _getWindowScreenPosition() {
    // Use Electron's BrowserWindow API if available (running inside Electron)
    try {
      const pos = await this._page.evaluate(() => ({ x: window.screenX, y: window.screenY }))
      return pos
    } catch {
      return { x: 0, y: 0 }
    }
  }

  async _getBrowserChromeHeight() {
    try {
      const heights = await this._page.evaluate(() => ({
        outerHeight: window.outerHeight,
        innerHeight: window.innerHeight
      }))
      return Math.max(0, heights.outerHeight - heights.innerHeight)
    } catch {
      return 85 // typical Chrome chrome height
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard helpers
  // ---------------------------------------------------------------------------
  async _nutTypeChar(char) {
    const Key = this._nut.Key
    // Handle uppercase — hold Shift
    if (char >= 'A' && char <= 'Z') {
      const key = Key['Key' + char]
      if (key != null) {
        await this._nut.keyboard.pressKey(Key.LeftShift, key)
        await this._nut.keyboard.releaseKey(Key.LeftShift, key)
        return
      }
    }
    // Handle lowercase letters
    if (char >= 'a' && char <= 'z') {
      const key = Key['Key' + char.toUpperCase()]
      if (key != null) {
        await this._nut.keyboard.pressKey(key)
        await this._nut.keyboard.releaseKey(key)
        return
      }
    }
    // Handle digits
    if (char >= '0' && char <= '9') {
      const key = Key['Num' + char]
      if (key != null) {
        await this._nut.keyboard.pressKey(key)
        await this._nut.keyboard.releaseKey(key)
        return
      }
    }
    // Special characters and everything else — fall back to CDP insertText
    // (less detectable than CDP keydown/keyup for special chars)
    await this._page.keyboard.insertText(char)
  }

  _playwrightKeyToNut(key) {
    if (!this._nut) return null
    const Key = this._nut.Key
    const map = {
      Enter: Key.Enter,
      Tab: Key.Tab,
      Escape: Key.Escape,
      Backspace: Key.Backspace,
      Delete: Key.Delete,
      Space: Key.Space,
      ArrowUp: Key.Up,
      ArrowDown: Key.Down,
      ArrowLeft: Key.Left,
      ArrowRight: Key.Right,
      Home: Key.Home,
      End: Key.End,
      PageUp: Key.PageUp,
      PageDown: Key.PageDown,
      ShiftLeft: Key.LeftShift,
      ShiftRight: Key.RightShift,
      ControlLeft: Key.LeftControl,
      ControlRight: Key.RightControl,
      AltLeft: Key.LeftAlt,
      AltRight: Key.RightAlt
    }
    return map[key] ?? null
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  _humanDelay(min = 40, max = 120) {
    return Math.round(min + Math.random() * (max - min))
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
}
