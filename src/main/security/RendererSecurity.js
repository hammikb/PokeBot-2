export function configureRendererSecurity({
  window,
  trustedRendererUrl,
  openExternal,
  onExternalOpenError = () => {}
}) {
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isTrustedRendererUrl(navigationUrl, trustedRendererUrl)) return

    event.preventDefault()
    openExternalUrl(navigationUrl, openExternal, onExternalOpenError)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, openExternal, onExternalOpenError)
    return { action: 'deny' }
  })

  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

export function isTrustedRendererUrl(candidateUrl, trustedRendererUrl) {
  try {
    const candidate = new URL(candidateUrl)
    const trusted = new URL(trustedRendererUrl)

    if (trusted.protocol === 'file:') {
      return (
        candidate.protocol === 'file:' &&
        candidate.pathname === trusted.pathname &&
        candidate.search === trusted.search
      )
    }

    return candidate.origin === trusted.origin
  } catch {
    return false
  }
}

export function isSafeExternalUrl(candidateUrl) {
  try {
    return ['http:', 'https:'].includes(new URL(candidateUrl).protocol)
  } catch {
    return false
  }
}

function openExternalUrl(url, openExternal, onError) {
  if (!isSafeExternalUrl(url) || typeof openExternal !== 'function') return
  Promise.resolve(openExternal(url)).catch((error) => onError(error, url))
}
