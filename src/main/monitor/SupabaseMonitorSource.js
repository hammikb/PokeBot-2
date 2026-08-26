import { EventEmitter } from 'events'

const DEFAULT_CATCH_UP_WINDOW_MS = 5 * 60 * 1000
const CATCH_UP_CURSOR_OVERLAP_MS = 1000
const MAX_CATCH_UP_ROWS = 500
const MAX_SEEN_EVENT_IDS_PER_PRODUCT = 1000
const MAX_CATCH_UP_RETRY_MS = 30_000
const WALMART_QUEUE_TOPIC = 'drops:retailer:walmart:queues'
const ACTIONABLE_DROP_TYPES = new Set([
  'in_stock',
  'restock',
  'price_drop',
  'preorder',
  'available',
  'queue_open'
])

// Receives in-stock drops from the central Supabase fan-out instead of polling
// retailers locally. One private Realtime channel per subscribed product
// (topic `drops:product:{id}`, event `drop`). Emits the same shape MonitorEngine
// emits so TaskManager._onDrop is unchanged. The serverside worker no longer
// filters by price, so each task's max_price is applied here.
export class SupabaseMonitorSource extends EventEmitter {
  constructor({
    client,
    catchUpWindowMs = DEFAULT_CATCH_UP_WINDOW_MS,
    now = () => Date.now(),
    deliveryState = null
  }) {
    super()
    this._client = client
    this._channels = new Map() // productUrl → { channel, productId, generation }
    this._byProduct = new Map() // productId → { productUrl, maxPrice }
    this._generations = new Map()
    this._health = new Map()
    this._inventory = new Map()
    this._recoveryPromise = null
    this._catchUpWindowMs = Math.max(0, Number(catchUpWindowMs) || 0)
    this._now = now
    this._catchUpPromises = new Map()
    this._catchUpRetryTimers = new Map()
    this._catchUpRetryAttempts = new Map()
    this._cursors = new Map()
    this._seenEventIds = new Map()
    this._deliveryState = deliveryState
    this._deliveryMetrics = {
      realtime: 0,
      catchUp: 0,
      duplicates: 0,
      catchUpErrors: 0,
      lastCatchUpAt: null
    }
    this._walmartQueueChannel = null
    this._walmartQueueProductCache = new Map()
  }

