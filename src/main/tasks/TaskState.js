export const TASK_STATE = Object.freeze({
  IDLE: 'idle',
  MONITORING: 'monitoring'
})

export function persistTaskState(db, taskId, state) {
  if (!taskId) return false
  if (!Object.values(TASK_STATE).includes(state)) {
    throw new Error(`Unsupported persisted task state: ${state}`)
  }
  return db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(state, taskId).changes > 0
}

export function listTasksToResume(db) {
  const enabledSources = db.prepare('SELECT * FROM monitor_sources WHERE enabled = ?').all(1)
  return [...new Set(enabledSources.map((source) => source.task_id).filter(Boolean))]
    .map((taskId) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId))
    .filter((task) => task?.status === TASK_STATE.MONITORING)
}
