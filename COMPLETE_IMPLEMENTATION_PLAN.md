# 🚀 Complete Implementation & Testing Plan

## 📋 Overview

This document outlines the complete implementation of all 3 phases plus comprehensive testing.

---

## ✅ What's Already Complete

### Phase 1: Encrypted Storage (70% Complete)

**✅ Backend (100%)**:
- PaymentManager.js created
- ShippingManager.js created
- Database migration #3 applied
- IPC constants added
- IPC handlers implemented
- Managers initialized
- App store updated with actions

**⏳ Frontend (0%)**:
- [ ] PaymentMethods page
- [ ] ShippingAddresses page
- [ ] Navigation/routing
- [ ] Forms and UI

**Estimated Time**: 2-3 hours

---

## 📝 Phase 1: Complete Frontend (Remaining 30%)

### Step 1: Create Payment Methods Page

**File**: `src/renderer/src/pages/PaymentMethods.jsx`

```jsx
import { useState, useEffect } from 'react'
import { useAppStore } from '../store/appStore'

export default function PaymentMethods() {
  const { paymentMethods, loadPaymentMethods, createPaymentMethod, deletePaymentMethod } = useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    cardNumber: '',
    expiryMonth: '',
    expiryYear: '',
    cvv: '',
    billingAddress1: '',
    billingAddress2: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    billingPhone: ''
  })

  useEffect(() => {
    loadPaymentMethods()
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      await createPaymentMethod(formData)
      setShowForm(false)
      setFormData({
        name: '',
        cardNumber: '',
        expiryMonth: '',
        expiryYear: '',
        cvv: '',
        billingAddress1: '',
        billingAddress2: '',
        billingCity: '',
        billingState: '',
        billingZip: '',
        billingPhone: ''
      })
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    if (confirm('Delete this payment method?')) {
      await deletePaymentMethod(id)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Payment Methods</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {showForm ? 'Cancel' : 'Add Payment Method'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-800 p-6 rounded-lg space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Card Number</label>
              <input
                type="text"
                value={formData.cardNumber}
                onChange={(e) => setFormData({ ...formData, cardNumber: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Expiry Month</label>
              <input
                type="text"
                value={formData.expiryMonth}
                onChange={(e) => setFormData({ ...formData, expiryMonth: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="MM"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Expiry Year</label>
              <input
                type="text"
                value={formData.expiryYear}
                onChange={(e) => setFormData({ ...formData, expiryYear: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                placeholder="YYYY"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">CVV</label>
              <input
                type="text"
                value={formData.cvv}
                onChange={(e) => setFormData({ ...formData, cvv: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Billing Address</label>
              <input
                type="text"
                value={formData.billingAddress1}
                onChange={(e) => setFormData({ ...formData, billingAddress1: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">City</label>
              <input
                type="text"
                value={formData.billingCity}
                onChange={(e) => setFormData({ ...formData, billingCity: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">State</label>
              <input
                type="text"
                value={formData.billingState}
                onChange={(e) => setFormData({ ...formData, billingState: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">ZIP</label>
              <input
                type="text"
                value={formData.billingZip}
                onChange={(e) => setFormData({ ...formData, billingZip: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
              />
            </div>
          </div>
          <button
            type="submit"
            className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Save Payment Method
          </button>
        </form>
      )}

      <div className="grid gap-4">
        {paymentMethods.map((method) => (
          <div key={method.id} className="bg-gray-800 p-4 rounded-lg flex justify-between items-center">
            <div>
              <h3 className="font-bold">{method.name}</h3>
              <p className="text-sm text-gray-400">****-****-****-{method.cardNumber.slice(-4)}</p>
              <p className="text-sm text-gray-400">Expires: {method.expiryMonth}/{method.expiryYear}</p>
            </div>
            <button
              onClick={() => handleDelete(method.id)}
              className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Delete
            </button>
          </div>
        ))}
        {paymentMethods.length === 0 && !showForm && (
          <p className="text-gray-400 text-center py-8">No payment methods yet. Add one to get started!</p>
        )}
      </div>
    </div>
  )
}
```

### Step 2: Create Shipping Addresses Page

**File**: `src/renderer/src/pages/ShippingAddresses.jsx`