  async addProduct({ productUrl, retailer, productKey, productName, maxPrice }) {
    let { data: product, error } = await this._client
      .from('products')
      .select('id')
      .match({ retailer, product_key: productKey })
      .maybeSingle()
    if (error) throw new Error(`Supabase product lookup failed: ${error.message}`)

    if (!product) {
      // Central monitoring needs a row in the shared `products` table before anything
      // can watch it. `authenticated` only has an INSERT grant here (deliberately no
      // UPDATE — only the subscriptions_sync_product_active trigger may ever flip
      // `active`), so this must be a plain insert, not an upsert: upsert compiles to
      // INSERT ... ON CONFLICT DO UPDATE, and Postgres requires the UPDATE privilege
      // to plan that statement at all, even when no conflict occurs — it fails with
      // "permission denied for table products" rather than an RLS error, which is
      // easy to misdiagnose as an RLS gap when it's actually a missing GRANT.
      const insertResult = await this._client
        .from('products')
        .insert({
          retailer,
          product_key: productKey,
          product_url: productUrl,
          name: productName || productKey,
          // The subscriptions trigger is the only authority that activates a
          // centrally monitored product. If auth/subscription creation fails,
          // this inactive row cannot consume Pi proxy data on its own.
          active: false
        })
        .select('id')
        .single()

      if (insertResult.error?.code === '23505') {
        // Lost the race — another caller registered this exact product between our
        // lookup above and this insert. Their row is just as good as ours would have
        // been; use it.
        const refetch = await this._client
          .from('products')
          .select('id')
          .match({ retailer, product_key: productKey })
          .maybeSingle()
        if (!refetch.data) {
          this.emit('notice', {
            productUrl,
            message: `Could not register this product centrally: ${insertResult.error.message}`
          })
          return { subscribed: false }
        }
        product = refetch.data
      } else if (insertResult.error) {
        this.emit('notice', {
          productUrl,
          message: `Could not register this product centrally: ${insertResult.error.message}`
        })
        return { subscribed: false }
      } else {
        product = insertResult.data
      }
    }

    const productId = product.id
    if (!this._cursors.has(productId)) {
      let persistedCursor = null
      try {
        persistedCursor = this._deliveryState?.load?.(productId)
      } catch (error) {
        this._emitDeliveryStateNotice('load', productId, error)
      }
      if (persistedCursor) this._cursors.set(productId, persistedCursor)
    }
    const { data: userData, error: userError } = await this._client.auth.getUser()
    if (userError || !userData?.user?.id) {
      throw new Error(
        `Supabase subscription identity is unavailable: ${userError?.message || 'not signed in'}`
      )
    }
    const { error: subscriptionError } = await this._client
      .from('subscriptions')
      .upsert(
        { user_id: userData.user.id, product_id: productId },
        { onConflict: 'user_id,product_id', ignoreDuplicates: true }
      )
    if (subscriptionError) {
      throw new Error(`Supabase subscription failed: ${subscriptionError.message}`)
    }

    this._byProduct.set(productId, {
      productUrl,
      retailer,
      productKey,
      productName,
      maxPrice: maxPrice ?? null
    })

    const generation = this._nextGeneration(productId)
    const channel = this._subscribeProductChannel(productId, generation)
    this._channels.set(productUrl, { channel, productId, generation })

    return { subscribed: true, productId }
  }

  async subscribeWalmartQueueFeed() {
    if (this._walmartQueueChannel) {
      return { subscribed: true, topic: WALMART_QUEUE_TOPIC }
    }

    const channel = this._client
      .channel(WALMART_QUEUE_TOPIC, { config: { private: true } })
      .on('broadcast', { event: 'drop' }, ({ payload }) => {
        this._handleWalmartQueueDrop(payload).catch((error) => {
          this.emit('notice', {
            message: `Could not process a Walmart queue alert: ${error.message}`
          })
        })
      })

    this._walmartQueueChannel = channel
    const result = await new Promise((resolve, reject) => {
      channel.subscribe((status, error) => {
        this.emit('health', {
          productId: 'walmart-queue-feed',
          productUrl: null,
          status,
          error
        })
        if (status === 'SUBSCRIBED') {
          resolve({ subscribed: true, topic: WALMART_QUEUE_TOPIC })
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          reject(error || new Error(`Walmart queue feed ${status.toLowerCase()}`))
        }
      })
    }).catch(async (error) => {
      if (this._walmartQueueChannel === channel) this._walmartQueueChannel = null
      await this._client.removeChannel(channel).catch(() => {})
      throw error
    })

    await this._catchUpWalmartQueueFeed().catch((error) => {
      this.emit('notice', {
        message: `Walmart queue feed connected, but recent-alert catch-up failed: ${error.message}`
      })
    })
    return result
  }

  async unsubscribeWalmartQueueFeed() {
    const channel = this._walmartQueueChannel
    this._walmartQueueChannel = null
    this._walmartQueueProductCache.clear()
    if (channel) await this._client.removeChannel(channel)
  }

