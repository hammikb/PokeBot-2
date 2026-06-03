import { join } from 'path'
import { appendFileSync, mkdirSync, existsSync } from 'fs'

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
}

class Logger {
  constructor() {
    this.level = LOG_LEVELS.INFO
    this.logDir = null
    this.enableConsole = true
    this.enableFile = false
  }

  setLevel(level) {
    this.level = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO
  }

  setLogDir(dir) {
    this.logDir = dir
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.enableFile = true
  }

  _format(level, module, message, data) {
    const timestamp = new Date().toISOString()
    const dataStr = data ? ` ${JSON.stringify(data)}` : ''
    return `[${timestamp}] [${level}] [${module}] ${message}${dataStr}`
  }

  _write(level, module, message, data) {
    const formatted = this._format(level, module, message, data)
    
    if (this.enableConsole) {
      const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'
      console[consoleMethod](formatted)
    }

    if (this.enableFile && this.logDir) {
      try {
        const logFile = join(this.logDir, `pokebot-${new Date().toISOString().split('T')[0]}.log`)
        appendFileSync(logFile, formatted + '\n')
      } catch (err) {
        console.error('Failed to write to log file:', err.message)
      }
    }
  }

  error(module, message, data) {
    if (this.level >= LOG_LEVELS.ERROR) {
      this._write('ERROR', module, message, data)
    }
  }

  warn(module, message, data) {
    if (this.level >= LOG_LEVELS.WARN) {
      this._write('WARN', module, message, data)
    }
  }

  info(module, message, data) {
    if (this.level >= LOG_LEVELS.INFO) {
      this._write('INFO', module, message, data)
    }
  }

  debug(module, message, data) {
    if (this.level >= LOG_LEVELS.DEBUG) {
      this._write('DEBUG', module, message, data)
    }
  }
}

// Singleton instance
export const logger = new Logger()

// Helper to create module-specific loggers
export function createModuleLogger(moduleName) {
  return {
    error: (message, data) => logger.error(moduleName, message, data),
    warn: (message, data) => logger.warn(moduleName, message, data),
    info: (message, data) => logger.info(moduleName, message, data),
    debug: (message, data) => logger.debug(moduleName, message, data)
  }
}
