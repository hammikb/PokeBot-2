import { useEffect } from 'react'
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'
import { useAppStore } from './store/appStore'
import Dashboard from './pages/Dashboard'
import Tasks from './pages/Tasks'
import Accounts from './pages/Accounts'
import Proxies from './pages/Proxies'
import Settings from './pages/Settings'
import { IPC } from '../../shared/constants'

export default function App() {
  const { loadTasks, loadAccounts, loadSettings, pushFeedEvent, setTaskStatus, setAccountRegistrationStatus } = useAppStore()

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    loadTasks()
    loadAccounts()
    loadSettings()
    if (ipc) {
      ipc.on(IPC.FEED_EVENT, (_event, data) => pushFeedEvent(data))
      ipc.on(IPC.TASK_STATUS, (_event, { taskId, status }) => setTaskStatus(taskId, status))
      ipc.on(IPC.ACCOUNT_STATUS, (_event, data) => {
        loadAccounts()
        if (data?.email) setAccountRegistrationStatus(data.email, { state: 'success', message: data.message })
      })
    }
    return () => {
      ipc?.removeAllListeners(IPC.FEED_EVENT)
      ipc?.removeAllListeners(IPC.TASK_STATUS)
      ipc?.removeAllListeners(IPC.ACCOUNT_STATUS)
    }
  }, [])

  return (
    <HashRouter>
      <div className="flex flex-col h-screen bg-[#0f0f0f] text-gray-100 font-mono text-sm">
        <nav className="flex items-center gap-1 px-4 py-0 bg-[#141414] border-b border-gray-800/60 shrink-0 h-10">
          <span className="text-red-500 font-bold tracking-widest uppercase text-sm mr-5 select-none">
            PB2
          </span>
          {[
            ['/', 'Dashboard'],
            ['/tasks', 'Tasks'],
            ['/accounts', 'Accounts'],
            ['/proxies', 'Proxies'],
            ['/settings', 'Settings']
          ].map(([path, label]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) =>
                `px-3 h-full flex items-center uppercase tracking-wider text-xs transition-colors border-b-2 ${
                  isActive
                    ? 'text-red-400 border-red-500'
                    : 'text-gray-500 border-transparent hover:text-gray-200 hover:border-gray-600'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
          <div className="ml-auto flex items-center gap-3 text-xs text-gray-600 select-none">
            <span className="w-2 h-2 rounded-full bg-gray-700" title="Monitor status" />
            <span>v1.0.0</span>
          </div>
        </nav>
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/proxies" element={<Proxies />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
