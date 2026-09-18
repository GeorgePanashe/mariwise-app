-- Run this ONLY if you already created your tables from an earlier version of
-- supabase-schema.sql (i.e. your app is already working). It adds the one
-- new column needed for the ZiG exchange rate feature, without touching any
-- data you already have.
--
-- Supabase Dashboard -> SQL Editor -> New query -> paste this -> Run

alter table businesses
  add column if not exists exchange_rate numeric(12,4);

-- exchange_rate stores "ZiG per 1 USD" (e.g. 30000 means 1 USD = 30,000 ZiG).
-- It starts out empty (null) until you set it from Settings in the app.