  async _handleWalmartQueueDrop(payload) {
    const productId = String(payload?.product_id || '').trim()
    const dropType = String(payload?.drop_type || '').toLowerCase()
    if (!productId || String(payload?.retailer || '').toLowerCase() !== 'walmart') return false
    if (dropType !== 'queue_open') return false

    const receivedAt = this._now()
    const observedAt = normalizeObservedAt(
      payload?.created_at ?? payload?.observed_at ?? payload?.timestamp,
      receivedAt
    )
    const eventId = stableEventId(productId, payload, observedAt, receivedAt)
    if (this._hasSeenEvent(productId, eventId)) {
      this._deliveryMetrics.duplicates += 1
      return false
    }
    this._rememberEvent(productId, eventId)
    this._deliveryMetrics.realtime += 1

    let product = this._walmartQueueProductCache.get(productId)
    if (!product) {
      const { data, error } = await this._client
        .from('products')
        .select('product_url,product_key,name')
        .eq('id', productId)
        .maybeSingle()
      if (error) throw new Error(`Walmart queue product lookup failed: ${error.message}`)
      product = data || null
      if (product) this._walmartQueueProductCache.set(productId, product)
    }
    if (!product?.product_url) {
      this.emit('notice', {
        message: 'A Walmart queue opened, but its product URL was unavailable.'
      })
      return false
    }

    this.emit('drop', {
      retailer: 'walmart',
      productName: payload?.name || product.name || product.product_key || 'Walmart product',
      productUrl: product.product_url,
      productKey: product.product_key || null,
      price: payload?.price ?? null,
      dropType,
      productId,
      eventId,
      dropCycleId: String(payload?.drop_cycle_id ?? payload?.dropCycleId ?? eventId),
      observedAt
    })
    return true
  }

  async _catchUpWalmartQueueFeed() {
    const since = new Date(this._now() - this._catchUpWindowMs).toISOString()
    const { data, error } = await this._client
      .from('drops')
      .select('id,product_id,retailer,name,price,drop_type,drop_cycle_id,created_at')
      .eq('retailer', 'walmart')
      .eq('drop_type', 'queue_open')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(MAX_CATCH_UP_ROWS + 1)
    if (error) throw new Error(`Walmart queue catch-up failed: ${error.message}`)
    if ((data || []).length > MAX_CATCH_UP_ROWS) {
      throw new Error(`Walmart queue catch-up exceeded ${MAX_CATCH_UP_ROWS} rows`)
    }
    for (const row of data || []) {
      await this._handleWalmartQueueDrop(row)
    }
  }

  _handleDrop(productId, payload, { delivery = 'realtime' } = {}) {
    const meta = this._byProduct.get(productId)
    if (!meta) return false
    const receivedAt = this._now()
    const observedAt = normalizeObservedAt(
      payload?.created_at ?? payload?.observed_at ?? payload?.timestamp,
      receivedAt
    )
    const eventId = stableEventId(productId, payload, observedAt, receivedAt)
    const dropCycleId = String(payload?.drop_cycle_id ?? payload?.dropCycleId ?? eventId)

    this._advanceCursor(productId, observedAt, eventId)
    if (this._hasSeenEvent(productId, eventId)) {
      this._deliveryMetrics.duplicates += 1
      return false
    }
    this._rememberEvent(productId, eventId)
    this._deliveryMetrics[delivery === 'catch_up' ? 'catchUp' : 'realtime'] += 1

    const price = payload?.price ?? null
    const dropType = String(payload?.drop_type || 'in_stock').toLowerCase()
    const previous = this._health.get(productId) || {}
    this._health.set(productId, {
      ...previous,
      status: 'SUBSCRIBED',
      lastEventAt: receivedAt,
      lastEventId: eventId,
      lastObservedAt: observedAt,
      lastDelivery: delivery,
      lastStatusAt: receivedAt
    })
    if (meta.maxPrice != null && price != null && Number(price) > Number(meta.maxPrice)) {
      return false
    }
    if (!ACTIONABLE_DROP_TYPES.has(dropType)) return false
    this.emit('drop', {
      retailer: payload.retailer,
      productName: payload.name,
      productUrl: meta.productUrl,
      price,
      dropType,
      productId,
      eventId,
      dropCycleId,
      observedAt
    })
    return true
  }

