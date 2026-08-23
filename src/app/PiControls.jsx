'use client'

import { Gauge, Lock, Play, Plus, Power, RotateCw, ScrollText, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { DEVICE_SERVICES, ONE_SHOT_SERVICES, SERVICE_META, serviceDisplayName, serviceGroup } from '../lib/pi-services.js'

// Which units live on which Pi (a bad guess just returns an error result — harmless).
const ONE_SHOT_SERVICE_SET = new Set(ONE_SHOT_SERVICES)
const DEFAULT_SCHEDULE = {
  default_interval: 30,
  windows: [{ start: '23:30', end: '03:30', interval: 15 }]
}

const toMinutes = (value) => {
  const [hours, minutes] = String(value).split(':').map(Number)
  return hours * 60 + minutes
}

// Display-only mirror of schedule_interval() in ApiMonitor.py. The Pi is the
// authority; this just shows which window the browser thinks is live right now.
function activeInterval(schedule, now = new Date()) {
  if (!schedule) return null
  const minutes = now.getHours() * 60 + now.getMinutes()
  for (const window of schedule.windows || []) {
    const start = toMinutes(window.start)
    const end = toMinutes(window.end)
    const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
    if (inside) return window.interval
  }
  return schedule.default_interval
}
// pokebot2 still needs its control-agent update before it can serve journal excerpts.
const LOG_CAPABLE_DEVICES = new Set(['pokebot-worker'])

export function PiControls() {
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [error, setError] = useState('')
  const [commands, setCommands] = useState([])
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState(null)

  const refresh = useCallback(async (pw) => {
    const res = await fetch('/api/command', { headers: { 'x-control-password': pw }, cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
    setCommands(data.commands || [])
  }, [])

  async function unlock(event) {
    event.preventDefault()
    setError('')
    try {
      await refresh(password)
      setUnlocked(true)
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    if (!unlocked) return
    const id = setInterval(() => refresh(password).catch(() => {}), 5000)
    return () => clearInterval(id)
  }, [unlocked, password, refresh])

  async function send(device, action, service, payload = {}) {
    if (action === 'reboot' &&
        !window.confirm(`Reboot ${device}? Everything on it stops for ~1 minute.`)) {
      return
    }
    const key = `${device}:${action}:${service || ''}`
    setBusy(key)
    setError('')
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, device, action, service, payload })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      await refresh(password)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  if (!unlocked) {
    return (
      <section className="panel pi-controls-panel">
        <div className="panel-heading"><h2>Pi Controls</h2></div>
        <form className="product-form" onSubmit={unlock} style={{ gridTemplateColumns: '1fr auto' }}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Control password"
            autoComplete="off"
          />
          <button className="button" type="submit"><Lock size={16} /> Unlock</button>
          {error ? <div className="form-error">{error}</div> : null}
        </form>
      </section>
    )
  }

  const saved =
    commands.find((command) => command.action === 'target_schedule' && command.status === 'done')
      ?.payload || null
  const schedule = draft || (saved?.default_interval ? saved : DEFAULT_SCHEDULE)
  const liveInterval = activeInterval(schedule)
  const dirty = draft !== null

  function renderServiceRow(device, svc) {
    const meta = SERVICE_META[svc] || { description: 'Service managed by the Pi control agent.', group: serviceGroup(svc) }
    return (
      <div className="pi-svc" key={svc}>
        <div className="pi-svc-copy">
          <strong>{serviceDisplayName(svc)}</strong>
          <span>{meta.description}</span>
        </div>
        <span className={`badge service-group-${meta.group}`}>{meta.group}</span>
        <div className="row-actions">
          {ONE_SHOT_SERVICE_SET.has(svc) ? (
            <button className="button" type="button"
              onClick={() => send(device, 'service_start', svc)}
              disabled={busy === `${device}:service_start:${svc}`}>
              <Play size={14} /> {busy === `${device}:service_start:${svc}` ? 'Running…' : 'Run now'}
            </button>
          ) : (
            <>
              <button className="icon-button" type="button" title={`Start ${serviceDisplayName(svc)}`} aria-label={`Start ${serviceDisplayName(svc)}`}
                onClick={() => send(device, 'service_start', svc)}
                disabled={busy === `${device}:service_start:${svc}`}>
                <Play size={14} />
              </button>
              <button className="icon-button" type="button" title={`Stop ${serviceDisplayName(svc)}`} aria-label={`Stop ${serviceDisplayName(svc)}`}
                onClick={() => send(device, 'service_stop', svc)}
                disabled={busy === `${device}:service_stop:${svc}`}>
                <Square size={14} />
              </button>
              <button className="icon-button" type="button" title={`Restart ${serviceDisplayName(svc)}`} aria-label={`Restart ${serviceDisplayName(svc)}`}
                onClick={() => send(device, 'service_restart', svc)}
                disabled={busy === `${device}:service_restart:${svc}`}>
                <RotateCw size={14} />
              </button>
              {meta.supportsLogs && LOG_CAPABLE_DEVICES.has(device) ? (
                <button className="icon-button" type="button" title={`Fetch ${serviceDisplayName(svc)} logs`} aria-label={`Fetch ${serviceDisplayName(svc)} logs`}
                  onClick={() => send(device, 'service_logs', svc)}
                  disabled={busy === `${device}:service_logs:${svc}`}>
                  <ScrollText size={14} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    )
  }

  const editWindow = (index, patch) =>
    setDraft({
      ...schedule,
      windows: schedule.windows.map((w, i) => (i === index ? { ...w, ...patch } : w))
    })

  return (
    <section className="panel pi-controls-panel is-unlocked">
      <div className="panel-heading">
        <h2>Pi Controls</h2>
        <span className="badge good">Controls unlocked</span>
      </div>
      {error ? <div className="form-error" style={{ marginTop: 10 }}>{error}</div> : null}

      <div className={`fast-mode-control ${dirty ? '' : 'is-active'}`}>
        <div>
          <div className="title">
            <strong><Gauge size={15} /> Target Check Schedule</strong>
            <span className={`badge ${dirty ? 'warn' : 'good'}`}>
              {dirty ? 'unsaved' : `${liveInterval}s now`}
            </span>
          </div>
          <div className="meta">
            How often the Pi checks Target, by time of day (Pi local time). Windows are
            matched top-down; an end time before its start wraps past midnight.
          </div>

          <div className="schedule-rows">
            {schedule.windows.map((window, index) => (
              <div className="schedule-row" key={index}>
                <input
                  type="time"
                  value={window.start}
                  aria-label={`Window ${index + 1} start`}
                  onChange={(event) => editWindow(index, { start: event.target.value })}
                />
                <span>to</span>
                <input
                  type="time"
                  value={window.end}
                  aria-label={`Window ${index + 1} end`}
                  onChange={(event) => editWindow(index, { end: event.target.value })}
                />
                <span>every</span>
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={window.interval}
                  aria-label={`Window ${index + 1} interval in seconds`}
                  onChange={(event) => editWindow(index, { interval: Number(event.target.value) })}
                />
                <span>s</span>
                <button
                  className="button ghost"
                  type="button"
                  aria-label={`Remove window ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      ...schedule,
                      windows: schedule.windows.filter((_, i) => i !== index)
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            <div className="schedule-row">
              <span>All other times, every</span>
              <input
                type="number"
                min={5}
                max={3600}
                value={schedule.default_interval}
                aria-label="Default interval in seconds"
                onChange={(event) =>
                  setDraft({ ...schedule, default_interval: Number(event.target.value) })
                }
              />
              <span>s</span>
            </div>
          </div>
        </div>

        <div className="fast-mode-actions">
          <button
            className="button ghost"
            type="button"
            disabled={schedule.windows.length >= 12}
            onClick={() =>
              setDraft({
                ...schedule,
                windows: [...schedule.windows, { start: '09:00', end: '12:00', interval: 60 }]
              })
            }
          >
            <Plus size={14} /> Add window
          </button>
          <button
            className="button"
            type="button"
            disabled={!dirty || busy === 'pokebot-worker:target_schedule:'}
            onClick={async () => {
              await send('pokebot-worker', 'target_schedule', null, {
                default_interval: schedule.default_interval,
                windows: schedule.windows
              })
              setDraft(null)
            }}
          >
            <Play size={14} /> Save schedule
          </button>
          <button
            className="button ghost"
            type="button"
            disabled={!dirty}
            onClick={() => setDraft(null)}
          >
            <Square size={14} /> Discard
          </button>
        </div>
      </div>

      <div className="pi-grid">
        {Object.entries(DEVICE_SERVICES).map(([device, services]) => (
          <div className="health-card" key={device}>
            <div className="title">
              <strong>{device}</strong>
              <button
                className="badge bad"
                type="button"
                onClick={() => send(device, 'reboot', null)}
                disabled={busy === `${device}:reboot:`}
                title="Reboot this Pi"
              >
                <Power size={13} /> Reboot
              </button>
            </div>
            {['production', 'experimental', 'legacy', 'tools'].map((group) => {
              const grouped = services.filter((svc) => serviceGroup(svc) === group)
              if (!grouped.length) return null
              return (
                <div className={`pi-service-group pi-service-group-${group}`} key={group}>
                  <div className="pi-service-group-label">{group}</div>
                  {grouped.map((svc) => renderServiceRow(device, svc))}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="pi-command-heading">
        <h3>Recent commands</h3>
        <span>Latest 6</span>
      </div>
      <div className="feed scroll pi-command-feed">
        {commands.length ? commands.slice(0, 6).map((c) => (
          <div className="feed-item" key={c.id}>
            <div className="title">
              <strong>{c.device} · {c.action}{c.service ? ` · ${c.service}` : ''}</strong>
              <span className={`badge ${c.status === 'done' ? 'good' : c.status === 'error' ? 'bad' : 'warn'}`}>
                {c.status}
              </span>
            </div>
            {c.result ? (
              c.action === 'service_logs' ? (
                <pre className="console" style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: 10 }}>
                  {c.result}
                </pre>
              ) : <div className="meta">{c.result}</div>
            ) : null}
          </div>
        )) : <div className="empty">No commands sent yet.</div>}
      </div>
    </section>
  )
}
