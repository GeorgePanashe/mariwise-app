-- Run this if your app was already working before the "describe a transaction"
-- feature was added. It adds a category column and allows two new
-- transaction types (owner_withdrawal, other_income) alongside your existing
-- sale/expense rows, which are untouched.
--
-- Supabase Dashboard -> SQL Editor -> New query -> paste this -> Run

alter table transactions
  add column if not exists category text;

alter table transactions
  drop constraint if exists transactions_type_check;

alter table transactions
  add constraint transactions_type_check
  check (type in ('sale','expense','owner_withdrawal','other_income'));