  _handleInventory(productId, payload, { delivery = 'realtime' } = {}) {
    const meta = this._byProduct.get(productId)
    if (!meta || meta.retailer !== 'target' || typeof payload?.available !== 'boolean') return false
    const receivedAt = this._now()
    const observedAt = normalizeObservedAt(
      payload?.observed_at ?? payload?.created_at ?? payload?.timestamp,
      receivedAt
    )
    const inventory = {
      available: payload.available,
      observedAt,
      receivedAt,
      delivery,
      availabilityStatus: payload?.availability_status || null,
      quantity: payload?.available_to_promise_quantity ?? null,
      reasonCode: payload?.reason_code || null
    }
    const previous = this._inventory.get(productId)
    if (!previous || observedAt >= previous.observedAt) this._inventory.set(productId, inventory)
    this.emit('inventory', { productId, productUrl: meta.productUrl, ...inventory })
    return true
  }

  getInventoryGate(productUrl, dropObservedAt) {
    const entry = this._channels.get(productUrl)
    const meta = entry ? this._byProduct.get(entry.productId) : null
    if (!entry || meta?.retailer !== 'target') {
      return { mode: 'fallback', available: null, observedAt: null, reason: 'inventory-unavailable' }
    }
    const health = this._health.get(entry.productId) || {}
    if (health.interruptedAt != null || health.status !== 'SUBSCRIBED') {
      return { mode: 'fallback', available: null, observedAt: null, reason: 'channel-interrupted' }
    }
    if (health.catchingUp || health.catchUpError) {
      return {
        mode: 'fallback',
        available: null,
        observedAt: null,
        reason: 'inventory-catch-up-unhealthy'
      }
    }
    const inventory = this._inventory.get(entry.productId)
    if (!inventory) {
      return { mode: 'fallback', available: null, observedAt: null, reason: 'inventory-missing' }
    }
    const dropAt = Date.parse(dropObservedAt)
    const inventoryAt = Date.parse(inventory.observedAt)
    if (!Number.isFinite(dropAt) || !Number.isFinite(inventoryAt) || inventoryAt < dropAt) {
      return {
        mode: 'fallback',
        available: inventory.available,
        observedAt: inventory.observedAt,
        reason: 'inventory-predates-drop'
      }
    }
    return inventory.available
      ? {
          mode: 'extend',
          available: true,
          observedAt: inventory.observedAt,
          reason: 'confirmed-in-stock'
        }
      : {
          mode: 'stop',
          available: false,
          observedAt: inventory.observedAt,
          reason: 'confirmed-out-of-stock'
        }
  }

  // Tear down the realtime channel for a product without touching the central
  // subscription row. Used on app quit: closing the app is not "stop watching" —
  // the Pi should keep monitoring while the user's task still exists.
  async releaseChannel(productUrl) {
    const entry = this._channels.get(productUrl)
    if (!entry) return
    this._nextGeneration(entry.productId)
    const catchUpRetryTimer = this._catchUpRetryTimers.get(entry.productId)
    if (catchUpRetryTimer) clearTimeout(catchUpRetryTimer)
    this._catchUpRetryTimers.delete(entry.productId)
    this._catchUpRetryAttempts.delete(entry.productId)
    this._health.delete(entry.productId)
    this._channels.delete(productUrl)
    this._byProduct.delete(entry.productId)
    this._cursors.delete(entry.productId)
    try {
      this._deliveryState?.clear?.(entry.productId)
    } catch (error) {
      this._emitDeliveryStateNotice('clear', entry.productId, error)
    }
    this._seenEventIds.delete(entry.productId)
    this._inventory.delete(entry.productId)
    await this._client.removeChannel(entry.channel)
  }

