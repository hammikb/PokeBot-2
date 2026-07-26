/**
 * Walmart Pokemon Card Drop Monitor — Raspberry Pi Edition
 *
 * Polls Walmart's item API for in-stock / out-of-stock changes on a list of
 * Pokemon card product URLs. Pushes drop events to the same Supabase broadcast
 * channels that PokeBot (and the Pi worker) use, so your Electron app receives
 * in-stock notifications and can auto-checkout.
 *
 * USAGE:
 *   node scripts/monitor_walmart_pokemon.mjs [--once] [--interval=15000]
 *
 *   --once      Check once and exit (cron-friendly)
 *   --interval  Poll interval in ms (default: 15000 = every 15 seconds)
 *
 * CONFIGURATION:
 *   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as environment variables.
 *   The service-role key is required to insert drops into the broadcasts table —
 *   do NOT use the anon publishable key for writes.
 *
 * PRODUCT LIST:
 *   The `PRODUCTS` array below uses the item ID extracted from any Walmart URL.
 *   Just add `/ip/{item-id}` URLs from Walmart's Pokemon category.
 *
 *   To watch a new item, add it to the PRODUCTS array:
 *     {
 *       itemId: '123456789',
 *       name: 'Pokemon Scarlet & Violet - Booster Bundle',
 *       productUrl: 'https://www.walmart.com/ip/123456789',
 *       maxPrice: 29.99   // optional — skip drops above this price
 *     }
 *
 * DEPLOYMENT (Raspberry Pi):
 *   1. Copy this file, the .env, and package.json deps (axios) to your Pi
 *   2. npm install axios @supabase/supabase-js
 *   3. Create a systemd service or cron job to run it persistently
 */

import { createClient } from '@supabase/supabase-js'
import axios from 'axios'

// ── Configuration ──────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbnnouwhesexfllninwb.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || 'sb_publishable_ISHuDgo14iTtTsRdJFnkYQ__6e9nYlx'

// Service-role key is required to write to the broadcast tables.
// If you only have the publishable key, the Pi worker must be running
// to forward drops (or set up a dedicated http endpoint).
const USE_SERVICE_ROLE = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const INTERVAL_MS = Number(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1]) || 15000
const ONCE = process.argv.includes('--once')

// ── Products to monitor ────────────────────────────────────────────────
// Add Walmart Pokemon card product URLs here. The item ID is auto-extracted.
const PRODUCTS = [
  // Example: Surging Sparks Elite Trainer Box
  { itemId: '110256827', name: 'Pokemon Surging Sparks ETB', productUrl: 'https://www.walmart.com/ip/110256827' },

  // Example: Paldea Evolved Booster Bundle
  // { itemId: '2920743936', name: 'Pokemon Paldea Evolved - Booster Bundle', productUrl: 'https://www.walmart.com/ip/2920743936' },

  // Add more items below — copy the item ID from the Walmart URL
  // { itemId: 'XXXXXXXXX', name: 'Product name', productUrl: 'https://www.walmart.com/ip/XXXXXXXXX', maxPrice: 29.99 },
]

// Sanity check
for (const product of PRODUCTS) {
  if (!product.itemId || !product.name) {
    console.error('Invalid product entry — itemId and name are required:', product)
    process.exit(1)
  }
}

// ── State tracking ─────────────────────────────────────────────────────
// Persist last-known availability state so we only fire on changes.
const stateMap = new Map() // itemId → { inStock, price, name, productUrl }

// ── Supabase client ────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

/**
 * Push a drop event onto the Supabase broadcast channel for the given product.
 * This is the same path the Pi worker uses — every subscribed PokeBot instance
 * will receive the drop through its realtime channel.
 */
async function pushDrop(product, event) {
  if (!USE_SERVICE_ROLE) {
    console.log(
      `${new Date().toISOString()} DROP [${product.name}] ${event.type} @ $${event.price || '?'} (no service role — broadcast skipped)`
    )
    return
  }

  const { error } = await supabase
    .from('drops')
    .insert({
      retailer: 'walmart',
      product_key: `walmart-${product.itemId}`,
      name: product.name,
      product_url: product.productUrl,
      drop_type: event.type,
      price: event.price,
      raw_payload: event.raw
    })

  if (error) {
    console.error(`${new Date().toISOString()} Supabase insert failed: ${error.message}`)
    return
  }

  console.log(
    `${new Date().toISOString()} DROP PUSHED [${product.name}] ${event.type.toUpperCase()} @ $${event.price || 'N/A'}`
  )
}

