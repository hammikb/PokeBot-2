-- Broadcast every Walmart queue opening to one private, authenticated topic.
-- Product-specific broadcasts remain unchanged for normal task monitoring.
create or replace function public.drops_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    to_jsonb(new),
    'drop',
    'drops:product:' || new.product_id,
    true
  );

  if lower(new.retailer) = 'walmart' and lower(new.drop_type) = 'queue_open' then
    perform realtime.send(
      to_jsonb(new),
      'drop',
      'drops:retailer:walmart:queues',
      true
    );
  end if;

  return new;
end;
$$;

drop policy if exists "authenticated users receive Walmart queue alerts"
  on realtime.messages;

create policy "authenticated users receive Walmart queue alerts"
on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and topic = 'drops:retailer:walmart:queues'
);

drop policy if exists "authenticated users read Walmart queue drops"
  on public.drops;

create policy "authenticated users read Walmart queue drops"
on public.drops
for select
to authenticated
using (
  lower(retailer) = 'walmart'
  and lower(drop_type) = 'queue_open'
);
