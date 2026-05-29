import { useEffect } from 'react'
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'
import { useAppStore } from './store/appStore'
import Dashboard from './pages/Dashboard'
import Tasks from './pages/Tasks'
import Accounts from './pages/Accounts'
import Settings from './pages/Settings'
import { IPC } from '../../shared/constants'

const ipc = window.electron?.ipcRenderer

export default function App() {
  const { loadTasks, loadAccounts, loadSettings, pushFeedEvent, setTaskStatus } = useAppStore()

  useEffect(() => {
    loadTasks()
    loadAccounts()
    loadSettings()
    if (ipc) {
      ipc.on(IPC.FEED_EVENT, (_event, data) => pushFeedEvent(data))
      ipc.on(IPC.TASK_STATUS, (_event, { taskId, status }) => setTaskStatus(taskId, status))
    }
    return () => {
      ipc?.removeAllListeners(IPC.FEED_EVENT)
      ipc?.removeAllListeners(IPC.TASK_STATUS)
    }
  }, [])

  return (
    <HashRouter>
      <div className="flex flex-col h-screen bg-[#0f0f0f] text-gray-100 font-mono text-sm">
        <nav className="flex items-center gap-6 px-6 py-3 bg-[#1a1a1a] border-b border-gray-800 shrink-0">
          <span className="text-red-500 font-bold tracking-widest mr-4 uppercase">PokeBot 2</span>
          {[['/', 'Dashboard'], ['/tasks', 'Tasks'], ['/accounts', 'Accounts'], ['/settings', 'Settings']].map(([path, label]) => (
            <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) =>
              `uppercase tracking-wider text-xs ${isActive ? 'text-red-400' : 'text-gray-400 hover:text-white'}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/unlock" element={<UnlockPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}

function UnlockPage() {
  const ipc = window.electron?.ipcRenderer
  const handleSubmit = (e) => {
    e.preventDefault()
    const password = e.target.password.value
    ipc?.invoke(IPC.UNLOCK, password)
  }
  return (
    <div className="flex items-center justify-center h-full bg-[#0f0f0f]">
      <form onSubmit={handleSubmit} className="bg-[#1a1a1a] border border-gray-800 rounded p-8 space-y-4 w-80">
        <div className="text-red-500 font-bold tracking-widest uppercase text-center mb-2">PokeBot 2</div>
        <div className="text-gray-400 text-xs text-center">Enter your vault password</div>
        <input
          name="password"
          type="password"
          autoFocus
          className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200 text-xs outline-none focus:border-red-500"
          placeholder="Password"
        />
        <button type="submit" className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold text-xs">
          Unlock
        </button>
      </form>
    </div>
  )
}