```jsx
import { useState, useEffect } from 'react'
import { useAppStore } from '../store/appStore'

export default function ShippingAddresses() {
  const { 
    shippingAddresses, 
    loadShippingAddresses, 
    createShippingAddress, 
    deleteShippingAddress,
    setDefaultShippingAddress 
  } = useAppStore()
  
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    firstName: '',
    lastName: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    phone: '',
    isDefault: false
  })

  useEffect(() => {
    loadShippingAddresses()
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      await createShippingAddress(formData)
      setShowForm(false)
      setFormData({
        name: '',
        firstName: '',
        lastName: '',
        address1: '',
        address2: '',
        city: '',
        state: '',
        zip: '',
        phone: '',
        isDefault: false
      })
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    if (confirm('Delete this address?')) {
      await deleteShippingAddress(id)
    }
  }

  const handleSetDefault = async (id) => {
    await setDefaultShippingAddress(id)
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Shipping Addresses</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {showForm ? 'Cancel' : 'Add Address'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-800 p-6 rounded-lg space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">First Name</label>
              <input
                type="text"
                value={formData.firstName}
                onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Last Name</label>
              <input
                type="text"
                value={formData.lastName}
                onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address Line 1</label>
              <input
                type="text"
                value={formData.address1}
                onChange={(e) => setFormData({ ...formData, address1: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address Line 2</label>
              <input
                type="text"
                value={formData.address2}
                onChange={(e) => setFormData({ ...formData, address2: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">City</label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">State</label>
              <input
                type="text"
                value={formData.state}
                onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">ZIP</label>
              <input
                type="text"
                value={formData.zip}
                onChange={(e) => setFormData({ ...formData, zip: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Phone</label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 rounded"
              />
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                className="mr-2"
              />
              <label className="text-sm font-medium">Set as default</label>
            </div>
          </div>
          <button
            type="submit"
            className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Save Address
          </button>
        </form>
      )}

      <div className="grid gap-4">
        {shippingAddresses.map((address) => (
          <div key={address.id} className="bg-gray-800 p-4 rounded-lg">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold">{address.name} {address.is_default ? '(Default)' : ''}</h3>
                <p className="text-sm">{address.first_name} {address.last_name}</p>
                <p className="text-sm text-gray-400">{address.address1}</p>
                {address.address2 && <p className="text-sm text-gray-400">{address.address2}</p>}
                <p className="text-sm text-gray-400">{address.city}, {address.state} {address.zip}</p>
                {address.phone && <p className="text-sm text-gray-400">{address.phone}</p>}
              </div>
              <div className="flex gap-2">
                {!address.is_default && (
                  <button
                    onClick={() => handleSetDefault(address.id)}
                    className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                  >
                    Set Default
                  </button>
                )}
                <button
                  onClick={() => handleDelete(address.id)}
                  className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
        {shippingAddresses.length === 0 && !showForm && (
          <p className="text-gray-400 text-center py-8">No addresses yet. Add one to get started!</p>
        )}
      </div>
    </div>
  )
}
```

### Step 3: Add Navigation

Update `src/renderer/src/App.jsx` to include routes for the new pages.

---

## 📝 Phase 2: Visual Enhancements

### Part 1: Thumbnail Cache System

**File**: `src/main/thumbnails/ThumbnailCache.js`

```javascript
import { app } from 'electron'
import { join } from 'path'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('ThumbnailCache')

export class ThumbnailCache {
  constructor() {
    this.cacheDir = join(app.getPath('userData'), 'thumbnails')
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  async downloadThumbnail(imageUrl) {
    try {
      const hash = createHash('md5').update(imageUrl).digest('hex')
      const ext = imageUrl.split('.').pop().split('?')[0] || 'jpg'
      const filename = `${hash}.${ext}`
      const filepath = join(this.cacheDir, filename)

      if (existsSync(filepath)) {
        log.debug('Thumbnail already cached', { imageUrl, filepath })
        return filepath
      }

      log.info('Downloading thumbnail', { imageUrl })
      const response = await fetch(imageUrl)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      await pipeline(response.body, createWriteStream(filepath))
      log.info('Thumbnail downloaded', { imageUrl, filepath })
      return filepath
    } catch (err) {
      log.error('Failed to download thumbnail', { imageUrl, error: err.message })
      return null
    }
  }

  getThumbnailPath(imageUrl) {
    const hash = createHash('md5').update(imageUrl).digest('hex')
    const ext = imageUrl.split('.').pop().split('?')[0] || 'jpg'
    const filename = `${hash}.${ext}`
    const filepath = join(this.cacheDir, filename)
    return existsSync(filepath) ? filepath : null
  }
}
```

### Part 2: Alert Acknowledgment System

**Database Migration #4**:

