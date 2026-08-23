export const demoState = {
  summary: {
    products: 12,
    activeSubscriptions: 0,
    drops24h: 0,
    proxyHealthy: 0,
    checks: 0,
    bytesUsed: 0,
    activeContexts: 0,
    blockedRate: null,
    cpuPercent: null,
    tempC: null,
    memPercent: null,
    diskPercent: null
  },
  products: [
    { id: 'demo-1', retailer: 'target', name: 'Waiting for Supabase rows', active: true, product_url: 'https://supabase.com' }
  ],
  drops: [
    { id: 'demo-drop', name: 'No live drops yet', retailer: 'target', price: null, drop_type: 'info', created_at: new Date().toISOString() }
  ],
  proxies: [
    { proxy: 'monitor is offline', successes: 0, blocked_403: 0, blocked_429: 0, last_failure_at: null, cooldown_until: null }
  ],
  subscriptions: [],
  snapshots: [],
  health: [],
  logs: [],
  catalog: []
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function freshnessState(updatedAt, now = Date.now()) {
  const timestamp = Date.parse(updatedAt || '')
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) return 'offline'
  const ageMs = Math.max(0, nowMs - timestamp)
  if (ageMs <= 90 * 1000) return 'fresh'
  if (ageMs <= 300 * 1000) return 'stale'
  return 'offline'
}

export function normalizeProduct(row) {
  return {
    id: row.id,
    retailer: row.retailer || 'target',
    name: row.name || row.product_key || 'Unnamed product',
    product_key: row.product_key,
    active: Boolean(row.active),
    pinned: Boolean(row.pinned),
    product_url: row.product_url,
    image: row.image || null
  }
}

// product_id -> number of Electron users currently subscribed. Drives the
// "N watching" status on the dashboard so it reflects the ref-counted reality
// instead of a bare active flag.
export function countWatchersByProduct(subscriptions) {
  const counts = new Map()
  for (const sub of safeArray(subscriptions)) {
    if (!sub?.product_id) continue
    counts.set(sub.product_id, (counts.get(sub.product_id) || 0) + 1)
  }
  return counts
}

export function normalizeDrop(row) {
  return {
    id: row.id,
    product_id: row.product_id,
    product_key: row.product_key,
    retailer: row.retailer || 'target',
    name: row.name || 'Drop',
    image: row.image || null,
    price: toNumber(row.price),
    product_url: row.product_url,
    drop_type: row.drop_type || 'alert',
    availability_status: row.availability_status || null,
    available_to_promise_quantity: toNumber(row.available_to_promise_quantity),
    created_at: row.created_at
  }
}

export function normalizeProxy(row) {
  return {
    id: row.id,
    proxy: row.proxy || row.endpoint || 'unknown proxy',
    successes: toNumber(row.successes) || 0,
    blocked_403: toNumber(row.blocked_403) || 0,
    blocked_429: toNumber(row.blocked_429) || 0,
    last_failure_at: row.last_failure_at,
    cooldown_until: row.cooldown_until
  }
}

export function normalizeSubscription(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    product_id: row.product_id,
    max_price: toNumber(row.max_price),
    created_at: row.created_at
  }
}

export function normalizeSnapshot(row) {
  return {
    id: row.id,
    status: row.status || 'unknown',
    checks: toNumber(row.checks) || 0,
    bytes_used: toNumber(row.bytes_used) || 0,
    total_products: toNumber(row.total_products) || 0,
    active_contexts: toNumber(row.active_contexts) || 0,
    blocked_rate: toNumber(row.blocked_rate),
    captured_at: row.captured_at
  }
}

