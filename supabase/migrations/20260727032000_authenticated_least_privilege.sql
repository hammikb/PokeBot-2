-- Electron users only need CRUD on their own RLS-scoped subscriptions,
-- read/insert access to the shared product catalog, and read access to drops.
-- In particular, TRUNCATE bypasses row-level security and must never be
-- available to an authenticated desktop client.
revoke all on table public.subscriptions from authenticated;
grant select, insert, update, delete on table public.subscriptions to authenticated;

revoke all on table public.products from authenticated;
grant select, insert on table public.products to authenticated;

revoke all on table public.drops from authenticated;
grant select on table public.drops to authenticated;

-- This SECURITY DEFINER function is a trigger implementation, not a public RPC.
revoke all on function public.sync_product_active_from_subscriptions()
  from public, anon, authenticated;
