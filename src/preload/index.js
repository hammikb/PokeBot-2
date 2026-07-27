import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '../shared/constants.js'

const invokeChannels = new Set(IPC_INVOKE_CHANNELS)
const eventChannels = new Set(IPC_EVENT_CHANNELS)

const electron = Object.freeze({
  ipcRenderer: Object.freeze({
    invoke(channel, ...args) {
      if (!invokeChannels.has(channel)) throw new Error(`IPC channel is not allowed: ${channel}`)
      return ipcRenderer.invoke(channel, ...args)
    },
    on(channel, listener) {
      if (!eventChannels.has(channel)) throw new Error(`IPC event is not allowed: ${channel}`)
      if (typeof listener !== 'function') throw new TypeError('IPC listener must be a function')
      const wrappedListener = (_event, ...args) => listener(...args)
      ipcRenderer.on(channel, wrappedListener)
      return () => ipcRenderer.removeListener(channel, wrappedListener)
    }
  }),
  process: Object.freeze({
    versions: Object.freeze({ ...process.versions })
  })
})

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electron)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electron
}
