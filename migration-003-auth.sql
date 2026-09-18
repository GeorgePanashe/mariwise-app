-- Run this to add real login/accounts to an app that's already working.
-- Supabase Dashboard -> SQL Editor -> New query -> paste this -> Run
--
-- IMPORTANT: your existing business row will have owner_id = null after this
-- runs, which means it won't show up for anyone once login is required (the
-- backend only returns a business that belongs to the logged-in user). See
-- "Reclaiming your existing business" in the README for how to link it to
-- your new account after you sign up.

alter table businesses
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create unique index if not exists businesses_one_per_owner on businesses (owner_id);
