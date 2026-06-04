import { EventEmitter } from 'events'
import { createModuleLogger } from './logger.js'

const log = createModuleLogger('ProgressStreamer')

/**
 * Live progress streaming for tasks
 * Inspired by CartPilot - provides real-time updates to UI
 */
export class ProgressStreamer extends EventEmitter {
  constructor() {
    super()
    this.activeStreams = new Map()
  }

  /**
   * Start a new progress stream for a task
   */
  startStream(taskId, metadata = {}) {
    const stream = {
      taskId,
      startTime: Date.now(),
      steps: [],
      currentStep: null,
      metadata,
      status: 'running'
    }

    this.activeStreams.set(taskId, stream)
    this.emit('stream:start', { taskId, metadata, timestamp: Date.now() })
    
    log.info('Started progress stream', { taskId })
    return stream
  }

  /**
   * Update progress with a new step
   */
  step(taskId, action, details = {}) {
    const stream = this.activeStreams.get(taskId)
    if (!stream) {
      log.warn('No active stream for task', { taskId })
      return
    }

    const step = {
      action,
      details,
      timestamp: Date.now(),
      duration: stream.currentStep ? Date.now() - stream.currentStep.timestamp : 0
    }

    stream.steps.push(step)
    stream.currentStep = step

    this.emit('stream:step', {
      taskId,
      step,
      totalSteps: stream.steps.length,
      elapsedTime: Date.now() - stream.startTime
    })

    log.debug('Progress step', { taskId, action, details })
  }

  /**
   * Update current step with additional details
   */
  updateStep(taskId, details) {
    const stream = this.activeStreams.get(taskId)
    if (!stream || !stream.currentStep) return

    Object.assign(stream.currentStep.details, details)
    
    this.emit('stream:update', {
      taskId,
      step: stream.currentStep,
      details
    })
  }

  /**
   * Mark stream as successful
   */
  success(taskId, result = {}) {
    const stream = this.activeStreams.get(taskId)
    if (!stream) return

    stream.status = 'success'
    stream.endTime = Date.now()
    stream.duration = stream.endTime - stream.startTime
    stream.result = result

    this.emit('stream:success', {
      taskId,
      duration: stream.duration,
      steps: stream.steps.length,
      result
    })

    log.info('Stream completed successfully', { taskId, duration: stream.duration })
    
    // Keep stream for 5 minutes for review
    setTimeout(() => this.activeStreams.delete(taskId), 300000)
  }

  /**
   * Mark stream as failed
   */
  error(taskId, error) {
    const stream = this.activeStreams.get(taskId)
    if (!stream) return

    stream.status = 'error'
    stream.endTime = Date.now()
    stream.duration = stream.endTime - stream.startTime
    stream.error = {
      message: error.message || String(error),
      stack: error.stack,
      timestamp: Date.now()
    }

    this.emit('stream:error', {
      taskId,
      duration: stream.duration,
      error: stream.error
    })

    log.error('Stream failed', { taskId, error: error.message })
    
    // Keep stream for 5 minutes for review
    setTimeout(() => this.activeStreams.delete(taskId), 300000)
  }

  /**
   * Get current stream state
   */
  getStream(taskId) {
    return this.activeStreams.get(taskId)
  }

  /**
   * Get all active streams
   */
  getAllStreams() {
    return Array.from(this.activeStreams.values())
  }

  /**
   * Create a step callback function for legacy code
   */
  createStepCallback(taskId) {
    return (message, details = {}) => {
      this.step(taskId, message, details)
    }
  }

  /**
   * Estimate progress percentage (0-100)
   */
  estimateProgress(taskId, totalExpectedSteps = 10) {
    const stream = this.activeStreams.get(taskId)
    if (!stream) return 0

    const progress = Math.min(100, (stream.steps.length / totalExpectedSteps) * 100)
    return Math.round(progress)
  }

  /**
   * Get formatted duration
   */
  getFormattedDuration(taskId) {
    const stream = this.activeStreams.get(taskId)
    if (!stream) return '0s'

    const duration = (stream.endTime || Date.now()) - stream.startTime
    const seconds = Math.floor(duration / 1000)
    const minutes = Math.floor(seconds / 60)

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    }
    return `${seconds}s`
  }
}

// Singleton instance
export const progressStreamer = new ProgressStreamer()
