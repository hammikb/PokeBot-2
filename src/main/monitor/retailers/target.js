import { exec } from 'child_process'
import { promisify } from 'util'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'

const execAsync = promisify(exec)

export class TargetPoller {
  constructor({ productUrl, maxPrice = Infinity }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.tcin = productUrl.match(/A-(\d+)/)?.[1]
    if (!this.tcin) throw new Error(`Cannot extract TCIN from URL: ${productUrl}`)
    this._wasInStock = false
    this._isFirstPoll = true
  }

  async poll() {
    try {
      console.log(`[TargetPoller] Polling TCIN ${this.tcin}, isFirstPoll: ${this._isFirstPoll}`)
      
      // Use Scrapling to bypass bot detection
      // Try python3 first, fallback to python
      let stdout, stderr
      try {
        const result = await execAsync(
          `python3 scripts/scrapling_lookup.py "${this.productUrl}"`,
          { timeout: 30000, shell: true }
        )
        stdout = result.stdout
        stderr = result.stderr
      } catch {
        // Fallback to python command
        const result = await execAsync(
          `python scripts/scrapling_lookup.py "${this.productUrl}"`,
          { timeout: 30000, shell: true }
        )
        stdout = result.stdout
        stderr = result.stderr
      }
      
      if (stderr) {
        try {
          const errorData = JSON.parse(stderr)
          console.error(`[TargetPoller] Scrapling error:`, errorData)
        } catch {
          console.error(`[TargetPoller] Scrapling stderr:`, stderr)
        }
        return null
      }
      
      // Filter out INFO logs, only parse the JSON line
      const jsonLine = stdout.split('\n').find(line => line.trim().startsWith('{'))
      if (!jsonLine) {
        console.error(`[TargetPoller] No JSON found in output:`, stdout)
        return null
      }
      
      const result = JSON.parse(jsonLine)
      if (!result.ok) {
        console.error(`[TargetPoller] Scrapling failed:`, result.error)
        return null
      }
      
      const product = result.product
      const status = product.availability
      const price = product.price
      const name = product.productName
      
      console.log(`[TargetPoller] Status: ${status}, Price: ${price}, Name: ${name}`)

      if (status !== 'IN_STOCK') {
        this._wasInStock = false
        this._isFirstPoll = false
        return null
      }
      if (price == null) {
        this._wasInStock = false
        this._isFirstPoll = false
        return null
      }
      if (price > this.maxPrice) {
        this._wasInStock = false
        this._isFirstPoll = false
        return null
      }
      
      // Allow event on first poll even if already in stock
      // After first poll, only emit on state changes (restock)
      if (this._wasInStock && !this._isFirstPoll) {
        return null
      }

      this._wasInStock = true
      const isFirstCheck = this._isFirstPoll
      this._isFirstPoll = false
      
      return createDropEvent({
        retailer: 'target',
        productName: name,
        productUrl: this.productUrl,
        dropType: DROP_TYPES.IN_STOCK,
        price,
        isFirstCheck
      })
    } catch (err) {
      console.error(`[TargetPoller] Error for TCIN ${this.tcin}:`, {
        message: err.message,
        stderr: err.stderr,
        stdout: err.stdout
      })
      return null
    }
  }
}