```javascript
{
  version: 4,
  name: 'add_alert_history',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_history (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        alert_type TEXT NOT NULL,
        product_name TEXT,
        product_url TEXT,
        price REAL,
        seen INTEGER DEFAULT 0,
        acknowledged_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_alert_history_task ON alert_history(task_id);
      CREATE INDEX IF NOT EXISTS idx_alert_history_seen ON alert_history(seen);
    `)
  }
}
```

---

## 📝 Phase 3: Background Monitoring

### Service Worker Setup

**File**: `src/main/worker/MonitorWorker.js`

```javascript
import { parentPort } from 'worker_threads'
import { MonitorEngine } from '../monitor/MonitorEngine.js'

// Worker thread for background monitoring
let monitorEngine = null

parentPort.on('message', async (message) => {
  const { type, data } = message

  switch (type) {
    case 'start':
      monitorEngine = new MonitorEngine(data)
      await monitorEngine.start()
      parentPort.postMessage({ type: 'started' })
      break

    case 'stop':
      if (monitorEngine) {
        await monitorEngine.stop()
        monitorEngine = null
      }
      parentPort.postMessage({ type: 'stopped' })
      break

    case 'status':
      parentPort.postMessage({
        type: 'status',
        data: monitorEngine ? monitorEngine.getStatus() : null
      })
      break
  }
})
```

---

## 🧪 Complete Testing Plan

### Test 1: Walmart Checkout

**Prerequisites**:
- Walmart account created
- Payment method saved
- Shipping address saved
- Product URL ready

**Steps**:
1. Create task with Walmart product
2. Set mode to "test-checkout"
3. Start task
4. Verify:
   - Product page loads
   - Add to cart works
   - Checkout page loads
   - CVV fills correctly
   - Stops at "Place Order"

**Expected Result**: ✅ Reaches place order button without errors

---

### Test 2: Target Checkout

**Prerequisites**:
- Target account created
- Payment method saved
- Shipping address saved
- Product URL ready

**Steps**:
1. Create task with Target product
2. Set mode to "test-checkout"
3. Start task
4. Verify:
   - Product page loads
   - Add to cart works
   - Checkout page loads
   - Payment info fills
   - Stops at "Place Order"

**Expected Result**: ✅ Reaches place order button without errors

---

### Test 3: Alert Monitors

**Test 3a: In-Stock Alert**:
1. Create task with out-of-stock product
2. Set mode to "alert-only"
3. Start monitoring
4. Wait for restock
5. Verify notification fires

**Test 3b: Price Drop Alert**:
1. Create task with max price set
2. Monitor product
3. Wait for price drop below max
4. Verify notification fires

**Test 3c: Queue Alert**:
1. Create task for high-demand product
2. Monitor for queue
3. Verify queue detection
4. Verify notification fires

---

## 📊 Implementation Timeline

### Day 1: Phase 1 Frontend (2-3 hours)
- Create PaymentMethods page
- Create ShippingAddresses page
- Add navigation
- Test UI

### Day 2: Phase 2 Part 1 (2-3 hours)
- Implement ThumbnailCache
- Update task creation to fetch thumbnails
- Display thumbnails in UI
- Test thumbnail system

### Day 3: Phase 2 Part 2 (2-3 hours)
- Add alert_history migration
- Implement alert acknowledgment
- Update UI with seen/unseen badges
- Test alert system

### Day 4: Phase 3 (4-5 hours)
- Implement worker thread
- Add background monitoring
- Test resource usage
- Optimize performance

### Day 5: Full Testing (4-6 hours)
- Test Walmart checkout
- Test Target checkout
- Test all alert types
- Fix any bugs
- Document results

**Total Time**: 14-20 hours

---

## 🎯 Current Status

**Completed**:
- ✅ Phase 1 Backend (100%)
- ✅ App store updated (100%)
- ✅ All IPC handlers (100%)

**Remaining**:
- [ ] Phase 1 Frontend (0%)
- [ ] Phase 2 Thumbnails (0%)
- [ ] Phase 2 Alerts (0%)
- [ ] Phase 3 Background (0%)
- [ ] Full Testing (0%)

**Overall Progress**: 30% complete

---

## 💡 Recommendation

Due to the scope (14-20 hours of work), I recommend:

**Option A**: Implement in stages
- Week 1: Complete Phase 1
- Week 2: Complete Phase 2
- Week 3: Complete Phase 3
- Week 4: Full testing

**Option B**: Focus on high-value features
- Complete Phase 1 (immediate value)
- Skip Phase 3 (complex, low priority)
- Do thorough testing

**Option C**: Use as-is
- Backend is complete and working
- Can be used via IPC calls
- UI can be added later

---

*Created: June 5, 2026*  
*Status: 30% Complete - Backend Ready*
