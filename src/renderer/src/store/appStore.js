import { create } from 'zustand'
import { IPC } from '../../../shared/constants.js'

function invoke(channel, ...args) {
  const ipc = window.electron?.ipcRenderer
  if (!ipc) throw new Error(`IPC not available (channel: ${channel}) — running outside Electron?`)
  return ipc.invoke(channel, ...args)
}

export const useAppStore = create((set, get) => ({
  tasks: [],
  accounts: [],
  settings: {},
  feedEvents: [],
  taskStatuses: {},
  accountRegistrationStatuses: {},
  proxyTestResults: {},
  proxyTestRunState: 'idle',
  proxyTestMessage: '',

  loadTasks: async () => {
    const tasks = await invoke(IPC.TASKS_GET)
    set({ tasks })
  },
  loadAccounts: async () => {
    const accounts = await invoke(IPC.ACCOUNTS_GET)
    set({ accounts })
  },
  loadSettings: async () => {
    const settings = await invoke(IPC.SETTINGS_GET)
    set({
      settings,
      proxyTestResults: settings.proxyTestResults || {}
    })
  },
  createTask: async (data) => {
    await invoke(IPC.TASKS_CREATE, data)
    get().loadTasks()
  },
  updateTask: async (id, data) => {
    await invoke(IPC.TASKS_UPDATE, id, data)
    get().loadTasks()
  },
  lookupProduct: async (productUrl) => invoke(IPC.PRODUCTS_LOOKUP, productUrl),
  downloadProxies: async (url) => invoke(IPC.PROXIES_DOWNLOAD, url),
  testProxy: async (proxy) => invoke(IPC.PROXIES_TEST, proxy),
  runProxyTest: async (proxy) => {
    const key = proxy || '__direct_connection__'
    set((state) => ({
      proxyTestResults: {
        ...state.proxyTestResults,
        [key]: {
          target: { state: 'testing' },
          walmart: { state: 'testing' }
        }
      }
    }))

    try {
      const result = await invoke(IPC.PROXIES_TEST, proxy)
      const nextResult = {
        target: toProxyStatus(result.target),
        walmart: toProxyStatus(result.walmart),
        testedAt: new Date().toISOString()
      }
      await get().saveProxyTestResult(key, nextResult)
      return nextResult
    } catch (err) {
      const failed = {
        target: { state: 'fail', label: err.message || 'Test failed' },
        walmart: { state: 'fail', label: err.message || 'Test failed' },
        testedAt: new Date().toISOString()
      }
      await get().saveProxyTestResult(key, failed)
      return failed
    }
  },
  runAllProxyTests: async (proxies) => {
    if (!Array.isArray(proxies) || proxies.length === 0) return
    set({
      proxyTestRunState: 'running',
      proxyTestMessage: `Testing ${proxies.length} proxies...`
    })

    for (const proxy of proxies) {
      await get().runProxyTest(proxy)
    }

    set({
      proxyTestRunState: 'idle',
      proxyTestMessage: 'Proxy test complete'
    })
  },
  saveProxyTestResult: async (key, result) => {
    const proxyTestResults = {
      ...get().proxyTestResults,
      [key]: result
    }
    set((state) => ({
      proxyTestResults,
      settings: {
        ...state.settings,
        proxyTestResults
      }
    }))
    await invoke(IPC.SETTINGS_SET, 'proxyTestResults', proxyTestResults)
  },
  clearProxyTestResults: async () => {
    set((state) => ({
      proxyTestResults: {},
      settings: {
        ...state.settings,
        proxyTestResults: {}
      },
      proxyTestMessage: 'Proxy test results cleared'
    }))
    await invoke(IPC.SETTINGS_SET, 'proxyTestResults', {})
  },
  startTask: async (id) => {
    await invoke(IPC.TASKS_START, id)
  },
  stopTask: async (id) => {
    await invoke(IPC.TASKS_STOP, id)
  },
  deleteTask: async (id) => {
    await invoke(IPC.TASKS_DELETE, id)
    get().loadTasks()
  },
  createAccount: async (data) => {
    await invoke(IPC.ACCOUNTS_CREATE, data)
    get().loadAccounts()
  },
  updateAccount: async (id, fields) => {
    await invoke(IPC.ACCOUNTS_UPDATE, id, fields)
    get().loadAccounts()
  },
  deleteAccount: async (id) => {
    await invoke(IPC.ACCOUNTS_DELETE, id)
    get().loadAccounts()
  },
  registerAccount: async (data) => {
    set((s) => ({
      accountRegistrationStatuses: {
        ...s.accountRegistrationStatuses,
        [data.email]: { state: 'registering', message: 'Registering...' }
      }
    }))
    try {
      const result = await invoke(IPC.ACCOUNTS_REGISTER, data)
      set((s) => ({
        accountRegistrationStatuses: {
          ...s.accountRegistrationStatuses,
          [data.email]: result.success
            ? { state: 'success', message: 'Registered — check email to verify' }
            : { state: 'error', message: result.alreadyExists ? 'Already registered' : result.error || 'Registration failed' }
        }
      }))
      if (result.success) get().loadAccounts()
      return result
    } catch (err) {
      set((s) => ({
        accountRegistrationStatuses: {
          ...s.accountRegistrationStatuses,
          [data.email]: { state: 'error', message: err.message }
        }
      }))
      return { success: false, error: err.message }
    }
  },

  setAccountStatus: async (id, status) => {
    await invoke(IPC.ACCOUNTS_SET_STATUS, id, status)
    get().loadAccounts()
  },

  setAccountRegistrationStatus: (email, data) =>
    set((s) => ({
      accountRegistrationStatuses: { ...s.accountRegistrationStatuses, [email]: data }
    })),
  saveSetting: async (key, value) => {
    await invoke(IPC.SETTINGS_SET, key, value)
    get().loadSettings()
  },
  pushFeedEvent: (event) => set((s) => ({ feedEvents: [event, ...s.feedEvents].slice(0, 200) })),
  setTaskStatus: (taskId, status) =>
    set((s) => ({ taskStatuses: { ...s.taskStatuses, [taskId]: status } }))
}))

function toProxyStatus(result) {
  if (!result) return { state: 'fail', label: 'No result' }
  if (result.ok) return { state: 'pass', label: result.status ? `${result.status}` : 'OK' }
  return {
    state: 'fail',
    label: result.status ? `${result.status}` : result.error || 'Failed'
  }
}
