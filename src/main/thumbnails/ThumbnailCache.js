import { app } from 'electron'
import { join } from 'path'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('ThumbnailCache')

/**
 * ThumbnailCache - Downloads and caches product images locally
 * Similar to Guppy's agent-thumbnails system
 */
export class ThumbnailCache {
  constructor() {
    this.cacheDir = join(app.getPath('userData'), 'thumbnails')
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
      log.info('Created thumbnail cache directory', { cacheDir: this.cacheDir })
    }
  }

  /**
   * Download and cache a thumbnail from a URL
   * @param {string} imageUrl - URL of the image to download
   * @returns {Promise<string|null>} - Local file path or null if failed
   */
  async downloadThumbnail(imageUrl) {
    if (!imageUrl) return null

    try {
      // Create hash of URL for filename
      const hash = createHash('md5').update(imageUrl).digest('hex')
      const ext = this.getExtension(imageUrl)
      const filename = `${hash}.${ext}`
      const filepath = join(this.cacheDir, filename)

      // Return if already cached
      if (existsSync(filepath)) {
        log.debug('Thumbnail already cached', { imageUrl, filepath })
        return filepath
      }

      log.info('Downloading thumbnail', { imageUrl })

      // Download image
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      // Save to file
      const fileStream = createWriteStream(filepath)
      await pipeline(response.body, fileStream)

      log.info('Thumbnail downloaded successfully', { imageUrl, filepath })
      return filepath
    } catch (err) {
      log.error('Failed to download thumbnail', { imageUrl, error: err.message })
      return null
    }
  }

  /**
   * Get cached thumbnail path if it exists
   * @param {string} imageUrl - URL of the image
   * @returns {string|null} - Local file path or null if not cached
   */
  getThumbnailPath(imageUrl) {
    if (!imageUrl) return null

    const hash = createHash('md5').update(imageUrl).digest('hex')
    const ext = this.getExtension(imageUrl)
    const filename = `${hash}.${ext}`
    const filepath = join(this.cacheDir, filename)

    return existsSync(filepath) ? filepath : null
  }

  /**
   * Get file extension from URL
   * @param {string} url - Image URL
   * @returns {string} - File extension (jpg, png, etc.)
   */
  getExtension(url) {
    try {
      const pathname = new URL(url).pathname
      const ext = pathname.split('.').pop().split('?')[0].toLowerCase()
      // Validate extension
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        return ext
      }
      return 'jpg' // Default
    } catch {
      return 'jpg'
    }
  }

  /**
   * Get cache directory path
   * @returns {string} - Cache directory path
   */
  getCacheDir() {
    return this.cacheDir
  }

  /**
   * Clear all cached thumbnails
   * @returns {Promise<void>}
   */
  async clearCache() {
    try {
      const { readdir, unlink } = await import('fs/promises')
      const files = await readdir(this.cacheDir)
      await Promise.all(files.map((file) => unlink(join(this.cacheDir, file))))
      log.info('Thumbnail cache cleared', { count: files.length })
    } catch (err) {
      log.error('Failed to clear thumbnail cache', { error: err.message })
    }
  }
}
