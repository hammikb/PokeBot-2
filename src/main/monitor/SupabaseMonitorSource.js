import { EventEmitter } from 'events'

// Receives in-stock drops from the central Supabase fan-out instead of polling
// retailers locally. One private Realtime channel per subscribed product
// (topic `drops:product:{id}`, event `drop`). Emits the same shape MonitorEngine
// emits so TaskManager._onDrop is unchanged. The serverside worker no longer
// filters by price, so each task's max_price is applied here.
export class SupabaseMonitorSource extends EventEmitter {
  constructor({ client }) {
    super()
    this._client = client
    this._channels = new Map() // productUrl → { channel, productId }
    this._byProduct = new Map() // productId → { productUrl, maxPrice }
    this._reconnectTimers = new Map()
    this._health = new Map()
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
          active: true
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
    const { data: userData } = await this._client.auth.getUser()
    await this._client
      .from('subscriptions')
      .upsert(
        { user_id: userData.user.id, product_id: productId },
        { onConflict: 'user_id,product_id', ignoreDuplicates: true }
      )

    this._byProduct.set(productId, {
      productUrl,
      retailer,
      productKey,
      productName,
      maxPrice: maxPrice ?? null
    })

    const channel = this._subscribeProductChannel(productId)
    this._channels.set(productUrl, { channel, productId })

    return { subscribed: true, productId }
  }

  _handleDrop(productId, payload) {
    const meta = this._byProduct.get(productId)
    if (!meta) return
    const price = payload?.price ?? null
    this._health.set(productId, {
      status: 'SUBSCRIBED',
      lastEventAt: Date.now(),
      lastStatusAt: Date.now()
    })
    if (meta.maxPrice != null && price != null && Number(price) > Number(meta.maxPrice)) return
    this.emit('drop', {
      retailer: payload.retailer,
      productName: payload.name,
      productUrl: meta.productUrl,
      price,
      dropType: payload.drop_type || 'in_stock'
    })
  }

  // Tear down the realtime channel for a product without touching the central
  // subscription row. Used on app quit: closing the app is not "stop watching" —
  // the Pi should keep monitoring while the user's task still exists.
  async releaseChannel(productUrl) {
    const entry = this._channels.get(productUrl)
    if (!entry) return
    await this._client.removeChannel(entry.channel)
    const reconnectTimer = this._reconnectTimers.get(entry.productId)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    this._reconnectTimers.delete(entry.productId)
    this._health.delete(entry.productId)
    this._channels.delete(productUrl)
    this._byProduct.delete(entry.productId)
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
      const { data } = await this._client
        .from('products')
        .select('id')
        .match({ retailer, product_key: productKey })
        .maybeSingle()
      productId = data?.id ?? null
    }
    if (!productId) return

    await this._client.from('subscriptions').delete().eq('product_id', productId)
  }

  async stop() {
    for (const productUrl of [...this._channels.keys()]) {
      await this.releaseChannel(productUrl)
    }
  }

  getHealth() {
    return Object.fromEntries(
      [...this._byProduct.entries()].map(([productId, meta]) => [
        meta.productUrl,
        { productId, ...(this._health.get(productId) || { status: 'CONNECTING' }) }
      ])
    )
  }

  _subscribeProductChannel(productId) {
    const meta = this._byProduct.get(productId)
    const channel = this._client
      .channel(`drops:product:${productId}`, { config: { private: true } })
      .on('broadcast', { event: 'drop' }, ({ payload }) => this._handleDrop(productId, payload))

    channel.subscribe((status, error) => {
      const previous = this._health.get(productId) || {}
      this._health.set(productId, {
        ...previous,
        status,
        lastStatusAt: Date.now(),
        error: error?.message || null
      })
      this.emit('health', { productId, productUrl: meta?.productUrl, status, error })
      if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        this._scheduleReconnect(productId)
      } else if (status === 'SUBSCRIBED') {
        const timer = this._reconnectTimers.get(productId)
        if (timer) clearTimeout(timer)
        this._reconnectTimers.delete(productId)
      }
    })
    return channel
  }

  _scheduleReconnect(productId) {
    if (this._reconnectTimers.has(productId)) return
    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(productId)
      const meta = this._byProduct.get(productId)
      const current = meta ? this._channels.get(meta.productUrl) : null
      if (!meta || !current) return
      await this._client.removeChannel(current.channel).catch(() => {})
      const channel = this._subscribeProductChannel(productId)
      this._channels.set(meta.productUrl, { channel, productId })
      this.emit('notice', {
        productUrl: meta.productUrl,
        message: 'Realtime monitor reconnected after a channel interruption.'
      })
    }, 1500)
    this._reconnectTimers.set(productId, timer)
  }
}
