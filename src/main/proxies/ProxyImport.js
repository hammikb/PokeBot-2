import axios from 'axios'

export async function downloadProxies(url) {
  const { data } = await axios.get(url, {
    responseType: 'text',
    timeout: 30000
  })
  const proxies = parseProxyList(String(data || ''))
  return { proxies, count: proxies.length }
}

export function parseProxyList(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => parseProxyLine(line.trim()))
        .filter(Boolean)
    )
  ]
}

function parseProxyLine(line) {
  if (!line || line.startsWith('#')) return null

  const urlProxy = parseUrlProxy(line)
  if (urlProxy) return urlProxy

  const parts = line.split(':')
  if (parts.length === 4) {
    const [host, port, username, password] = parts
    return normalizeProxy({ host, port, username, password })
  }
  if (parts.length === 2) {
    const [host, port] = parts
    return normalizeProxy({ host, port })
  }
  return null
}

function parseUrlProxy(line) {
  try {
    const withProtocol = line.includes('://') ? line : `http://${line}`
    const url = new URL(withProtocol)
    if (!url.hostname || !url.port) return null
    return normalizeProxy({
      host: url.hostname,
      port: url.port,
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || '')
    })
  } catch {
    return null
  }
}

function normalizeProxy({ host, port, username = '', password = '' }) {
  if (!host || !port) return null
  if (username && password) return `${host}:${port}:${username}:${password}`
  return `${host}:${port}`
}
