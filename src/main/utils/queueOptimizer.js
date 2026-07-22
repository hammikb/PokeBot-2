import { createModuleLogger } from './logger.js'

const log = createModuleLogger('QueueOptimizer')

/**
 * Smart queue handling for Walmart-style queues
 */
export class QueueOptimizer {
  constructor(options = {}) {
    this.maxPosition = options.maxPosition || 1000
    this.maxWaitMinutes = options.maxWaitMinutes || 10
    this.updateInterval = options.updateInterval || 5000
  }

  /**
   * Handle queue with smart decisions
   */
  async handleQueue(page, options = {}) {
    const {
      maxPosition = this.maxPosition,
      maxWaitMinutes = this.maxWaitMinutes,
      onUpdate
    } = options

    try {
      // Check if we're in a queue
      const inQueue = await this.isInQueue(page)
      if (!inQueue) {
        return { action: 'continue', reason: 'Not in queue' }
      }

      // Get queue information
      const queueInfo = await this.getQueueInfo(page)
      log.info('Queue detected', queueInfo)

      // Decision logic
      if (queueInfo.position > maxPosition) {
        log.warn('Queue position too high, skipping', {
          position: queueInfo.position,
          max: maxPosition
        })
        return {
          action: 'skip',
          reason: `Queue position ${queueInfo.position} exceeds max ${maxPosition}`
        }
      }

      if (queueInfo.estimatedMinutes > maxWaitMinutes) {
        log.warn('Wait time too long, skipping', {
          minutes: queueInfo.estimatedMinutes,
          max: maxWaitMinutes
        })
        return {
          action: 'skip',
          reason: `Wait time ${queueInfo.estimatedMinutes}min exceeds max ${maxWaitMinutes}min`
        }
      }

      // Monitor queue progress
      log.info('Waiting in queue', {
        position: queueInfo.position,
        estimated: queueInfo.estimatedMinutes
      })

      while (await this.isInQueue(page)) {
        const currentInfo = await this.getQueueInfo(page)

        if (onUpdate) {
          onUpdate({
            position: currentInfo.position,
            estimatedMinutes: currentInfo.estimatedMinutes,
            progress: this.calculateProgress(queueInfo.position, currentInfo.position)
          })
        }

        log.info('Queue update', currentInfo)
        await this.sleep(this.updateInterval)
      }

      log.info('Queue completed')
      return { action: 'continue', reason: 'Queue completed successfully' }
    } catch (err) {
      log.error('Queue handling error', { error: err.message })
      return { action: 'continue', reason: 'Queue error, continuing anyway' }
    }
  }

  /**
   * Check if page is in a queue
   */
  async isInQueue(page) {
    try {
      const queueIndicators = [
        '.queue-container',
        '[data-test="queue"]',
        'text="You are in line"',
        'text="Queue"',
        'text="Waiting room"'
      ]

      for (const indicator of queueIndicators) {
        if ((await page.locator(indicator).count()) > 0) {
          return true
        }
      }

      return false
    } catch {
      return false
    }
  }

  /**
   * Get queue information from page
   */
  async getQueueInfo(page) {
    try {
      const info = await page.evaluate(() => {
        // Try to extract queue position
        const positionEl = document.querySelector('.queue-position, [data-test="queue-position"]')
        const position = positionEl ? parseInt(positionEl.textContent.replace(/\D/g, '')) : null

        // Try to extract estimated wait time
        const waitEl = document.querySelector('.estimated-wait, [data-test="estimated-wait"]')
        const waitText = waitEl ? waitEl.textContent : ''
        const waitMatch = waitText.match(/(\d+)\s*(min|minute)/i)
        const estimatedMinutes = waitMatch ? parseInt(waitMatch[1]) : null

        return {
          position: position || 999,
          estimatedMinutes: estimatedMinutes || 5,
          timestamp: Date.now()
        }
      })

      return info
    } catch (err) {
      log.warn('Could not extract queue info', { error: err.message })
      return {
        position: 999,
        estimatedMinutes: 5,
        timestamp: Date.now()
      }
    }
  }

  /**
   * Calculate progress through queue
   */
  calculateProgress(startPosition, currentPosition) {
    if (!startPosition || !currentPosition) return 0
    const progress = ((startPosition - currentPosition) / startPosition) * 100
    return Math.max(0, Math.min(100, progress))
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Default queue optimizer instance
 */
export const defaultQueueOptimizer = new QueueOptimizer()

/**
 * Convenience function for queue handling
 */
export async function handleQueue(page, options = {}) {
  return defaultQueueOptimizer.handleQueue(page, options)
}
