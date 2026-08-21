-- Created with apply_patch after Supabase CLI 2.113.0 failed with
-- LegacyMigrationNewWriteError on the existing OneDrive migrations directory.

alter table public.products
  add column if not exists auto_watch boolean not null default false;

alter table public.drops
  add column if not exists source_event_id uuid;

create unique index if not exists drops_source_event_id_unique
  on public.drops (source_event_id)
  where source_event_id is not null;

alter table public.worker_health
  add column if not exists watchlist_product_count integer,
  add column if not exists watchlist_last_success_at timestamptz,
  add column if not exists alert_outbox_pending integer,
  add column if not exists last_drop_delivery_at timestamptz,
  add column if not exists last_discord_delivery_at timestamptz,
  add column if not exists last_discord_status text,
  add column if not exists last_discord_message_id text,
  add column if not exists active_schedule_profile text,
  add column if not exists schedule_next_transition_at timestamptz;

create table if not exists public.target_auto_watch_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  match_term text not null check (length(btrim(match_term)) > 0),
  priority integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.target_auto_watch_rules enable row level security;
revoke all on table public.target_auto_watch_rules from public, anon, authenticated;
grant select, insert, update, delete on table public.target_auto_watch_rules to service_role;

insert into public.target_auto_watch_rules (name, match_term, priority, enabled)
values
  ('Prismatic Evolutions', 'Prismatic Evolutions', 200, true),
  ('Ascended Heroes', 'Ascended Heroes', 100, true)
on conflict (name) do update
set match_term = excluded.match_term,
    priority = excluded.priority,
    enabled = excluded.enabled,
    updated_at = now();

create or replace function public.refresh_target_auto_watch_products()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_count integer := 0;
begin
  -- Catalog and rule triggers can fire concurrently. Serialize refreshes so an
  -- older invocation cannot clear a newer invocation's selected hot set.
  perform pg_catalog.pg_advisory_xact_lock(95163306);

  update public.products
  set auto_watch = false
  where retailer = 'target'
    and auto_watch = true;

  with best_matches as (
    select distinct on (catalog.product_key)
      catalog.product_key,
      catalog.name,
      catalog.last_seen_at,
      rules.priority
    from public.target_catalog as catalog
    join public.target_auto_watch_rules as rules
      on rules.enabled
     and position(lower(rules.match_term) in lower(catalog.name)) > 0
    where catalog.is_marketplace = false
    order by catalog.product_key, rules.priority desc, catalog.last_seen_at desc
  ), selected as (
    select product_key, name
    from best_matches
    order by priority desc, last_seen_at desc, product_key
    limit 50
  )
  insert into public.products (
    retailer, product_key, product_url, name, active, pinned, auto_watch
  )
  select
    'target',
    selected.product_key,
    'https://www.target.com/p/-/A-' || selected.product_key,
    selected.name,
    true,
    false,
    true
  from selected
  on conflict (retailer, product_key) do update
  set product_url = excluded.product_url,
      name = excluded.name,
      auto_watch = true,
      active = true;

  get diagnostics selected_count = row_count;

  update public.products as product
  set active = product.pinned
            or product.auto_watch
            or exists (
              select 1
              from public.subscriptions as subscription
              where subscription.product_id = product.id
            )
  where product.retailer = 'target';

  return selected_count;
end;
$$;

create or replace function public.admin_set_product_pinned(
  p_id uuid,
  p_pinned boolean
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products as product
  set pinned = p_pinned,
      active = p_pinned
            or product.auto_watch
            or exists (
              select 1
              from public.subscriptions as subscription
              where subscription.product_id = p_id
            )
  where product.id = p_id;
$$;

create or replace function public.sync_product_active_from_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_id uuid;
begin
  affected_id := coalesce(new.product_id, old.product_id);

  update public.products as product
  set active = product.pinned
            or product.auto_watch
            or exists (
              select 1
              from public.subscriptions as subscription
              where subscription.product_id = affected_id
            )
  where product.id = affected_id;

  return coalesce(new, old);
end;
$$;

create or replace function public.refresh_target_auto_watch_products_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_target_auto_watch_products();
  return null;
end;
$$;

drop trigger if exists target_catalog_refresh_auto_watch on public.target_catalog;
create trigger target_catalog_refresh_auto_watch
after insert or update or delete on public.target_catalog
for each statement execute function public.refresh_target_auto_watch_products_trigger();

drop trigger if exists target_auto_watch_rules_refresh on public.target_auto_watch_rules;
create trigger target_auto_watch_rules_refresh
after insert or update or delete on public.target_auto_watch_rules
for each statement execute function public.refresh_target_auto_watch_products_trigger();

create or replace function public.target_inventory_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_product_id uuid;
begin
  select product.id
  into target_product_id
  from public.products as product
  where product.retailer = 'target'
    and product.product_key = new.tcin
  limit 1;

  if target_product_id is not null then
    perform realtime.send(
      to_jsonb(new) || jsonb_build_object('product_id', target_product_id),
      'inventory',
      'drops:product:' || target_product_id,
      true
    );
  end if;

  return new;
end;
$$;

drop trigger if exists target_inventory_broadcast on public.target_inventory_observations;
create trigger target_inventory_broadcast
after insert on public.target_inventory_observations
for each row execute function public.target_inventory_broadcast();

drop policy if exists "authenticated reads target inventory"
  on public.target_inventory_observations;
drop policy if exists "subscribed users read target inventory"
  on public.target_inventory_observations;
create policy "subscribed users read target inventory"
on public.target_inventory_observations
for select
to authenticated
using (
  exists (
    select 1
    from public.products as product
    join public.subscriptions as subscription
      on subscription.product_id = product.id
    where product.retailer = 'target'
      and product.product_key = target_inventory_observations.tcin
      and subscription.user_id = (select auth.uid())
  )
);

grant select on table public.target_inventory_observations to authenticated;

select public.refresh_target_auto_watch_products();

revoke all on function public.refresh_target_auto_watch_products() from public, anon, authenticated;
revoke all on function public.refresh_target_auto_watch_products_trigger() from public, anon, authenticated;
revoke all on function public.target_inventory_broadcast() from public, anon, authenticated;
revoke all on function public.sync_product_active_from_subscriptions() from public, anon, authenticated;
revoke all on function public.admin_set_product_pinned(uuid, boolean) from public, anon, authenticated;
