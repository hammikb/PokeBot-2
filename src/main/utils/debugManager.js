import { EventEmitter } from 'events'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createModuleLogger } from './logger.js'

const log = createModuleLogger('DebugManager')

/**
 * Comprehensive debugging system
 * Tracks all operations, errors, and performance metrics
 */
export class DebugManager extends EventEmitter {
  constructor() {
    super()
    this.debugMode = process.env.DEBUG === 'true' || false
    this.sessions = new Map()
    this.metrics = {
      requests: [],
      errors: [],
      performance: [],
      cookies: [],
      proxies: [],
      retries: []
    }
    this.maxHistorySize = 1000
  }

  /**
   * Enable debug mode
   */
  enableDebug() {
    this.debugMode = true
    log.info('Debug mode enabled')
    this.emit('debug:enabled')
  }

  /**
   * Disable debug mode
   */
  disableDebug() {
    this.debugMode = false
    log.info('Debug mode disabled')
    this.emit('debug:disabled')
  }

  /**
   * Start a debug session
   */
  startSession(sessionId, metadata = {}) {
    const session = {
      id: sessionId,
      startTime: Date.now(),
      metadata,
      events: [],
      errors: [],
      warnings: [],
      status: 'running'
    }

    this.sessions.set(sessionId, session)

    log.debug('Debug session started', { sessionId, metadata })
    this.emit('session:start', session)

    return session
  }

