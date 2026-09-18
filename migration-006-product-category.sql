-- Adds a category to products, so a sale automatically inherits a category
-- from what was actually sold (e.g. "Groceries", "Drinks") instead of every
-- sale being uncategorized. Existing products default to "General".
--
-- Supabase Dashboard -> SQL Editor -> New query -> paste this -> Run

alter table products
  add column if not exists category text default 'General';

update products set category = 'General' where category is null;