// ── Walmart API poller ─────────────────────────────────────────────────
async function pollWalmartItem(itemId) {
  try {
    const { data } = await axios.get(`https://www.walmart.com/ip/${itemId}`, {
      timeout: 15000,
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9'
      },
      params: { modules: 'item,price,inventory' }
    })

    const name = data?.name || data?.item?.name || null
    const price =
      data?.priceInfo?.currentPrice?.price ??
      data?.price?.currentPrice?.price ??
      data?.priceInfo?.wasPrice?.price ??
      null
    const availabilityStatus =
      data?.availabilityStatus || data?.item?.availabilityStatus || data?.inventory?.status || null
    const inStock =
      availabilityStatus === 'IN_STOCK' ||
      availabilityStatus === 'AVAILABLE' ||
      data?.addToCartEligible === true ||
      data?.buyable === true

    return {
      name,
      price: price != null ? Number(price) : null,
      availabilityStatus,
      inStock,
      raw: data,
      status: data?.response?.status || 200
    }
  } catch (err) {
    const status = err.response?.status || 0
    return { error: err.message, status, inStock: false, name: null, price: null }
  }
}

// ── Main monitor loop ──────────────────────────────────────────────────
async function checkProduct(product) {
  const result = await pollWalmartItem(product.itemId)

  if (result.error) {
    const throttled = [403, 429, 412].includes(result.status)
    if (throttled && checks % 20 === 0) {
      console.log(`${new Date().toISOString()} THROTTLED [${product.name}] HTTP ${result.status}`)
    }
    return
  }

  const previous = stateMap.get(product.itemId)
  const now = Date.now()

  // Track state changes
  if (!previous || previous.inStock !== result.inStock) {
    const event = {
      type: result.inStock ? 'in_stock' : 'out_of_stock',
      price: result.price,
      raw: result.raw,
      changedAt: new Date().toISOString(),
      previousState: previous?.inStock ?? null
    }

    console.log(
      `${new Date().toISOString()} STATE CHANGE [${product.name}]: ` +
      `${previous?.inStock === true ? 'IN_STOCK' : previous?.inStock === false ? 'OUT_OF_STOCK' : 'UNKNOWN'} → ` +
      `${result.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK'} @ $${result.price || '?'}`
    )

    stateMap.set(product.itemId, { inStock: result.inStock, price: result.price, name: product.name, productUrl: product.productUrl, lastChecked: now })

    // Push to Supabase if in stock (also push out-of-stock for tracking)
    await pushDrop(product, event)
  } else {
    stateMap.set(product.itemId, { ...previous, price: result.price, lastChecked: now })
  }
}

// ── Entry point ────────────────────────────────────────────────────────
let checks = 0

async function runOnce() {
  console.log(`${new Date().toISOString()} START Walmart Pokemon monitor (once) — ${PRODUCTS.length} products`)
  for (const product of PRODUCTS) {
    await checkProduct(product)
    // Small delay between items to avoid rate limiting
    await new Promise(r => setTimeout(r, 500))
  }
  console.log(`${new Date().toISOString()} COMPLETE`)
}

async function runLoop() {
  console.log(`${new Date().toISOString()} START Walmart Pokemon monitor — ${PRODUCTS.length} products, ${INTERVAL_MS}ms interval`)
  while (true) {
    checks++
    const batchStart = Date.now()
    for (const product of PRODUCTS) {
      await checkProduct(product)
      await new Promise(r => setTimeout(r, 500))
    }

    if (checks % 4 === 0) {
      const active = [...stateMap.values()].filter(s => s.inStock).length
      console.log(`${new Date().toISOString()} HEARTBEAT #${checks} — ${active} in stock, ${stateMap.size} tracked`)
    }

    const elapsed = Date.now() - batchStart
    const waitMs = Math.max(1000, INTERVAL_MS - elapsed)
    await new Promise(r => setTimeout(r, waitMs))
  }
}

// Run
if (ONCE) {
  await runOnce()
} else {
  await runLoop()
}