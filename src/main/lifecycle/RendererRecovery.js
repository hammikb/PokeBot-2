export function attachRendererRecovery({
  window,
  isShuttingDown = () => false,
  onRecovery = () => {},
  onUnresponsive = () => {},
  reloadDelayMs = 1000,
  unresponsiveDelayMs = 5000
}) {
  let recoveryTimer = null
  let disposed = false
  const webContents = window.webContents

  const cancelRecovery = () => {
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimer = null
  }

  const scheduleRecovery = (reason, delayMs) => {
    if (recoveryTimer || isShuttingDown()) return
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      if (isShuttingDown() || window.isDestroyed?.() || webContents.isDestroyed?.()) return
      onRecovery(reason)
      webContents.reload()
    }, delayMs)
    recoveryTimer.unref?.()
  }

  const onRenderProcessGone = (_event, details = {}) => {
    if (details.reason === 'clean-exit') return
    scheduleRecovery(`renderer-${details.reason || 'gone'}`, reloadDelayMs)
  }
  const onWindowUnresponsive = () => {
    onUnresponsive()
    scheduleRecovery('renderer-unresponsive', unresponsiveDelayMs)
  }
  const onWindowResponsive = () => cancelRecovery()
  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelRecovery()
    if (!webContents.isDestroyed?.()) {
      webContents.off?.('render-process-gone', onRenderProcessGone)
    }
    if (!window.isDestroyed?.()) {
      window.off?.('unresponsive', onWindowUnresponsive)
      window.off?.('responsive', onWindowResponsive)
      window.off?.('closed', dispose)
    }
  }

  webContents.on('render-process-gone', onRenderProcessGone)
  window.on('unresponsive', onWindowUnresponsive)
  window.on('responsive', onWindowResponsive)
  window.on('closed', dispose)

  return { dispose }
}
