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

    this._byProduct.set(productId, { productUrl, maxPrice: maxPrice ?? null })

    const channel = this._client
      .channel(`drops:product:${productId}`, { config: { private: true } })
      .on('broadcast', { event: 'drop' }, ({ payload }) => this._handleDrop(productId, payload))
    await channel.subscribe()
    this._channels.set(productUrl, { channel, productId })

    return { subscribed: true, productId }
  }

  _handleDrop(productId, payload) {
    const meta = this._byProduct.get(productId)
    if (!meta) return
    const price = payload?.price ?? null
    if (meta.maxPrice != null && price != null && Number(price) > Number(meta.maxPrice)) return
    this.emit('drop', {
      retailer: payload.retailer,
      productName: payload.name,
      productUrl: meta.productUrl,
      price,
      dropType: payload.drop_type || 'in_stock'
    })
  }

  async removeProduct(productUrl) {
    const entry = this._channels.get(productUrl)
    if (!entry) return
    // RLS on `subscriptions` scopes every row to the caller's own user_id, so this can
    // only ever delete our own subscription — no explicit user filter needed. This is
    // what actually decrements the central ref count; the `subscriptions_sync_product_active`
    // trigger then deactivates the product once the last subscriber's row is gone.
    await this._client.from('subscriptions').delete().eq('product_id', entry.productId)
    await this._client.removeChannel(entry.channel)
    this._channels.delete(productUrl)
    this._byProduct.delete(entry.productId)
  }

  async stop() {
    for (const productUrl of [...this._channels.keys()]) {
      await this.removeProduct(productUrl)
    }
  }
}
