import { EventEmitter } from 'events'
import { createModuleLogger } from '../utils/logger.js'
import { testProxy } from './ProxyTest.js'

const log = createModuleLogger('ProxyHealthMonitor')

/**
 * Proxy health monitoring system
 * Automatically checks proxy health and disables bad proxies
 */
export class ProxyHealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super()
    this.checkInterval = options.checkInterval || 60000 // 1 minute
    this.failureThreshold = options.failureThreshold || 3
    this.successThreshold = options.successThreshold || 2
    this.proxyStats = new Map()
    this.monitoringInterval = null
    this.isMonitoring = false
  }

  /**
   * Start monitoring proxies
   */
  startMonitoring(proxies = []) {
    if (this.isMonitoring) {
      log.warn('Monitoring already started')
      return
    }

    this.isMonitoring = true
    this.updateProxyList(proxies)

    log.info('Starting proxy health monitoring', {
      proxies: proxies.length,
      interval: this.checkInterval
    })

    // Initial check
    this.checkAllProxies()

    // Schedule periodic checks
    this.monitoringInterval = setInterval(() => {
      this.checkAllProxies()
    }, this.checkInterval)

    this.emit('monitoring:started', { proxies: proxies.length })
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (!this.isMonitoring) return

    this.isMonitoring = false
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = null
    }

    log.info('Stopped proxy health monitoring')
    this.emit('monitoring:stopped')
  }

  /**
   * Update proxy list
   */
  updateProxyList(proxies) {
    // Initialize stats for new proxies
    for (const proxy of proxies) {
      if (!this.proxyStats.has(proxy)) {
        this.proxyStats.set(proxy, {
          proxy,
          totalChecks: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          lastCheck: null,
          lastSuccess: null,
          lastFailure: null,
          status: 'unknown', // unknown, healthy, degraded, unhealthy, disabled
          avgResponseTime: null,
          responseTimes: []
        })
      }
    }

    // Remove stats for proxies no longer in list
    const proxySet = new Set(proxies)
    for (const [proxy] of this.proxyStats) {
      if (!proxySet.has(proxy)) {
        this.proxyStats.delete(proxy)
      }
    }
  }

  /**
   * Check all proxies
   */
  async checkAllProxies() {
    const proxies = Array.from(this.proxyStats.keys())
    
    if (proxies.length === 0) {
      log.debug('No proxies to check')
      return
    }

    log.info('Checking proxy health', { count: proxies.length })

    const results = await Promise.allSettled(
      proxies.map(proxy => this.checkProxy(proxy))
    )

    const summary = {
      total: proxies.length,
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      disabled: 0
    }

    for (const stats of this.proxyStats.values()) {
      summary[stats.status]++
    }

    log.info('Proxy health check complete', summary)
    this.emit('check:complete', summary)
  }

  /**
   * Check single proxy health
   */
  async checkProxy(proxy) {
    const stats = this.proxyStats.get(proxy)
    if (!stats) return

    const startTime = Date.now()
    
    try {
      const result = await testProxy(proxy)
      const responseTime = Date.now() - startTime

      stats.totalChecks++
      stats.lastCheck = Date.now()

      if (result.success) {
        stats.successCount++
        stats.consecutiveSuccesses++
        stats.consecutiveFailures = 0
        stats.lastSuccess = Date.now()
        
        // Track response time
        stats.responseTimes.push(responseTime)
        if (stats.responseTimes.length > 10) {
          stats.responseTimes.shift() // Keep last 10
        }
        stats.avgResponseTime = Math.round(
          stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length
        )

        // Update status
        if (stats.consecutiveSuccesses >= this.successThreshold) {
          this.updateProxyStatus(proxy, 'healthy')
        }

        log.debug('Proxy check succeeded', {
          proxy: this.maskProxy(proxy),
          responseTime,
          avgResponseTime: stats.avgResponseTime
        })
      } else {
        this.handleProxyFailure(proxy, result.error)
      }
    } catch (error) {
      this.handleProxyFailure(proxy, error.message)
    }

    return stats
  }

  /**
   * Handle proxy failure
   */
  handleProxyFailure(proxy, error) {
    const stats = this.proxyStats.get(proxy)
    if (!stats) return

    stats.totalChecks++
    stats.failureCount++
    stats.consecutiveFailures++
    stats.consecutiveSuccesses = 0
    stats.lastCheck = Date.now()
    stats.lastFailure = Date.now()

    log.warn('Proxy check failed', {
      proxy: this.maskProxy(proxy),
      consecutiveFailures: stats.consecutiveFailures,
      error
    })

    // Update status based on failures
    if (stats.consecutiveFailures >= this.failureThreshold) {
      this.updateProxyStatus(proxy, 'unhealthy')
      
      // Auto-disable after threshold
      this.disableProxy(proxy, `${stats.consecutiveFailures} consecutive failures`)
    } else if (stats.consecutiveFailures >= Math.floor(this.failureThreshold / 2)) {
      this.updateProxyStatus(proxy, 'degraded')
    }
  }

  /**
   * Update proxy status
   */
  updateProxyStatus(proxy, newStatus) {
    const stats = this.proxyStats.get(proxy)
    if (!stats) return

    const oldStatus = stats.status
    if (oldStatus === newStatus) return

    stats.status = newStatus

    log.info('Proxy status changed', {
      proxy: this.maskProxy(proxy),
      oldStatus,
      newStatus,
      successRate: this.getSuccessRate(proxy)
    })

    this.emit('status:changed', {
      proxy,
      oldStatus,
      newStatus,
      stats: this.getProxyStats(proxy)
    })
  }

  /**
   * Disable proxy
   */
  disableProxy(proxy, reason) {
    const stats = this.proxyStats.get(proxy)
    if (!stats) return

    if (stats.status === 'disabled') return

    stats.status = 'disabled'

    log.error('Proxy disabled', {
      proxy: this.maskProxy(proxy),
      reason,
      stats: {
        totalChecks: stats.totalChecks,
        successRate: this.getSuccessRate(proxy),
        consecutiveFailures: stats.consecutiveFailures
      }
    })

    this.emit('proxy:disabled', {
      proxy,
      reason,
      stats: this.getProxyStats(proxy)
    })
  }

  /**
   * Re-enable proxy
   */
  enableProxy(proxy) {
    const stats = this.proxyStats.get(proxy)
    if (!stats) return

    stats.status = 'unknown'
    stats.consecutiveFailures = 0
    stats.consecutiveSuccesses = 0

    log.info('Proxy re-enabled', { proxy: this.maskProxy(proxy) })
    
    this.emit('proxy:enabled', { proxy })
    
    // Check immediately
    this.checkProxy(proxy)
  }

  /**
   * Get proxy statistics
   */
  getProxyStats(proxy) {
    const stats = this.proxyStats.get(proxy)
    if (!stats) return null

    return {
      proxy,
      status: stats.status,
      totalChecks: stats.totalChecks,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      successRate: this.getSuccessRate(proxy),
      consecutiveFailures: stats.consecutiveFailures,
      consecutiveSuccesses: stats.consecutiveSuccesses,
      avgResponseTime: stats.avgResponseTime,
      lastCheck: stats.lastCheck,
      lastSuccess: stats.lastSuccess,
      lastFailure: stats.lastFailure
    }
  }

  /**
   * Get all proxy statistics
   */
  getAllStats() {
    return Array.from(this.proxyStats.keys()).map(proxy => 
      this.getProxyStats(proxy)
    )
  }

  /**
   * Get healthy proxies
   */
  getHealthyProxies() {
    return Array.from(this.proxyStats.entries())
      .filter(([, stats]) => stats.status === 'healthy')
      .map(([proxy]) => proxy)
  }

  /**
   * Get unhealthy proxies
   */
  getUnhealthyProxies() {
    return Array.from(this.proxyStats.entries())
      .filter(([, stats]) => stats.status === 'unhealthy' || stats.status === 'disabled')
      .map(([proxy]) => proxy)
  }

  /**
   * Get success rate for proxy
   */
  getSuccessRate(proxy) {
    const stats = this.proxyStats.get(proxy)
    if (!stats || stats.totalChecks === 0) return 0

    return Math.round((stats.successCount / stats.totalChecks) * 100)
  }

  /**
   * Mask proxy for logging (hide credentials)
   */
  maskProxy(proxy) {
    const parts = proxy.split(':')
    if (parts.length === 4) {
      // Format: host:port:user:pass
      return `${parts[0]}:${parts[1]}:***:***`
    }
    return proxy
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      checkInterval: this.checkInterval,
      totalProxies: this.proxyStats.size,
      healthy: this.getHealthyProxies().length,
      unhealthy: this.getUnhealthyProxies().length
    }
  }
}

// Singleton instance
export const proxyHealthMonitor = new ProxyHealthMonitor()