  /**
   * Log event in session
   */
  logEvent(sessionId, event, data = {}) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      log.warn('Session not found', { sessionId })
      return
    }

    const eventData = {
      event,
      data,
      timestamp: Date.now(),
      elapsed: Date.now() - session.startTime
    }

    session.events.push(eventData)

    if (this.debugMode) {
      log.debug(`[${sessionId}] ${event}`, data)
    }

    this.emit('session:event', { sessionId, ...eventData })
  }

  /**
   * Log error in session
   */
  logError(sessionId, error, context = {}) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      log.warn('Session not found', { sessionId })
      return
    }

    const errorData = {
      message: error.message || String(error),
      stack: error.stack,
      context,
      timestamp: Date.now(),
      elapsed: Date.now() - session.startTime
    }

    session.errors.push(errorData)
    this.metrics.errors.push({ sessionId, ...errorData })
    this.trimMetrics('errors')

    log.error(`[${sessionId}] Error`, errorData)
    this.emit('session:error', { sessionId, ...errorData })
  }

  /**
   * Log warning in session
   */
  logWarning(sessionId, message, data = {}) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const warningData = {
      message,
      data,
      timestamp: Date.now(),
      elapsed: Date.now() - session.startTime
    }

    session.warnings.push(warningData)

    if (this.debugMode) {
      log.warn(`[${sessionId}] ${message}`, data)
    }

    this.emit('session:warning', { sessionId, ...warningData })
  }

  /**
   * End debug session
   */
  endSession(sessionId, result = {}) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.endTime = Date.now()
    session.duration = session.endTime - session.startTime
    session.status = result.success ? 'success' : 'failed'
    session.result = result

    log.info('Debug session ended', {
      sessionId,
      duration: session.duration,
      events: session.events.length,
      errors: session.errors.length,
      warnings: session.warnings.length,
      status: session.status
    })

    this.emit('session:end', session)

    // Keep session for 5 minutes
    setTimeout(() => this.sessions.delete(sessionId), 300000)
  }

  /**
   * Track HTTP request
   */
  trackRequest(sessionId, request) {
    const requestData = {
      sessionId,
      method: request.method,
      url: request.url,
      headers: this.sanitizeHeaders(request.headers),
      timestamp: Date.now()
    }

    this.metrics.requests.push(requestData)
    this.trimMetrics('requests')

    if (this.debugMode) {
      log.debug('HTTP Request', requestData)
    }

    this.emit('request:tracked', requestData)
  }

  /**
   * Track HTTP response
   */
  trackResponse(sessionId, response, duration) {
    const responseData = {
      sessionId,
      status: response.status,
      statusText: response.statusText,
      headers: this.sanitizeHeaders(response.headers),
      duration,
      timestamp: Date.now()
    }

    this.metrics.performance.push({
      type: 'http_request',
      duration,
      sessionId,
      timestamp: Date.now()
    })
    this.trimMetrics('performance')

    if (this.debugMode) {
      log.debug('HTTP Response', responseData)
    }

    this.emit('response:tracked', responseData)
  }

  /**
   * Track cookie operation
   */
  trackCookie(sessionId, operation, data) {
    const cookieData = {
      sessionId,
      operation, // 'generate', 'validate', 'rotate'
      data,
      timestamp: Date.now()
    }

    this.metrics.cookies.push(cookieData)
    this.trimMetrics('cookies')

    if (this.debugMode) {
      log.debug('Cookie operation', cookieData)
    }

    this.emit('cookie:tracked', cookieData)
  }

  /**
   * Track proxy usage
   */
  trackProxy(sessionId, proxy, status, responseTime) {
    const proxyData = {
      sessionId,
      proxy: this.maskProxy(proxy),
      status, // 'success', 'failed'
      responseTime,
      timestamp: Date.now()
    }

    this.metrics.proxies.push(proxyData)
    this.trimMetrics('proxies')

    if (this.debugMode) {
      log.debug('Proxy usage', proxyData)
    }

    this.emit('proxy:tracked', proxyData)
  }

  /**
   * Track retry attempt
   */
  trackRetry(sessionId, attempt, error, delay) {
    const retryData = {
      sessionId,
      attempt,
      error: error.message || String(error),
      errorType: error.type || 'unknown',
      delay,
      timestamp: Date.now()
    }

    this.metrics.retries.push(retryData)
    this.trimMetrics('retries')

    if (this.debugMode) {
      log.debug('Retry attempt', retryData)
    }

    this.emit('retry:tracked', retryData)
  }

  /**
   * Get session data
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null
  }

  /**
   * Get all sessions
   */
  getAllSessions() {
    return Array.from(this.sessions.values())
  }

  /**
   * Get metrics
   */
  getMetrics(type) {
    if (type) {
      return this.metrics[type] || []
    }
    return this.metrics
  }

  /**
   * Get metrics summary
   */
  getMetricsSummary() {
    return {
      requests: {
        total: this.metrics.requests.length,
        recent: this.metrics.requests.slice(-10)
      },
      errors: {
        total: this.metrics.errors.length,
        recent: this.metrics.errors.slice(-10)
      },
      performance: {
        total: this.metrics.performance.length,
        avgDuration: this.calculateAvgDuration(),
        recent: this.metrics.performance.slice(-10)
      },
      cookies: {
        total: this.metrics.cookies.length,
        recent: this.metrics.cookies.slice(-10)
      },
      proxies: {
        total: this.metrics.proxies.length,
        successRate: this.calculateProxySuccessRate(),
        recent: this.metrics.proxies.slice(-10)
      },
      retries: {
        total: this.metrics.retries.length,
        recent: this.metrics.retries.slice(-10)
      }
    }
  }

  /**
   * Export debug data to file
   */
  exportDebugData(sessionId) {
    try {
      const debugDir = join(app.getPath('userData'), 'debug')
      if (!existsSync(debugDir)) {
        mkdirSync(debugDir, { recursive: true })
      }

      const data = {
        session: this.getSession(sessionId),
        metrics: this.getMetrics(),
        timestamp: new Date().toISOString()
      }

      const filename = `debug-${sessionId}-${Date.now()}.json`
      const filepath = join(debugDir, filename)

      writeFileSync(filepath, JSON.stringify(data, null, 2))

      log.info('Debug data exported', { filepath })
      return { success: true, filepath }
    } catch (error) {
      log.error('Failed to export debug data', { error: error.message })
      return { success: false, error: error.message }
    }
  }

  /**
   * Clear metrics
   */
  clearMetrics(type) {
    if (type) {
      this.metrics[type] = []
      log.info('Metrics cleared', { type })
    } else {
      Object.keys(this.metrics).forEach((key) => {
        this.metrics[key] = []
      })
      log.info('All metrics cleared')
    }
  }

  /**
   * Clear all sessions
   */
  clearSessions() {
    this.sessions.clear()
    log.info('All sessions cleared')
  }

  // Helper methods

  sanitizeHeaders(headers) {
    const sanitized = { ...headers }
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']

    sensitiveHeaders.forEach((header) => {
      if (sanitized[header]) {
        sanitized[header] = '***REDACTED***'
      }
    })

    return sanitized
  }

  maskProxy(proxy) {
    const parts = proxy.split(':')
    if (parts.length === 4) {
      return `${parts[0]}:${parts[1]}:***:***`
    }
    return proxy
  }

  trimMetrics(type) {
    if (this.metrics[type].length > this.maxHistorySize) {
      this.metrics[type] = this.metrics[type].slice(-this.maxHistorySize)
    }
  }

  calculateAvgDuration() {
    if (this.metrics.performance.length === 0) return 0
    const total = this.metrics.performance.reduce((sum, p) => sum + p.duration, 0)
    return Math.round(total / this.metrics.performance.length)
  }

  calculateProxySuccessRate() {
    if (this.metrics.proxies.length === 0) return 0
    const successful = this.metrics.proxies.filter((p) => p.status === 'success').length
    return Math.round((successful / this.metrics.proxies.length) * 100)
  }
}

// Singleton instance
export const debugManager = new DebugManager()
