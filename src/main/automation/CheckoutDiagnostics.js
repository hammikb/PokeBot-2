import { app } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

const MAX_NETWORK_EVENTS = 50

export async function startCheckoutDiagnostics(
  page,
  { retailer = 'retailer', accountName = 'account', taskId = 'checkout', tracePath = null } = {}
) {
  const networkEvents = []
  const record = (event) => {
    networkEvents.push({ at: new Date().toISOString(), ...event })
    if (networkEvents.length > MAX_NETWORK_EVENTS) networkEvents.shift()
  }
  const onResponse = (response) => {
    if (response.status() >= 400) {
      record({
        type: 'response',
        status: response.status(),
        method: response.request().method(),
        url: safeUrl(response.url())
      })
    }
  }
  const onRequestFailed = (request) => {
    record({
      type: 'request-failed',
      method: request.method(),
      url: safeUrl(request.url()),
      error: request.failure()?.errorText || 'request failed'
    })
  }
  page.on?.('response', onResponse)
  page.on?.('requestfailed', onRequestFailed)

  const diagnosticsPath = tracePath
    ? tracePath.replace(/\.zip$/i, '.diagnostics.json')
    : await makeDiagnosticsPath({ retailer, accountName, taskId })

  return {
    diagnosticsPath,
    async capture(error, { failedSelector = null, stage = null } = {}) {
      const pageState = await captureSafePageState(page).catch((captureError) => ({
        captureError: captureError.message
      }))
      const report = {
        capturedAt: new Date().toISOString(),
        retailer,
        accountName,
        taskId,
        stage,
        error: serializeError(error),
        failedSelector,
        page: pageState,
        network: networkEvents
      }
      await mkdir(dirname(diagnosticsPath), { recursive: true })
      await writeFile(diagnosticsPath, JSON.stringify(report, null, 2), 'utf8')
      return diagnosticsPath
    },
    dispose() {
      page.off?.('response', onResponse)
      page.off?.('requestfailed', onRequestFailed)
    }
  }
}

async function captureSafePageState(page) {
  const state = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const cleanText = (value, limit = 300) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit)
    const safeHtml = (element) => {
      const clone = element.cloneNode(true)
      for (const input of clone.querySelectorAll('input, textarea')) {
        input.removeAttribute('value')
        input.textContent = ''
      }
      for (const node of clone.querySelectorAll('[data-token], [data-auth], [data-session]')) {
        node.removeAttribute('data-token')
        node.removeAttribute('data-auth')
        node.removeAttribute('data-session')
      }
      return cleanText(clone.outerHTML, 1200)
    }

    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .filter(isVisible)
      .slice(0, 80)
      .map((element) => ({
        text: cleanText(element.innerText || element.getAttribute('value'), 160),
        ariaLabel: cleanText(element.getAttribute('aria-label'), 160),
        id: element.id || null,
        testId: element.getAttribute('data-testid') || null,
        automationId: element.getAttribute('data-automation-id') || null,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        html: safeHtml(element)
      }))
    const fields = [...document.querySelectorAll('input, select, textarea')]
      .filter(isVisible)
      .slice(0, 80)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || null,
        name: element.getAttribute('name') || null,
        id: element.id || null,
        autocomplete: element.getAttribute('autocomplete') || null,
        placeholder: cleanText(element.getAttribute('placeholder'), 160),
        ariaLabel: cleanText(element.getAttribute('aria-label'), 160),
        disabled: Boolean(element.disabled),
        html: safeHtml(element)
      }))
    const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"], [aria-live]')]
      .filter(isVisible)
      .slice(0, 20)
      .map((element) => cleanText(element.innerText, 500))
      .filter(Boolean)

    return { title: document.title, buttons, fields, notices }
  })
  return { url: safeUrl(page.url()), ...state }
}

async function makeDiagnosticsPath({ retailer, accountName, taskId }) {
  const base = typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = [stamp, retailer, accountName, taskId].map(safeSegment).join('-')
  return join(base, 'debug-traces', `${name}.diagnostics.json`)
}

export function safeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return `${url.origin}${url.pathname}`
  } catch {
    return String(value || '').split(/[?#]/)[0]
  }
}

function serializeError(error) {
  if (!error) return null
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: String(error.stack || '')
      .split('\n')
      .slice(0, 12)
      .join('\n')
  }
}

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .slice(0, 80)
}
