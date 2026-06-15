export function mapCatalogItemToProductRow(item) {
  return {
    retailer: item.retailer,
    product_url: item.product_url,
    product_key: item.retailer_item_id,
    name: item.title,
    active: true
  }
}

// Upsert on the (retailer, product_key) unique constraint so two users adding the
// same item share one monitored product. Returns the row id (new or existing).
export async function pushCatalogItemToSupabase({ client, item }) {
  const row = mapCatalogItemToProductRow(item)
  const { data, error } = await client
    .from('products')
    .upsert(row, { onConflict: 'retailer,product_key' })
    .select()
    .single()
  if (error) throw new Error(`Supabase product publish failed: ${error.message}`)
  return { productId: data.id }
}