  // Explicitly stop watching: delete this user's subscription row (the central
  // ref-count decrement — the `subscriptions_sync_product_active` trigger then
  // deactivates the product once the last subscriber leaves) and tear down the
  // channel if one is open. Works without a channel too: a task deleted while
  // not running never called addProduct this session, so the product id is
  // looked up by (retailer, product_key) instead. RLS on `subscriptions` scopes
  // deletes to the caller's own user_id — no explicit user filter needed.
  async unsubscribe({ productUrl, retailer, productKey }) {
    const entry = productUrl ? this._channels.get(productUrl) : null
    let productId = entry?.productId ?? null
    if (entry) await this.releaseChannel(productUrl)

    if (!productId && retailer && productKey) {
      const { data, error } = await this._client
        .from('products')
        .select('id')
        .match({ retailer, product_key: productKey })
        .maybeSingle()
      if (error) throw new Error(`Supabase unsubscribe product lookup failed: ${error.message}`)
      productId = data?.id ?? null
    }
    if (!productId) return

    const { error } = await this._client.from('subscriptions').delete().eq('product_id', productId)
    if (error) throw new Error(`Supabase unsubscribe failed: ${error.message}`)
  }

  async stop() {
    await this.unsubscribeWalmartQueueFeed()
    for (const productUrl of [...this._channels.keys()]) {
      await this.releaseChannel(productUrl)
    }
  }

  getHealth() {
    return Object.fromEntries(
      [...this._byProduct.entries()].map(([productId, meta]) => [
        meta.productUrl,
        {
          productId,
          catchingUp: false,
          lastEventAt: null,
          lastEventId: null,
          lastObservedAt: null,
          lastCatchUpStartedAt: null,
          lastCatchUpCompletedAt: null,
          lastCatchUpRecovered: 0,
          catchUpError: null,
          ...(this._health.get(productId) || { status: 'CONNECTING' })
        }
      ])
    )
  }

