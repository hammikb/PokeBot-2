// CloakBrowser is a browser launcher and does not expose an HTTP `request` client,
// so proxy reachability checks use the request API from `playwright-core` — the same
// engine CloakBrowser is built on (already a dependency, no patchright needed).
import { request } from 'playwright-core'

const RETAILER_TEST_URLS = {
  target: 'https://www.target.com/',
  walmart: 'https://www.walmart.com/'
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export function proxyToPlaywright(proxy) {
  const parts = String(proxy || '')
    .trim()
    .split(':')
  if (parts.length < 2) throw new Error('Proxy must include host and port')

  const [host, port, username, ...passwordParts] = parts
  if (!host || !port) throw new Error('Proxy must include host and port')

  const config = {
    server: `http://${host}:${port}`
  }

  if (username) {
    config.username = username
    config.password = passwordParts.join(':')
  }

  return config
}

export async function testProxy(proxy) {
  const contextOptions = {
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  }

  if (proxy) contextOptions.proxy = proxyToPlaywright(proxy)

  const context = await request.newContext(contextOptions)

  try {
    const [target, walmart] = await Promise.all([
      testRetailer(context, RETAILER_TEST_URLS.target),
      testRetailer(context, RETAILER_TEST_URLS.walmart)
    ])

    return {
      proxy: proxy || 'direct',
      target,
      walmart
    }
  } finally {
    await context.dispose()
  }
}

async function testRetailer(context, url) {
  try {
    const response = await context.get(url, { timeout: 20000 })
    const status = response.status()
    return {
      ok: status >= 200 && status < 400,
      status
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message || 'Request failed'
    }
  }
}
