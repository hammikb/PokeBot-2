import { SmartRetry } from './smartRetry.js'
import { createModuleLogger } from './logger.js'

const log = createModuleLogger('RetryManager')

// Smart retry instance for advanced retry logic
const smartRetry = new SmartRetry()

/**
 * Smart retry manager with exponential backoff
 */
export class RetryManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.initialDelay = options.initialDelay || 1000
    this.maxDelay = options.maxDelay || 10000
    this.backoffMultiplier = options.backoffMultiplier || 2
  }

  /**
   * Retry a function with exponential backoff
   */
  async retry(fn, options = {}) {
    const {
      maxRetries = this.maxRetries,
      initialDelay = this.initialDelay,
      maxDelay = this.maxDelay,
      backoffMultiplier = this.backoffMultiplier,
      onRetry,
      shouldRetry = () => true
    } = options

    let lastError

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.info('Attempting operation', { attempt, maxRetries })
        return await fn(attempt)
      } catch (err) {
        lastError = err

        // Check if we should retry this error
        if (!shouldRetry(err)) {
          log.warn('Error not retryable', { error: err.message })
          throw err
        }

        // If this was the last attempt, throw
        if (attempt === maxRetries) {
          log.error('Max retries reached', { attempts: maxRetries, error: err.message })
          throw err
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt - 1), maxDelay)

        log.warn('Operation failed, retrying', {
          attempt,
          maxRetries,
          delay,
          error: err.message
        })

        // Call retry callback if provided
        if (onRetry) {
          onRetry({
            attempt,
            maxRetries,
            delay,
            error: err.message
          })
        }

        // Wait before retrying
        await sleep(delay)
      }
    }

    throw lastError
  }

  /**
   * Retry with custom retry conditions
   */
  async retryOnCondition(fn, condition, options = {}) {
    return this.retry(fn, {
      ...options,
      shouldRetry: (err) => condition(err)
    })
  }

  /**
   * Retry only on network errors
   */
  async retryOnNetworkError(fn, options = {}) {
    return this.retry(fn, {
      ...options,
      shouldRetry: (err) => isNetworkError(err)
    })
  }

  /**
   * Retry only on timeout errors
   */
  async retryOnTimeout(fn, options = {}) {
    return this.retry(fn, {
      ...options,
      shouldRetry: (err) => isTimeoutError(err)
    })
  }

  /**
   * Use smart retry with failure analysis
   * Returns detailed analysis of failures
   */
  async smartRetry(fn, options = {}) {
    const result = await smartRetry.execute(fn, {
      maxRetries: options.maxRetries || this.maxRetries,
      baseDelay: options.initialDelay || this.initialDelay,
      maxDelay: options.maxDelay || this.maxDelay
    })

    if (!result.success) {
      const error = new Error(result.error)
      error.retryAnalysis = result.analysis
      error.failures = result.failures
      throw error
    }

    return result.result
  }
}

/**
 * Check if error is a network error
 */
function isNetworkError(err) {
  const networkErrors = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    'ERR_NETWORK',
    'ERR_INTERNET_DISCONNECTED'
  ]

  return networkErrors.some(
    (code) =>
      err.code === code ||
      err.message?.includes(code) ||
      err.message?.includes('network') ||
      err.message?.includes('connection')
  )
}

/**
 * Check if error is a timeout error
 */
function isTimeoutError(err) {
  return (
    err.code === 'ETIMEDOUT' ||
    err.message?.includes('timeout') ||
    err.message?.includes('timed out')
  )
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Default retry manager instance
 */
export const defaultRetryManager = new RetryManager()

/**
 * Convenience function for quick retries
 */
export async function withRetry(fn, options = {}) {
  return defaultRetryManager.retry(fn, options)
}
