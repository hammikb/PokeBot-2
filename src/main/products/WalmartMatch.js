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
    if (candidates.length > 0) return candidates.slice(0, 3).map((c) => ({ ...c, confidence: 'name' }))
  }
  return []
}

async function searchWalmartUsable(query) {
  const results = await searchProducts(query, 'walmart')
  return results.filter((r) => !r.disabled && r.url && r.itemId)
}
