// Extracts the stable retailer identifier (Target TCIN / Walmart itemId) from a
// product URL. Used to match a local task to a Supabase `products` row by
// (retailer, product_key). Mirrors the parsing in ProductCatalog so a task and a
// published catalog item resolve to the same key.
export function extractProductKey(retailer, productUrl) {
  if (retailer === 'target') {
    return String(productUrl || '').match(/A-(\d+)/)?.[1] || null
  }
  if (retailer === 'walmart') {
    try {
      return new URL(productUrl).pathname.split('/').filter(Boolean).pop() || null
    } catch {
      return String(productUrl || '').split('/').pop()?.split('?')[0] || null
    }
  }
  return null
}
