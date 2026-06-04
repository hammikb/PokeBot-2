import { randomUUID } from 'crypto'

/**
 * ShippingManager - Manages shipping addresses
 * Allows reusable shipping addresses across multiple accounts
 */
export class ShippingManager {
  constructor(getDb) {
    this.getDb = getDb
  }

  /**
   * Get all shipping addresses
   */
  getAll() {
    return this.getDb().prepare('SELECT * FROM shipping_addresses ORDER BY created_at DESC').all()
  }

  /**
   * Get a single shipping address by ID
   */
  get(id) {
    return this.getDb().prepare('SELECT * FROM shipping_addresses WHERE id = ?').get(id)
  }

  /**
   * Create a new shipping address
   */
  create(data) {
    const {
      name,
      firstName,
      lastName,
      address1,
      address2 = '',
      city,
      state,
      zip,
      phone = '',
      isDefault = false
    } = data

    if (!name || !firstName || !lastName || !address1 || !city || !state || !zip) {
      throw new Error('name, firstName, lastName, address1, city, state, and zip are required')
    }

    const id = randomUUID()

    // If this is set as default, unset all other defaults
    if (isDefault) {
      this.getDb().prepare('UPDATE shipping_addresses SET is_default = 0').run()
    }

    this.getDb()
      .prepare(
        `INSERT INTO shipping_addresses (
          id, name, first_name, last_name, address1, address2, city, state, zip, phone, is_default, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        firstName,
        lastName,
        address1,
        address2,
        city,
        state,
        zip,
        phone,
        isDefault ? 1 : 0,
        new Date().toISOString()
      )

    return id
  }

  /**
   * Update a shipping address
   */
  update(id, fields) {
    const allowed = [
      'name',
      'firstName',
      'lastName',
      'address1',
      'address2',
      'city',
      'state',
      'zip',
      'phone',
      'isDefault'
    ]

    const updates = {}
    for (const key of allowed) {
      if (key in fields) {
        if (key === 'firstName') {
          updates.first_name = fields.firstName
        } else if (key === 'lastName') {
          updates.last_name = fields.lastName
        } else if (key === 'isDefault') {
          updates.is_default = fields.isDefault ? 1 : 0
          // If setting as default, unset all others
          if (fields.isDefault) {
            this.getDb().prepare('UPDATE shipping_addresses SET is_default = 0').run()
          }
        } else {
          updates[key] = fields[key]
        }
      }
    }

    for (const [column, value] of Object.entries(updates)) {
      this.getDb()
        .prepare(`UPDATE shipping_addresses SET ${column} = ? WHERE id = ?`)
        .run(value, id)
    }
  }

  /**
   * Delete a shipping address
   */
  delete(id) {
    this.getDb().prepare('DELETE FROM shipping_addresses WHERE id = ?').run(id)
  }

  /**
   * Get the default shipping address
   */
  getDefault() {
    return this.getDb().prepare('SELECT * FROM shipping_addresses WHERE is_default = 1').get()
  }

  /**
   * Set an address as default
   */
  setDefault(id) {
    // Unset all defaults
    this.getDb().prepare('UPDATE shipping_addresses SET is_default = 0').run()
    // Set this one as default
    this.getDb().prepare('UPDATE shipping_addresses SET is_default = 1 WHERE id = ?').run(id)
  }

  /**
   * Get formatted address string (for display)
   */
  getFormattedAddress(id) {
    const address = this.get(id)
    if (!address) return ''

    const parts = [
      address.address1,
      address.address2,
      `${address.city}, ${address.state} ${address.zip}`
    ].filter(Boolean)

    return parts.join(', ')
  }

  /**
   * Get short address (for display in lists)
   */
  getShortAddress(id) {
    const address = this.get(id)
    if (!address) return ''
    return `${address.address1}, ${address.city}, ${address.state}`
  }
}