export function normalizeHealth(row) {
  return {
    id: row.id,
    worker_name: row.worker_name || 'worker',
    hostname: row.hostname,
    platform: row.platform,
    cpu_percent: toNumber(row.cpu_percent),
    load_1m: toNumber(row.load_1m),
    mem_total_mb: toNumber(row.mem_total_mb),
    mem_used_mb: toNumber(row.mem_used_mb),
    mem_percent: toNumber(row.mem_percent),
    disk_percent: toNumber(row.disk_percent),
    temp_c: toNumber(row.temp_c),
    uptime_seconds: toNumber(row.uptime_seconds),
    watchlist_product_count: toNumber(row.watchlist_product_count),
    watchlist_last_success_at: row.watchlist_last_success_at || null,
    alert_outbox_pending: toNumber(row.alert_outbox_pending),
    last_drop_delivery_at: row.last_drop_delivery_at || null,
    last_discord_delivery_at: row.last_discord_delivery_at || null,
    last_discord_status: row.last_discord_status || null,
    last_discord_message_id: row.last_discord_message_id || null,
    active_schedule_profile: row.active_schedule_profile || null,
    schedule_next_transition_at: row.schedule_next_transition_at || null,
    updated_at: row.updated_at
  }
}

export function normalizeLog(row) {
  return {
    id: row.id,
    worker_name: row.worker_name || 'worker',
    service: row.service || 'api-monitor',
    level: row.level || 'info',
    message: row.message || '',
    created_at: row.created_at
  }
}

export function normalizeCatalogEntry(row) {
  const listings = Array.isArray(row.catalog_listings) ? row.catalog_listings : (row.listings || [])
  const target = listings.find((listing) => listing.retailer === 'target')
  return {
    id: row.id,
    product_key: row.product_key,
    name: row.name || row.product_key || 'Unnamed item',
    image: row.image || row.image_url || target?.image_url || null,
    category: row.category || null,
    is_marketplace: Boolean(row.is_marketplace),
    last_seen_at: row.last_seen_at,
    sort_order: Number.isFinite(row.sort_order) ? row.sort_order : null,
    upc: row.upc || target?.upc || null,
    listings,
    target_listing: target || null,
    walmart_listing: listings.find((listing) => listing.retailer === 'walmart') || null
  }
}

export function deriveAddedProductKeys(products, retailer) {
  return new Set(
    safeArray(products)
      .filter((product) => product.retailer === retailer)
      .map((product) => product.product_key)
  )
}

// product_key -> monitored product, as a plain object so it survives the
// server-component -> client-component prop boundary (Maps/Sets don't).
// Lets the catalog toggle show and flip the real monitoring state.
export function deriveProductsByKey(products, retailer) {
  const byKey = {}
  for (const product of safeArray(products)) {
    if (product.retailer === retailer && product.product_key) {
      byKey[product.product_key] = product
    }
  }
  return byKey
}

export function summarize(state) {
  const products = safeArray(state.products)
  const drops = safeArray(state.drops)
  const proxies = safeArray(state.proxies)
  const subscriptions = safeArray(state.subscriptions)
  const snapshots = safeArray(state.snapshots).map(normalizeSnapshot)
  const health = safeArray(state.health).map(normalizeHealth)
  const logs = safeArray(state.logs).map(normalizeLog)
  const catalog = safeArray(state.catalog).map(normalizeCatalogEntry)
  const latestSnapshot = snapshots[0] || null
  const latestHealth = health[0] || null
  const now = Date.now()

  return {
    summary: {
      products: products.length,
      activeSubscriptions: subscriptions.length,
      drops24h: drops.filter((drop) => {
        const ts = Date.parse(drop.created_at)
        return Number.isFinite(ts) && now - ts < 24 * 60 * 60 * 1000
      }).length,
      proxyHealthy: proxies.filter((proxy) => !proxy.cooldown_until || Date.parse(proxy.cooldown_until) < now).length,
      checks: latestSnapshot?.checks || 0,
      bytesUsed: latestSnapshot?.bytes_used || 0,
      activeContexts: latestSnapshot?.active_contexts || 0,
      blockedRate: latestSnapshot?.blocked_rate ?? null,
      cpuPercent: latestHealth?.cpu_percent ?? null,
      tempC: latestHealth?.temp_c ?? null,
      memPercent: latestHealth?.mem_percent ?? null,
      diskPercent: latestHealth?.disk_percent ?? null
    },
    products: products.map(normalizeProduct),
    drops: drops.map(normalizeDrop),
    proxies: proxies.map(normalizeProxy),
    subscriptions: subscriptions.map(normalizeSubscription),
    snapshots,
    health,
    logs,
    catalog
  }
}
