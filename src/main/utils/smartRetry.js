import { createModuleLogger } from './logger.js'

const log = createModuleLogger('SmartRetry')

/**
 * Smart retry system with failure pattern analysis
 * Inspired by professional bot best practices
 */
export class SmartRetry {
  constructor(options = {}) {
    this.defaultOptions = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      exponentialBackoff: true,
      jitter: true,
      ...options
    }
  }

  /**
   * Execute operation with smart retry logic
   */
  async execute(operation, options = {}) {
    const config = { ...this.defaultOptions, ...options }
    const failures = []
    const startTime = Date.now()

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        log.debug('Attempting operation', { attempt, maxRetries: config.maxRetries })
        
        const result = await operation(attempt)
        
        if (failures.length > 0) {
          log.info('Operation succeeded after retries', {
            attempt,
            totalFailures: failures.length,
            duration: Date.now() - startTime
          })
        }
        
        return { success: true, result, attempts: attempt, failures }
      } catch (error) {
        const failureInfo = {
          attempt,
          error: error.message,
          type: this.classifyError(error),
          timestamp: Date.now(),
          stack: error.stack
        }
        
        failures.push(failureInfo)
        
        log.warn('Operation failed', failureInfo)

        // Last attempt - don't retry
        if (attempt === config.maxRetries) {
          log.error('All retry attempts exhausted', {
            totalAttempts: attempt,
            failures: failures.length,
            duration: Date.now() - startTime
          })
          
          return {
            success: false,
            error: error.message,
            attempts: attempt,
            failures,
            analysis: this.analyzeFailures(failures)
          }
        }

        // Determine retry strategy based on error type
        const delay = await this.calculateDelay(failureInfo, attempt, config, failures)
        
        log.info('Retrying after delay', { 
          attempt, 
          nextAttempt: attempt + 1,
          delay,
          errorType: failureInfo.type
        })
        
        await this.sleep(delay)
      }
    }
  }

  /**
   * Classify error type for smart handling
   */
  classifyError(error) {
    const message = error.message?.toLowerCase() || ''
    const status = error.status || error.statusCode

    // Network errors
    if (message.includes('timeout') || message.includes('timed out')) {
      return 'TIMEOUT'
    }
    if (message.includes('network') || message.includes('econnrefused')) {
      return 'NETWORK'
    }

    // HTTP status codes
    if (status === 429 || message.includes('rate limit')) {
      return 'RATE_LIMIT'
    }
    if (status === 403 || message.includes('forbidden')) {
      return 'FORBIDDEN'
    }
    if (status === 401 || message.includes('unauthorized')) {
      return 'UNAUTHORIZED'
    }
    if (status === 412 || status === 418) {
      return 'BOT_DETECTION'
    }
    if (status >= 500) {
      return 'SERVER_ERROR'
    }

    // Bot detection
    if (message.includes('captcha') || message.includes('challenge')) {
      return 'CAPTCHA'
    }
    if (message.includes('blocked') || message.includes('banned')) {
      return 'BLOCKED'
    }
    if (message.includes('session') || message.includes('expired')) {
      return 'SESSION_EXPIRED'
    }

    // Product availability
    if (message.includes('out of stock') || message.includes('not available')) {
      return 'OUT_OF_STOCK'
    }
    if (message.includes('queue') || message.includes('waiting')) {
      return 'QUEUE'
    }

    return 'UNKNOWN'
  }

  /**
   * Calculate delay based on error type and attempt
   */
  async calculateDelay(failureInfo, attempt, config, failures) {
    const { type } = failureInfo
    let delay = config.baseDelay

    // Error-specific delays
    switch (type) {
      case 'RATE_LIMIT':
        // Longer delay for rate limits
        delay = Math.min(config.baseDelay * Math.pow(2, attempt + 2), config.maxDelay)
        break

      case 'BOT_DETECTION':
      case 'CAPTCHA':
      case 'BLOCKED':
        // Very long delay for bot detection
        delay = Math.min(config.baseDelay * Math.pow(3, attempt), config.maxDelay)
        break

      case 'SERVER_ERROR':
        // Medium delay for server errors
        delay = Math.min(config.baseDelay * Math.pow(2, attempt), config.maxDelay)
        break

      case 'TIMEOUT':
      case 'NETWORK':
        // Short delay for network issues
        delay = Math.min(config.baseDelay * attempt, config.maxDelay / 2)
        break

      case 'SESSION_EXPIRED':
        // Short delay to refresh session
        delay = config.baseDelay
        break

      case 'OUT_OF_STOCK':
      case 'QUEUE':
        // Don't retry immediately for stock issues
        delay = Math.min(config.baseDelay * 5, config.maxDelay)
        break

      default:
        // Exponential backoff for unknown errors
        if (config.exponentialBackoff) {
          delay = Math.min(config.baseDelay * Math.pow(2, attempt - 1), config.maxDelay)
        } else {
          delay = config.baseDelay
        }
    }

    // Add jitter to prevent thundering herd
    if (config.jitter) {
      const jitterAmount = delay * 0.3 // 30% jitter
      delay = delay + (Math.random() * jitterAmount - jitterAmount / 2)
    }

    return Math.round(delay)
  }

  /**
   * Analyze failure patterns
   */
  analyzeFailures(failures) {
    if (failures.length === 0) return null

    const types = failures.map(f => f.type)
    const uniqueTypes = [...new Set(types)]
    
    // Count occurrences
    const typeCounts = types.reduce((acc, type) => {
      acc[type] = (acc[type] || 0) + 1
      return acc
    }, {})

    // Determine primary failure reason
    const primaryType = Object.entries(typeCounts)
      .sort(([, a], [, b]) => b - a)[0][0]

    // Check for patterns
    const isConsistent = uniqueTypes.length === 1
    const isEscalating = this.isEscalatingPattern(failures)
    
    return {
      totalFailures: failures.length,
      uniqueTypes: uniqueTypes.length,
      typeCounts,
      primaryType,
      isConsistent,
      isEscalating,
      recommendation: this.getRecommendation(primaryType, isConsistent, failures.length)
    }
  }

  /**
   * Check if failures are escalating in severity
   */
  isEscalatingPattern(failures) {
    if (failures.length < 2) return false

    const severity = {
      'TIMEOUT': 1,
      'NETWORK': 1,
      'SERVER_ERROR': 2,
      'RATE_LIMIT': 3,
      'FORBIDDEN': 4,
      'BOT_DETECTION': 5,
      'CAPTCHA': 5,
      'BLOCKED': 6
    }

    for (let i = 1; i < failures.length; i++) {
      const prevSeverity = severity[failures[i - 1].type] || 0
      const currSeverity = severity[failures[i].type] || 0
      if (currSeverity > prevSeverity) {
        return true
      }
    }

    return false
  }

  /**
   * Get recommendation based on failure analysis
   */
  getRecommendation(primaryType, isConsistent, failureCount) {
    switch (primaryType) {
      case 'RATE_LIMIT':
        return 'Reduce request frequency or use different proxy'
      
      case 'BOT_DETECTION':
      case 'CAPTCHA':
        return 'Use profile warmup or switch to browser automation'
      
      case 'BLOCKED':
        return 'Change proxy or wait before retrying'
      
      case 'SESSION_EXPIRED':
        return 'Refresh session cookies'
      
      case 'TIMEOUT':
      case 'NETWORK':
        return 'Check network connection or proxy health'
      
      case 'SERVER_ERROR':
        return 'Wait for server to recover'
      
      case 'OUT_OF_STOCK':
        return 'Monitor for restock'
      
      default:
        if (isConsistent && failureCount > 2) {
          return 'Persistent issue - manual intervention may be needed'
        }
        return 'Retry with exponential backoff'
    }
  }

  /**
   * Sleep for specified duration
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Create a retry wrapper for a function
   */
  wrap(fn, options = {}) {
    return async (...args) => {
      return await this.execute(() => fn(...args), options)
    }
  }
}

// Export singleton instance
export const smartRetry = new SmartRetry()

/**
 * Convenience function for one-off retries
 */
export async function retry(operation, options = {}) {
  return await smartRetry.execute(operation, options)
}
