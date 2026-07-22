import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { JsonDb } from '../../../src/main/db.js'
import {
  listTasksToResume,
  persistTaskState,
  TASK_STATE
} from '../../../src/main/tasks/TaskState.js'

let db
let dbPath

beforeEach(() => {
  dbPath = join(tmpdir(), `pokebot-task-state-${Date.now()}-${Math.random()}.json`)
  db = new JsonDb(dbPath)
  db.prepare(
    'INSERT INTO tasks (id, retailer, product_url, mode, account_ids, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('task-1', 'samsclub', 'https://www.samsclub.com/ip/12345678', 'auto-checkout', '[]', 'idle')
  db.prepare(
    'INSERT INTO monitor_sources (id, monitor_id, retailer, enabled, task_id) VALUES (?, ?, ?, ?, ?)'
  ).run('source-1', 'monitor-1', 'samsclub', 1, 'task-1')
})

afterEach(() => {
  db.close()
  if (existsSync(dbPath)) rmSync(dbPath)
})

describe('persisted task runtime state', () => {
  it('resumes an enabled source only after its task was explicitly started', () => {
    expect(listTasksToResume(db)).toEqual([])

    expect(persistTaskState(db, 'task-1', TASK_STATE.MONITORING)).toBe(true)
    expect(listTasksToResume(db).map((task) => task.id)).toEqual(['task-1'])
  })

  it('keeps an explicitly stopped task stopped after reopening the database', () => {
    persistTaskState(db, 'task-1', TASK_STATE.MONITORING)
    persistTaskState(db, 'task-1', TASK_STATE.IDLE)
    db.close()
    db = new JsonDb(dbPath)

    expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1').status).toBe('idle')
    expect(listTasksToResume(db)).toEqual([])
  })
})
