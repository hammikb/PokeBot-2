import { EventEmitter } from 'events'

export class MonitorEngine extends EventEmitter {
  constructor() {
    super()
    this._timers = new Map()
    this._firstChecks = new Set() // Track which tasks have had their first check
  }

  addTask({ id, poller, intervalMs }) {
    if (this._timers.has(id)) return
    
    // Mark this as needing first check
    this._firstChecks.add(id)
    
    const run = async () => {
      try {
        const event = await poller.poll()
        const isFirstCheck = this._firstChecks.has(id)
        
        if (event) {
          // Always emit on first check (even if already in stock)
          // After first check, only emit on actual restocks
          if (isFirstCheck) {
            this.emit('drop', { ...event, isFirstCheck: true })
            this._firstChecks.delete(id) // Mark first check as done
          } else {
            this.emit('drop', event)
          }
        } else if (isFirstCheck) {
          // First check but not in stock - mark as done anyway
          this._firstChecks.delete(id)
        }
      } catch {
        // Poll failures should not stop future monitor ticks.
      }
    }
    run()
    this._timers.set(id, setInterval(run, intervalMs))
  }

  removeTask(id) {
    const timer = this._timers.get(id)
    if (timer) {
      clearInterval(timer)
      this._timers.delete(id)
    }
  }

  stopAll() {
    for (const id of [...this._timers.keys()]) this.removeTask(id)
  }

  getActiveTasks() {
    return [...this._timers.keys()]
  }
}
