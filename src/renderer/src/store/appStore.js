import { create } from 'zustand'
import { IPC } from '../../../shared/constants.js'

const ipc = window.electron?.ipcRenderer

export const useAppStore = create((set, get) => ({
  tasks: [],
  accounts: [],
  settings: {},
  feedEvents: [],
  taskStatuses: {},

  loadTasks: async () => {
    const tasks = await ipc.invoke(IPC.TASKS_GET)
    set({ tasks })
  },
  loadAccounts: async () => {
    const accounts = await ipc.invoke(IPC.ACCOUNTS_GET)
    set({ accounts })
  },
  loadSettings: async () => {
    const settings = await ipc.invoke(IPC.SETTINGS_GET)
    set({ settings })
  },
  createTask: async (data) => {
    await ipc.invoke(IPC.TASKS_CREATE, data)
    get().loadTasks()
  },
  startTask: async (id) => {
    await ipc.invoke(IPC.TASKS_START, id)
  },
  stopTask: async (id) => {
    await ipc.invoke(IPC.TASKS_STOP, id)
  },
  deleteTask: async (id) => {
    await ipc.invoke(IPC.TASKS_DELETE, id)
    get().loadTasks()
  },
  createAccount: async (data) => {
    await ipc.invoke(IPC.ACCOUNTS_CREATE, data)
    get().loadAccounts()
  },
  updateAccount: async (id, fields) => {
    await ipc.invoke(IPC.ACCOUNTS_UPDATE, id, fields)
    get().loadAccounts()
  },
  deleteAccount: async (id) => {
    await ipc.invoke(IPC.ACCOUNTS_DELETE, id)
    get().loadAccounts()
  },
  saveSetting: async (key, value) => {
    await ipc.invoke(IPC.SETTINGS_SET, key, value)
    get().loadSettings()
  },
  pushFeedEvent: (event) => set(s => ({ feedEvents: [event, ...s.feedEvents].slice(0, 200) })),
  setTaskStatus: (taskId, status) => set(s => ({ taskStatuses: { ...s.taskStatuses, [taskId]: status } }))
}))