  _subscribeProductChannel(productId, generation) {
    const meta = this._byProduct.get(productId)
    const channel = this._client
      .channel(`drops:product:${productId}`, { config: { private: true } })
      .on('broadcast', { event: 'drop' }, ({ payload }) => {
        if (this._generations.get(productId) === generation) this._handleDrop(productId, payload)
      })
      .on('broadcast', { event: 'inventory' }, ({ payload }) => {
        if (this._generations.get(productId) === generation) {
          this._handleInventory(productId, payload)
        }
      })

    channel.subscribe((status, error) => {
      if (this._generations.get(productId) !== generation) return
      const previous = this._health.get(productId) || {}
      const interrupted = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)
      this._health.set(productId, {
        ...previous,
        status,
        lastStatusAt: this._now(),
        error: error?.message || null,
        interruptedAt: interrupted ? (previous.interruptedAt ?? this._now()) : previous.interruptedAt
      })
      this.emit('health', { productId, productUrl: meta?.productUrl, status, error })
      if (status === 'SUBSCRIBED') {
        this._catchUpAfterSubscribe(productId, generation)
      }
    })
    return channel
  }

  async _catchUpAfterSubscribe(productId, generation) {
    await this._catchUpProduct(productId)
    if (this._generations.get(productId) !== generation) return
    const health = this._health.get(productId) || {}
    // A new generation may subscribe while the previous generation's catch-up
    // promise is still settling. Run once more so this subscription proves its
    // own durable gap is closed before the inventory gate becomes authoritative.
    if (health.status === 'SUBSCRIBED' && health.interruptedAt != null && !health.catchUpError) {
      await this._catchUpProduct(productId)
    }
  }

  _catchUpProduct(productId) {
    const existing = this._catchUpPromises.get(productId)
    if (existing) return existing

    const promise = this._runCatchUp(productId)
      .catch((error) => {
        const meta = this._byProduct.get(productId)
        if (!meta) return
        const completedAt = this._now()
        const previous = this._health.get(productId) || {}
        this._health.set(productId, {
          ...previous,
          catchingUp: false,
          lastCatchUpCompletedAt: completedAt,
          catchUpError: error.message
        })
        this.emit('health', {
          productId,
          productUrl: meta.productUrl,
          status: 'CATCH_UP_ERROR',
          channelStatus: previous.status || 'SUBSCRIBED',
          catchingUp: false,
          catchUpError: error.message
        })
        this._deliveryMetrics.catchUpErrors += 1
        this._scheduleCatchUpRetry(productId)
      })
      .finally(() => {
        this._catchUpPromises.delete(productId)
      })

    this._catchUpPromises.set(productId, promise)
    return promise
  }

  async _runCatchUp(productId) {
    const meta = this._byProduct.get(productId)
    if (!meta) return

    const startedAt = this._now()
    const previous = this._health.get(productId) || {}
    this._health.set(productId, {
      ...previous,
      catchingUp: true,
      lastCatchUpStartedAt: startedAt,
      catchUpError: null
    })

    const cursor = this._cursors.get(productId)
    const windowStart = startedAt - this._catchUpWindowMs
    const cursorStart = cursor
      ? Date.parse(cursor.observedAt) - CATCH_UP_CURSOR_OVERLAP_MS
      : windowStart
    const since = new Date(Math.max(windowStart, cursorStart)).toISOString()
    const { data, error } = await this._client
      .from('drops')
      .select('id,product_id,retailer,name,price,drop_type,drop_cycle_id,created_at')
      .eq('product_id', productId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(MAX_CATCH_UP_ROWS + 1)

    if (error) {
      throw new Error(`Supabase drop catch-up failed: ${error.message}`)
    }
    if (!this._byProduct.has(productId)) return

    const rows = [...(data || [])].sort(compareDropRows)
    if (rows.length > MAX_CATCH_UP_ROWS) {
      throw new Error(
        `Supabase drop catch-up exceeded ${MAX_CATCH_UP_ROWS} rows; replay was stopped to avoid silent data loss`
      )
    }
    let recovered = 0
    for (const row of rows) {
      if (this._handleDrop(productId, row, { delivery: 'catch_up' })) recovered += 1
    }
    await this._runInventoryCatchUp(productId)

    const completedAt = this._now()
    const latest = this._health.get(productId) || {}
    this._health.set(productId, {
      ...latest,
      catchingUp: false,
      lastCatchUpCompletedAt: completedAt,
      lastCatchUpRecovered: recovered,
      catchUpError: null,
      interruptedAt: latest.status === 'SUBSCRIBED' ? null : latest.interruptedAt
    })
    this._deliveryMetrics.lastCatchUpAt = new Date(completedAt).toISOString()
    const retryTimer = this._catchUpRetryTimers.get(productId)
    if (retryTimer) clearTimeout(retryTimer)
    this._catchUpRetryTimers.delete(productId)
    this._catchUpRetryAttempts.delete(productId)
    this.emit('health', {
      productId,
      productUrl: meta.productUrl,
      status: 'CATCH_UP_COMPLETE',
      channelStatus: latest.status || 'SUBSCRIBED',
      catchingUp: false,
      catchUpRecovered: recovered
    })
  }

  async _runInventoryCatchUp(productId) {
    const meta = this._byProduct.get(productId)
    if (!meta || meta.retailer !== 'target') return
    const { data, error } = await this._client
      .from('target_inventory_observations')
      .select(
        'tcin,available,observed_at,availability_status,available_to_promise_quantity,reason_code'
      )
      .eq('tcin', meta.productKey)
      .order('observed_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`Supabase inventory catch-up failed: ${error.message}`)
    const row = data?.[0]
    if (row && this._byProduct.has(productId)) {
      this._handleInventory(productId, { ...row, product_id: productId }, { delivery: 'catch_up' })
    }
  }

  _hasSeenEvent(productId, eventId) {
    return this._seenEventIds.get(productId)?.has(eventId) === true
  }

  _rememberEvent(productId, eventId) {
    let seen = this._seenEventIds.get(productId)
    if (!seen) {
      seen = new Map()
      this._seenEventIds.set(productId, seen)
    }
    seen.set(eventId, true)
    while (seen.size > MAX_SEEN_EVENT_IDS_PER_PRODUCT) {
      seen.delete(seen.keys().next().value)
    }
  }

  _advanceCursor(productId, observedAt, eventId) {
    const current = this._cursors.get(productId)
    if (
      !current ||
      observedAt > current.observedAt ||
      (observedAt === current.observedAt && eventId > current.eventId)
    ) {
      this._cursors.set(productId, { observedAt, eventId })
      try {
        this._deliveryState?.save?.(productId, { observedAt, eventId })
      } catch (error) {
        this._emitDeliveryStateNotice('save', productId, error)
      }
    }
  }

  getDeliveryMetrics() {
    return { ...this._deliveryMetrics }
  }

  _emitDeliveryStateNotice(operation, productId, error) {
    this.emit('notice', {
      type: 'delivery_state_error',
      operation,
      productId,
      message: error instanceof Error ? error.message : String(error)
    })
  }

  _nextGeneration(productId) {
    const generation = (this._generations.get(productId) || 0) + 1
    this._generations.set(productId, generation)
    return generation
  }

  recoverInterruptedChannels({ minInterruptedMs = 30_000 } = {}) {
    if (this._recoveryPromise) return this._recoveryPromise
    this._recoveryPromise = (async () => {
      let recovered = 0
      for (const [productUrl, entry] of [...this._channels.entries()]) {
        const health = this._health.get(entry.productId) || {}
        if (
          health.interruptedAt == null ||
          this._now() - health.interruptedAt < Math.max(0, Number(minInterruptedMs) || 0)
        ) {
          continue
        }
        if (this._channels.get(productUrl)?.generation !== entry.generation) continue

        const generation = this._nextGeneration(entry.productId)
        await this._client.removeChannel(entry.channel).catch(() => {})
        if (!this._byProduct.has(entry.productId)) continue
        const channel = this._subscribeProductChannel(entry.productId, generation)
        this._channels.set(productUrl, { channel, productId: entry.productId, generation })
        recovered += 1
        this.emit('notice', {
          productUrl,
          message: 'Realtime monitor recovered a channel that remained interrupted.'
        })
      }
      return { recovered }
    })().finally(() => {
      this._recoveryPromise = null
    })
    return this._recoveryPromise
  }

  _scheduleCatchUpRetry(productId) {
    if (!this._byProduct.has(productId) || this._catchUpRetryTimers.has(productId)) return
    const attempt = (this._catchUpRetryAttempts.get(productId) || 0) + 1
    this._catchUpRetryAttempts.set(productId, attempt)
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), MAX_CATCH_UP_RETRY_MS)
    const timer = setTimeout(() => {
      this._catchUpRetryTimers.delete(productId)
      if (this._byProduct.has(productId)) this._catchUpProduct(productId)
    }, delayMs)
    timer.unref?.()
    this._catchUpRetryTimers.set(productId, timer)
  }
}

function normalizeObservedAt(value, fallbackMs) {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? value < 10_000_000_000
        ? value * 1000
        : value
      : Date.parse(value)
  return new Date(Number.isFinite(parsed) ? parsed : fallbackMs).toISOString()
}

function stableEventId(productId, payload, observedAt, receivedAt) {
  const explicit = payload?.id ?? payload?.event_id ?? payload?.eventId
  if (explicit != null && String(explicit).trim()) return String(explicit)

  // Older broadcasters did not include the durable `drops.id`. Keep their
  // duplicate suppression narrowly scoped to one 30-second delivery window so
  // a later restock at the same price is still treated as a new drop cycle.
  const hasSourceTime = payload?.created_at ?? payload?.observed_at ?? payload?.timestamp
  const cycleTime = hasSourceTime ? observedAt : Math.floor(receivedAt / 30_000)
  return [
    'legacy',
    productId,
    cycleTime,
    payload?.drop_type || 'in_stock',
    payload?.price ?? '',
    payload?.name || ''
  ].join(':')
}

function compareDropRows(left, right) {
  const byTime = String(left?.created_at || '').localeCompare(String(right?.created_at || ''))
  if (byTime !== 0) return byTime
  return String(left?.id || '').localeCompare(String(right?.id || ''))
}
