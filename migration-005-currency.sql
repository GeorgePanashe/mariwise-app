-- Adds proper multi-currency support: every product and every transaction
-- now remembers which currency it was actually priced/paid in, so switching
-- your "Report in" currency (Settings) converts totals for viewing without
-- ever rewriting the original record. Existing rows are assumed to be in
-- your business's current currency at the time this runs.
--
-- Supabase Dashboard -> SQL Editor -> New query -> paste this -> Run

alter table products
  add column if not exists currency text default 'USD';

alter table transactions
  add column if not exists currency text default 'USD';

-- Backfill existing rows to match each business's currency at the time of
-- this migration, rather than leaving them all defaulted to 'USD'.
update products p
  set currency = b.currency
  from businesses b
  where p.business_id = b.id and p.currency is null;

update transactions t
  set currency = b.currency
  from businesses b
  where t.business_id = b.id and t.currency is null;
