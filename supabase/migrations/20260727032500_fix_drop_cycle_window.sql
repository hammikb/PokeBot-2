create or replace function public.assign_drop_cycle_id()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  previous_drop public.drops%rowtype;
  current_type text := lower(coalesce(new.drop_type, 'in_stock'));
  previous_type text;
  current_is_actionable boolean;
  previous_is_actionable boolean;
  elapsed interval;
begin
  if new.drop_cycle_id is not null then
    return new;
  end if;

  if new.product_id is null then
    new.drop_cycle_id := gen_random_uuid();
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.product_id::text, 0));

  select *
  into previous_drop
  from public.drops
  where product_id = new.product_id
  order by created_at desc, id desc
  limit 1;

  previous_type := lower(coalesce(previous_drop.drop_type, ''));
  current_is_actionable := current_type in (
    'in_stock', 'restock', 'price_drop', 'preorder', 'available'
  );
  previous_is_actionable := previous_type in (
    'in_stock', 'restock', 'price_drop', 'preorder', 'available'
  );
  elapsed := coalesce(new.created_at, now()) - previous_drop.created_at;

  -- Collapse duplicate worker reports, but keep the window short enough that
  -- a later genuine restock becomes a new checkout cycle. The lower bound
  -- prevents out-of-order timestamps from being merged into a newer cycle.
  if previous_drop.id is not null
     and current_is_actionable
     and previous_is_actionable
     and elapsed >= interval '0 seconds'
     and elapsed <= interval '5 minutes'
  then
    new.drop_cycle_id := previous_drop.drop_cycle_id;
  elsif previous_drop.id is not null
        and current_type = 'queue_open'
        and previous_type = 'queue_open'
        and elapsed >= interval '0 seconds'
        and elapsed <= interval '5 minutes'
  then
    new.drop_cycle_id := previous_drop.drop_cycle_id;
  else
    new.drop_cycle_id := gen_random_uuid();
  end if;

  return new;
end;
$$;

revoke all on function public.assign_drop_cycle_id() from public, anon, authenticated;
