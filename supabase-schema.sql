-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run
-- (If you're updating an already-working app instead, use the migration-*.sql
-- files in this folder rather than re-running this whole file.)

create extension if not exists "pgcrypto";

create table businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  type text,
  currency text default 'USD',
  language text default 'en',
  exchange_rate numeric(12,4), -- ZiG per 1 USD, set by the owner in-app
  created_at timestamptz default now()
);
create unique index businesses_one_per_owner on businesses (owner_id);

create table products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  name text not null,
  unit text default 'piece',
  price numeric(12,2) default 0,
  cost numeric(12,2) default 0,
  currency text default 'USD', -- the currency this product's price/cost are quoted in
  category text default 'General', -- e.g. Groceries, Drinks, Hardware — sales auto-inherit this
  stock integer default 0,
  low_stock integer default 3,
  created_at timestamptz default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  type text not null check (type in ('sale','expense','owner_withdrawal','other_income','customer_payment','supplier_payment')),
  amount numeric(12,2) not null,
  currency text default 'USD', -- the currency this transaction actually happened in — never changed after the fact
  cost numeric(12,2) default 0,
  description text,
  category text, -- e.g. Rent, Wages, Transport, Stock & Supplies, Utilities, Marketing, Other (expenses only)
  payment_method text,
  customer text,
  owed numeric(12,2) default 0,          -- for a credit sale: how much that sale left outstanding
  supplier text,                          -- for an expense bought on credit, or a supplier_payment
  owed_to_supplier numeric(12,2) default 0, -- for an expense bought on credit: how much is still owed
  created_at timestamptz default now()
);

create index on products (business_id);
create index on transactions (business_id);

-- Auth & data isolation:
-- Every business has an owner_id (a real Supabase Auth user). The backend
-- (server.js) verifies each request's login token with supabase.auth.getUser()
-- and checks business ownership in application code (assertOwnsBusiness)
-- before any read or write — that's what actually keeps one owner's data
-- from another's right now, since the backend uses the service-role key
-- (which bypasses Postgres Row Level Security entirely).
--
-- RLS itself is left OFF here on purpose: it would be redundant with the
-- checks above as long as only this backend talks to these tables. If you
-- ever let the browser query Supabase directly (skipping server.js) — e.g.
-- for realtime updates — add RLS policies like:
--   using (business_id in (select id from businesses where owner_id = auth.uid()))
-- before doing that, since at that point app-code checks no longer apply.
