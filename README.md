# MariWise — local prototype (real DB + real free AI + real login)

One Node server serves the frontend and talks to Supabase (Postgres + Auth)
for storage and accounts, and Groq's free Llama model for the AI features.

## Fresh install (never run this app before)

### 1. Install Node.js
Download the LTS installer from https://nodejs.org. Check it worked:

    node -v      # should print v18 or higher

### 2. Create a free Supabase project
1. Go to https://supabase.com → sign up → "New project".
2. Once it's created, open **SQL Editor → New query**, paste the entire
   contents of `supabase-schema.sql` from this folder, and click **Run**.
3. Go to **Project Settings → API Keys**. You need two of the keys shown there:
   - **Publishable key** (starts `sb_publishable_...`, sometimes just called
     "anon key") — safe to expose in the browser, used for login/signup.
   - **Secret key** (starts `sb_secret_...`, sometimes called "service_role")
     — full access, used only by the backend, never sent to the browser.
   Also grab your **Project URL** from the same page (or General settings).
4. Confirm email is off by default on new projects in most cases, which
   means signup logs you straight in. If your project has "Confirm email"
   turned on (Authentication → Providers → Email), you'll need to click the
   confirmation link Supabase emails you before your first login works.

### 3. Get a free Groq API key
Go to https://console.groq.com → sign up (free) → **API Keys → Create key**.
Copy it immediately — it's shown once.

### 4. Configure the app
    cd mariwise-app
    cp .env.example .env

Open `.env` and fill in all four values:

    SUPABASE_URL=...
    SUPABASE_SERVICE_KEY=...      (the secret key)
    SUPABASE_ANON_KEY=...          (the publishable key)
    GROQ_API_KEY=...

### 5. Install and run
    npm install
    npm start

Open **http://localhost:3001**. Create an account (email + password), then
set up your business. Everything — your account, business, products, sales,
expenses — is now real data in Supabase, not localStorage.

---

## Upgrading an existing install

If you already had MariWise running before login/accounts existed, run
these against your existing Supabase project (SQL Editor → New query → Run),
**one at a time, in order** — skip any you've already run in a previous
update:

1. `migration-001-exchange-rate.sql`
2. `migration-002-transaction-types.sql`
3. `migration-003-auth.sql`
4. `migration-004-supplier-payments.sql`
5. `migration-005-currency.sql`

Then add `SUPABASE_ANON_KEY` to your existing `.env` (get it from Supabase →
Project Settings → API Keys → "Publishable key" — see step 2 above), stop
the server, replace your files with this version (keeping your `.env`), and
`npm start` again.

### Reclaiming your existing business
Your old business row has no owner — accounts didn't exist yet when you
created it — so after this update it won't show up when you log in (each
account only ever sees its own business). To link it to your new account:

1. Register your account in the app once (so it exists in Supabase).
2. In Supabase, go to **Authentication → Users** and copy your new user's ID.
3. In Supabase, go to **Table Editor → businesses** and copy your existing
   business's `id`.
4. Run this in the SQL Editor, with both values swapped in:

       update businesses
       set owner_id = 'paste-your-user-id-here'
       where id = 'paste-your-business-id-here';

5. Refresh the app and log in — your original business, products, and
   transaction history should now load.

---

## What's real vs still a shortcut
- **Real:** Supabase Postgres persistence; Supabase Auth (real accounts,
  real passwords, real sessions — works across devices/browsers once logged
  in); a real free LLM (Groq) for "Ask MariWise", the Learn section, and
  interpreting free-text transaction descriptions; server-side ownership
  checks so one account can't read or write another's data; server-side
  calculation of totals/stock so the client can't fake numbers; genuine
  dual-currency support (see below).
- **Still a shortcut:** Row Level Security is off at the database level —
  isolation is enforced in `server.js` instead (see the note at the bottom
  of `supabase-schema.sql` for why, and when you'd want to add RLS too); one
  business per account; no offline sync; no password reset flow yet (Supabase
  supports it, just not wired into this UI); this is a browser app, not the
  native Flutter/Android app from the original spec.

## How currency works
Every product and every transaction remembers the currency it was actually
priced or paid in — that record never changes. The dropdown in the top bar
picks which currency you want to *view* totals in ("report in"); switching
it never rewrites anything, it only changes how figures are converted for
display, using the exchange rate you set in Settings.

- A sale can only mix products priced the same way — if you stock items in
  both USD and ZiG, the sale screen shows a currency picker and filters the
  product list to match.
- The Transactions list always shows each entry's real, original amount and
  currency, with a small converted equivalent underneath when it differs
  from your report currency — nothing there is ever distorted.
- Dashboard totals and "Ask MariWise" both convert everything into your
  report currency before adding it up. If something can't be converted
  (different currency, no rate set), you'll see a warning banner rather than
  a silently wrong number.

## Optional: fully offline AI (no signup, no internet needed for AI calls)
Run a free local model with Ollama instead of Groq:

1. Install Ollama from https://ollama.com.
2. `ollama pull llama3.2` (or a smaller model if your machine is limited).
3. In `server.js`, swap the Groq fetch calls for
   `http://localhost:11434/api/chat` (Ollama's local API) with the same
   system/user message shape. Everything else (Supabase, the routes) stays
   the same.
