import { SUPABASE_KEY, SUPABASE_URL } from '../supabase/config.js'

export function runStartupDiagnostics({ db, safeStorage, settings = {} }) {
  const checks = []
  checks.push(
    runCheck('database', 'fatal', () => {
      db.prepare('SELECT key, value FROM settings').all()
      return 'Database and migrations are ready'
    })
  )
  checks.push(
    safeStorage?.isEncryptionAvailable?.()
      ? pass('vault', 'fatal', 'OS-protected credential storage is available')
      : fail('vault', 'fatal', 'OS-protected credential storage is unavailable')
  )
  checks.push(
    /^https:\/\/.+/.test(SUPABASE_URL) && String(SUPABASE_KEY).length > 20
      ? pass('supabase', 'degraded', 'Central monitor configuration is present')
      : fail('supabase', 'degraded', 'Central monitor configuration is incomplete')
  )
  const proxyCount = Array.isArray(settings.proxies)
    ? settings.proxies.filter((proxy) => String(proxy || '').trim()).length
    : 0
  checks.push(
    proxyCount > 0
      ? pass('proxies', 'degraded', `${proxyCount} monitor proxies configured`)
      : fail('proxies', 'degraded', 'No monitor proxies are configured')
  )
  checks.push(pass('browser', 'degraded', 'Browser runtime will be verified when a session starts'))

  return {
    checkedAt: new Date().toISOString(),
    status: checks.some((check) => !check.ok && check.severity === 'fatal')
      ? 'fatal'
      : checks.some((check) => !check.ok)
        ? 'degraded'
        : 'ready',
    checks
  }
}

function runCheck(id, severity, operation) {
  try {
    return pass(id, severity, operation())
  } catch (error) {
    return fail(id, severity, error.message)
  }
}

function pass(id, severity, message) {
  return { id, severity, ok: true, message }
}

function fail(id, severity, message) {
  return { id, severity, ok: false, message }
}
