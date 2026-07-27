-- Realtime Broadcast is the fast path. This composite index keeps the
-- authenticated catch-up query cheap after startup or a channel reconnect.
create index if not exists idx_drops_product_created_id
  on public.drops (product_id, created_at, id);

-- Electron only needs the aggregate worker snapshot. Raw worker commands,
-- credentials, and logs remain service-role-only.
grant select on table public.monitor_snapshots to authenticated;

-- This legacy deny-all policy targeted anon/authenticated. Once the explicit
-- authenticated read policy exists it is redundant; writes still default-deny,
-- and service_role continues to bypass RLS.
drop policy if exists "service role only"
  on public.monitor_snapshots;

drop policy if exists "authenticated reads monitor snapshots"
  on public.monitor_snapshots;

create policy "authenticated reads monitor snapshots"
  on public.monitor_snapshots
  for select
  to authenticated
  using (true);
