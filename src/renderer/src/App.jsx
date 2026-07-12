import { useEffect } from 'react'
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'
import { useAppStore } from './store/appStore'
import Dashboard from './pages/Dashboard'
import Tasks from './pages/Tasks'
import Accounts from './pages/Accounts'
import Proxies from './pages/Proxies'
import Catalog from './pages/Catalog'
import Settings from './pages/Settings'
import PaymentMethods from './pages/PaymentMethods'
import ShippingAddresses from './pages/ShippingAddresses'
import Login from './pages/Login'
import { IPC } from '../../shared/constants'

export default function App() {
  const {
    authStatus,
    checkAuthStatus,
    setAuthState,
    loadTasks,
    loadAccounts,
    loadCatalog,
    loadSettings,
    pushFeedEvent,
    setTaskStatus,
    pushQueueProgress,
    setAccountRegistrationStatus
  } = useAppStore()

  // Auth check + live auth-state updates run regardless of current status.
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    checkAuthStatus()
    if (ipc) {
      ipc.on(IPC.AUTH_STATE_CHANGED, (_event, state) => setAuthState(state))
    }
    return () => {
      ipc?.removeAllListeners(IPC.AUTH_STATE_CHANGED)
    }
  }, [checkAuthStatus, setAuthState])

  // App data + live feed only load once actually signed in.
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    const ipc = window.electron?.ipcRenderer
    loadTasks()
    loadAccounts()
    loadCatalog()
    loadSettings()
    if (ipc) {
      ipc.on(IPC.FEED_EVENT, (_event, data) => pushFeedEvent(data))
      ipc.on(IPC.TASK_STATUS, (_event, { taskId, status }) => setTaskStatus(taskId, status))
      ipc.on(IPC.QUEUE_PROGRESS, (_event, data) => pushQueueProgress(data))
      ipc.on(IPC.ACCOUNT_STATUS, (_event, data) => {
        loadAccounts()
        if (data?.email)
          setAccountRegistrationStatus(data.email, { state: 'success', message: data.message })
      })
    }
    return () => {
      ipc?.removeAllListeners(IPC.FEED_EVENT)
      ipc?.removeAllListeners(IPC.TASK_STATUS)
      ipc?.removeAllListeners(IPC.QUEUE_PROGRESS)
      ipc?.removeAllListeners(IPC.ACCOUNT_STATUS)
    }
  }, [
    authStatus,
    loadTasks,
    loadAccounts,
    loadCatalog,
    loadSettings,
    pushFeedEvent,
    setTaskStatus,
    pushQueueProgress,
    setAccountRegistrationStatus
  ])

  if (authStatus === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-gray-500 font-mono text-sm uppercase tracking-widest">
        Loading...
      </div>
    )
  }

  if (authStatus !== 'authenticated') {
    return <Login />
  }

  return (
    <HashRouter>
      <div className="flex flex-col h-screen bg-[#0f0f0f] text-gray-100 font-mono text-base">
        <nav className="flex items-center gap-1 px-4 py-0 bg-[#141414] border-b border-gray-800/60 shrink-0 h-12">
          <span className="text-red-500 font-bold tracking-widest uppercase text-base mr-5 select-none">
            PB2
          </span>
          {[
            ['/', 'Dashboard'],
            ['/tasks', 'Tasks'],
            ['/catalog', 'Catalog'],
            ['/accounts', 'Accounts'],
            ['/payments', 'Payments'],
            ['/shipping', 'Shipping'],
            ['/proxies', 'Proxies'],
            ['/settings', 'Settings']
          ].map(([path, label]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) =>
                `px-3 h-full flex items-center uppercase tracking-wider text-sm transition-colors border-b-2 ${
                  isActive
                    ? 'text-red-400 border-red-500'
                    : 'text-gray-500 border-transparent hover:text-gray-200 hover:border-gray-600'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
          <div className="ml-auto flex items-center gap-3 text-sm text-gray-600 select-none">
            <span className="w-2 h-2 rounded-full bg-gray-700" title="Monitor status" />
            <span>v1.0.0</span>
          </div>
        </nav>
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/catalog" element={<Catalog />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/payments" element={<PaymentMethods />} />
            <Route path="/shipping" element={<ShippingAddresses />} />
            <Route path="/proxies" element={<Proxies />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
