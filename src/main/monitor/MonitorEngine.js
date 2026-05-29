import { EventEmitter } from 'events'

export class MonitorEngine extends EventEmitter {
  constructor() {
    super()
    this._timers = new Map()
  }

  addTask({ id, poller, intervalMs }) {
    if (this._timers.has(id)) return
    const run = async () => {
      try {
        const event = await poller.poll()
        if (event) this.emit('drop', event)
      } catch {}
    }
    run()
    this._timers.set(id, setInterval(run, intervalMs))
  }

  removeTask(id) {
    const timer = this._timers.get(id)
    if (timer) { clearInterval(timer); this._timers.delete(id) }
  }

  stopAll() {
    for (const id of this._timers.keys()) this.removeTask(id)
  }

  getActiveTasks() {
    return [...this._timers.keys()]
  }
}
