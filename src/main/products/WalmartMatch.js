import { searchProducts } from './ProductSearch.js'

// UPC search first — Walmart indexes UPC/GTIN and returns an exact hit when it
// carries the item (verified live). Only falls back to a name search — lower
// confidence, several products can share similar names — when there's no UPC
// or Walmart doesn't carry that exact UPC.
export async function findWalmartMatch({ upc, name }) {
  if (upc) {
    const candidates = await searchWalmartUsable(upc)
    if (candidates.length > 0) return candidates.map((c) => ({ ...c, confidence: 'upc' }))
  }
  if (name) {
    const candidates = await searchWalmartUsable(name)
    if (candidates.length > 0)
      return candidates.slice(0, 3).map((c) => ({ ...c, confidence: 'name' }))
  }
  return []
}

// Bulk catalog linking uses a small SQLite cache so reopening the app does not
// repeat the same Walmart search (especially expensive name searches).
export async function findWalmartMatchCached({ db, upc, name }) {
  const query = upc ? String(upc).trim() : String(name || '').trim()
  if (!query) return []
  const queryKey = `${upc ? 'upc' : 'name'}:${query.toLowerCase()}`
  const cached = db
    ?.prepare(
      'SELECT candidates_json FROM walmart_match_search_cache WHERE query_key = ? AND expires_at > ?'
    )
    .get(queryKey, Math.floor(Date.now() / 1000))
  if (cached) {
    try {
      return JSON.parse(cached.candidates_json)
    } catch {
      // Replace malformed cache entries below.
    }
  }

  const candidates = await findWalmartMatch({ upc, name })
  db?.prepare(
    `INSERT OR REPLACE INTO walmart_match_search_cache
        (query_key, candidates_json, expires_at) VALUES (?, ?, ?)`
  ).run(queryKey, JSON.stringify(candidates), Math.floor(Date.now() / 1000) + (upc ? 7 : 1) * 86400)
  return candidates
}

async function searchWalmartUsable(query) {
  const results = await searchProducts(query, 'walmart')
  return results.filter((r) => !r.disabled && r.url && r.itemId)
}
