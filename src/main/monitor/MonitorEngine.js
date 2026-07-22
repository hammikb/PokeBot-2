import { EventEmitter } from 'events'

// How long to wait between launching each browser context at startup.
// Staggering prevents all 20-30 Chrome windows from opening simultaneously,
// which would cause a CPU/RAM spike. Guppy uses ~500ms between launches.
const STARTUP_STAGGER_MS = 500

export class MonitorEngine extends EventEmitter {
  constructor() {
    super()
    this._timers = new Map() // id → intervalId
    this._startupTimers = new Map() // id → timeoutId
    this._pollers = new Map() // id → poller (for cleanup)
    this._firstChecks = new Set()
    this._inFlight = new Set()
    this._taskCount = 0 // used to stagger startup launches
  }

  addTask({ id, poller, intervalMs }) {
    if (this._timers.has(id)) return

    this._firstChecks.add(id)
    this._pollers.set(id, poller)

    // Stagger the initial poll so all browser contexts don't open at once.
    // Each task waits an extra STARTUP_STAGGER_MS * taskIndex before its
    // first poll. Subsequent polls run on the normal interval.
    const startupDelay = this._taskCount * STARTUP_STAGGER_MS
    this._taskCount++

    const run = async () => {
      if (this._inFlight.has(id)) return
      this._inFlight.add(id)
      try {
        const event = await poller.poll()
        const isFirstCheck = this._firstChecks.has(id)

        if (event) {
          if (isFirstCheck) {
            this.emit('drop', { ...event, isFirstCheck: true })
            this._firstChecks.delete(id)
          } else {
            this.emit('drop', event)
          }
        } else if (isFirstCheck) {
          this._firstChecks.delete(id)
        }
      } catch {
        // Poll failures should not stop future monitor ticks.
      } finally {
        this._inFlight.delete(id)
      }
    }

    // Delay the first run, then start the regular interval after it completes.
    const startupTimer = setTimeout(() => {
      this._startupTimers.delete(id)
      if (!this._pollers.has(id)) return
      run()
      this._timers.set(id, setInterval(run, intervalMs))
    }, startupDelay)
    this._startupTimers.set(id, startupTimer)

    // Store a placeholder so removeTask works even before the timeout fires.
    if (!this._timers.has(id)) {
      this._timers.set(id, null)
    }
  }

  removeTask(id) {
    const startupTimer = this._startupTimers.get(id)
    if (startupTimer != null) clearTimeout(startupTimer)
    this._startupTimers.delete(id)

    const timer = this._timers.get(id)
    if (timer != null) {
      clearInterval(timer)
    }
    this._timers.delete(id)

    this._firstChecks.delete(id)
    this._inFlight.delete(id)

    // Call destroy() on the poller if it has one (e.g. TargetPoller closes
    // its persistent browser context).
    const poller = this._pollers.get(id)
    if (poller?.destroy) {
      poller.destroy().catch(() => {})
    }
    this._pollers.delete(id)
  }

  stopAll() {
    for (const id of [...this._timers.keys()]) this.removeTask(id)
  }

  getActiveTasks() {
    return [...this._timers.keys()]
  }
}
