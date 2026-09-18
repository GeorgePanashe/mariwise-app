-- Run this to add supplier-debt tracking to an app that's already working.
-- Supabase Dashboard -> SQL Editor -> New query -> paste this -> Run

alter table transactions
  add column if not exists supplier text,
  add column if not exists owed_to_supplier numeric(12,2) default 0;

alter table transactions
  drop constraint if exists transactions_type_check;

alter table transactions
  add constraint transactions_type_check
  check (type in ('sale','expense','owner_withdrawal','other_income','customer_payment','supplier_payment'));
