-- The service role already bypasses RLS, but an explicit policy documents the
-- table's sole application role and keeps the Supabase RLS advisor clean.
drop policy if exists "service role manages target auto watch rules"
  on public.target_auto_watch_rules;

create policy "service role manages target auto watch rules"
on public.target_auto_watch_rules
for all
to service_role
using (true)
with check (true);
