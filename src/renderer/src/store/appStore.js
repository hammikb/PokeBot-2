import { create } from 'zustand'
import { IPC } from '../../../shared/constants.js'

function invoke(channel, ...args) {
  const ipc = window.electron?.ipcRenderer
  if (!ipc) throw new Error(`IPC not available (channel: ${channel}) — running outside Electron?`)
  return ipc.invoke(channel, ...args).catch((err) => {
    if (/No handler registered/.test(err.message || '')) {
      throw new Error(
        `Electron main process has not loaded ${channel} yet. Fully stop the app and restart npm run dev.`
      )
    }
    throw err
  })
}

export const useAppStore = create((set, get) => ({
  tasks: [],
  monitors: [],
  accounts: [],
  paymentMethods: [],
  shippingAddresses: [],
  catalogItems: [],
  catalogMessage: '',
  supabaseCatalog: [],
  walmartMatches: {},
  walmartCandidates: {},
  settings: {},
  feedEvents: [],
  taskStatuses: {},
  queueJobs: {},
  taskReadiness: {},
  accountRegistrationStatuses: {},
  proxyTestResults: {},
  proxyTestRunState: 'idle',
  proxyTestMessage: '',
  authStatus: 'checking', // 'checking' | 'authenticated' | 'unauthenticated'
  authUser: null,
  authError: '',

  loadTasks: async () => {
    const tasks = await invoke(IPC.TASKS_GET)
    set((state) => ({
      tasks,
      taskStatuses: {
        ...state.taskStatuses,
        ...Object.fromEntries(tasks.map((task) => [task.id, task.status || 'idle']))
      }
    }))
    get().loadTaskReadiness()
  },
  loadTaskReadiness: async () => {
    const taskReadiness = await invoke(IPC.TASKS_READINESS)
    set({ taskReadiness })
  },
  loadMonitors: async () => {
    const monitors = await invoke(IPC.MONITORS_LIST)
    set({ monitors })
    return monitors
  },
  saveMonitor: async (monitor) => {
    const saved = await invoke(IPC.MONITORS_SAVE, monitor)
    await Promise.all([get().loadMonitors(), get().loadTasks()])
    return saved
  },
  deleteMonitor: async (id) => {
    await invoke(IPC.MONITORS_DELETE, id)
    await Promise.all([get().loadMonitors(), get().loadTasks()])
  },
  loadAccounts: async () => {
    const accounts = await invoke(IPC.ACCOUNTS_GET)
    set({ accounts })
  },
  assignAccountProxies: async () => {
    const result = await invoke(IPC.ACCOUNTS_ASSIGN_PROXIES)
    await get().loadAccounts()
    return result
  },
  loadCatalog: async () => {
    try {
      const catalogItems = await invoke(IPC.CATALOG_GET)
      set({ catalogItems, catalogMessage: '' })
    } catch (err) {
      set({ catalogItems: [], catalogMessage: err.message })
    }
  },
  loadSettings: async () => {
    const settings = await invoke(IPC.SETTINGS_GET)
    set({
      settings,
      proxyTestResults: settings.proxyTestResults || {}
    })
  },
  createTask: async (data) => {
    const id = await invoke(IPC.TASKS_CREATE, data)
    await get().loadTasks()
    return id
  },
  updateTask: async (id, data) => {
    await invoke(IPC.TASKS_UPDATE, id, data)
    get().loadTasks()
  },
  addCatalogUrl: async (productUrl) => {
    const item = await invoke(IPC.CATALOG_ADD_URL, productUrl)
    await get().loadCatalog()
    return item
  },
  deleteCatalogItem: async (id) => {
    await invoke(IPC.CATALOG_DELETE, id)
    get().loadCatalog()
  },
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
  testTask: async (id) => invoke(IPC.TASKS_TEST, id),
  saveTaskTestResult: async (id, result) => {
    const taskTestResults = {
      ...(get().settings.taskTestResults || {}),
      [id]: {
        success: result.success === true,
        testedAt: new Date().toISOString(),
        error: result.success
          ? ''
          : result.results?.find((entry) => entry.error)?.error || 'Test failed'
      }
    }
    set((state) => ({
      settings: {
        ...state.settings,
        taskTestResults
      }
    }))
    await invoke(IPC.SETTINGS_SET, 'taskTestResults', taskTestResults)
    await get().loadTaskReadiness()
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
            : {
                state: 'error',
                message: result.alreadyExists
                  ? 'Already registered'
                  : result.error || 'Registration failed'
              }
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
  openAccountSession: async (id) => invoke(IPC.ACCOUNTS_OPEN_SESSION, id),
  prepareAccountSession: async (id) => invoke(IPC.ACCOUNTS_WARMUP, id),
  inspectAccountCookies: async (id) => invoke(IPC.ACCOUNTS_COOKIE_HEALTH, id),
  checkAccountSession: async (id) => {
    const result = await invoke(IPC.ACCOUNTS_CHECK_SESSION, id)
    await get().loadAccounts()
    return result
  },
  autoLoginTargetAccount: async (id) => {
    const result = await invoke(IPC.ACCOUNTS_AUTO_LOGIN, id)
    await get().loadAccounts()
    return result
  },

  setAccountRegistrationStatus: (email, data) =>
    set((s) => ({
      accountRegistrationStatuses: { ...s.accountRegistrationStatuses, [email]: data }
    })),
  saveSetting: async (key, value) => {
    const result = await invoke(IPC.SETTINGS_SET, key, value)
    await get().loadSettings()
    return result
  },
  setMonitorMode: async (mode) => {
    await invoke(IPC.MONITOR_SET_MODE, mode)
    await get().loadSettings()
  },
  checkAuthStatus: async () => {
    try {
      const status = await invoke(IPC.AUTH_GET_STATUS)
      set({
        authStatus: status.authenticated ? 'authenticated' : 'unauthenticated',
        authUser: status.user ?? null
      })
    } catch (err) {
      set({ authStatus: 'unauthenticated', authError: err.message })
    }
  },
  signIn: async (email, password, rememberMe = true) => {
    set({ authError: '' })
    try {
      const status = await invoke(IPC.AUTH_SIGN_IN, { email, password, rememberMe })
      set({ authStatus: 'authenticated', authUser: status.user ?? null })
    } catch (err) {
      set({ authError: err.message })
      throw err
    }
  },
  signUp: async (email, password, rememberMe = true) => {
    set({ authError: '' })
    try {
      const status = await invoke(IPC.AUTH_SIGN_UP, { email, password, rememberMe })
      set({ authStatus: 'authenticated', authUser: status.user ?? null })
    } catch (err) {
      set({ authError: err.message })
      throw err
    }
  },
  signOut: async () => {
    await invoke(IPC.AUTH_SIGN_OUT)
    set({ authStatus: 'unauthenticated', authUser: null })
  },
  setAuthState: (state) => {
    set({
      authStatus: state.authenticated ? 'authenticated' : 'unauthenticated',
      authUser: state.user ?? null
    })
  },
  clearAuthError: () => set({ authError: '' }),
  loadSupabaseCatalog: async () => {
    const supabaseCatalog = await invoke(IPC.SUPABASE_CATALOG_LIST)
    set({ supabaseCatalog })
  },
  loadWalmartMatches: async () => {
    const rows = await invoke(IPC.CATALOG_LIST_WALMART_MATCHES)
    set({ walmartMatches: Object.fromEntries(rows.map((row) => [row.target_product_key, row])) })
  },
  findWalmartMatch: async (productKey, upc, name) => {
    const candidates = await invoke(IPC.CATALOG_FIND_WALMART_MATCH, { upc, name })
    set((s) => ({ walmartCandidates: { ...s.walmartCandidates, [productKey]: candidates } }))
  },
  bulkFindWalmartMatches: async (items) => {
    const rows = await invoke(IPC.CATALOG_BULK_FIND_WALMART_MATCHES, items)
    await get().loadWalmartMatches()
    const candidates = Object.fromEntries(
      rows
        .filter((row) => !row.saved && row.candidates?.length)
        .map((row) => [row.productKey, row.candidates])
    )
    set({ walmartCandidates: candidates })
    return rows
  },
  dismissWalmartCandidates: (productKey) =>
    set((s) => {
      const next = { ...s.walmartCandidates }
      delete next[productKey]
      return { walmartCandidates: next }
    }),
  confirmWalmartMatch: async (productKey, candidate) => {
    await invoke(IPC.CATALOG_SAVE_WALMART_MATCH, { productKey, candidate })
    get().dismissWalmartCandidates(productKey)
    await get().loadWalmartMatches()
  },
  skipWalmartMatch: async (productKey, reason) => {
    await invoke(IPC.CATALOG_SKIP_WALMART_MATCH, { productKey, reason })
  },
  pushFeedEvent: (event) => set((s) => ({ feedEvents: [event, ...s.feedEvents].slice(0, 200) })),
  setTaskStatus: (taskId, status) =>
    set((s) => ({ taskStatuses: { ...s.taskStatuses, [taskId]: status } })),

  // Walmart queue auto-join
  joinQueue: (id, productUrl, label) => invoke(IPC.QUEUE_JOIN, { id, productUrl, label }),
  stopQueue: (id) => invoke(IPC.QUEUE_STOP, id),
  pushQueueProgress: (p) =>
    set((s) => {
      if (p.phase === 'stopped') {
        const next = { ...s.queueJobs }
        delete next[p.id]
        return { queueJobs: next }
      }
      return { queueJobs: { ...s.queueJobs, [p.id]: { ...s.queueJobs[p.id], ...p } } }
    }),

  // Payment Methods
  loadPaymentMethods: async () => {
    const paymentMethods = await invoke(IPC.PAYMENTS_GET)
    set({ paymentMethods })
  },
  createPaymentMethod: async (data) => {
    await invoke(IPC.PAYMENTS_CREATE, data)
    get().loadPaymentMethods()
  },
  updatePaymentMethod: async (id, fields) => {
    await invoke(IPC.PAYMENTS_UPDATE, id, fields)
    get().loadPaymentMethods()
  },
  deletePaymentMethod: async (id) => {
    await invoke(IPC.PAYMENTS_DELETE, id)
    get().loadPaymentMethods()
  },

  // Shipping Addresses
  loadShippingAddresses: async () => {
    const shippingAddresses = await invoke(IPC.SHIPPING_GET)
    set({ shippingAddresses })
  },
  createShippingAddress: async (data) => {
    await invoke(IPC.SHIPPING_CREATE, data)
    get().loadShippingAddresses()
  },
  updateShippingAddress: async (id, fields) => {
    await invoke(IPC.SHIPPING_UPDATE, id, fields)
    get().loadShippingAddresses()
  },
  deleteShippingAddress: async (id) => {
    await invoke(IPC.SHIPPING_DELETE, id)
    get().loadShippingAddresses()
  },
  setDefaultShippingAddress: async (id) => {
    await invoke(IPC.SHIPPING_SET_DEFAULT, id)
    get().loadShippingAddresses()
  }
}))

function toProxyStatus(result) {
  if (!result) return { state: 'fail', label: 'No result' }
  if (result.ok) return { state: 'pass', label: result.status ? `${result.status}` : 'OK' }
  return {
    state: 'fail',
    label: result.status ? `${result.status}` : result.error || 'Failed'
  }
}
