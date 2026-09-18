require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');

const app = express();
app.use(express.json());
app.use(express.static('public'));

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_SERVICE_KEY are not set — copy .env.example to .env and fill them in.');
}
if (!process.env.SUPABASE_ANON_KEY) {
  console.warn('⚠️  SUPABASE_ANON_KEY is not set — login/register won\'t work until you add it.');
}
if (!process.env.GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY is not set — the AI features will fail until you add a free key from console.groq.com.');
}

// Service-role client: full access, used for every actual data read/write.
// Ownership is enforced in application code below (see requireAuth /
// assertOwnsBusiness), not by Postgres RLS — see supabase-schema.sql for why.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// llama-3.1-8b-instant was deprecated by Groq on 2026-08-16. Current free,
// fast replacement per Groq's own migration guidance:
const GROQ_MODEL = 'openai/gpt-oss-20b';

async function callGroq(systemPrompt, userMessage, jsonMode) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: jsonMode ? 0.1 : 0.4,
      // gpt-oss-20b is a reasoning model: it spends tokens "thinking" before
      // writing the answer. Strict response_format:"json_object" plus a small
      // max_tokens budget made it run out of room mid-thought and return
      // nothing (Groq's "json_validate_failed" with an empty failed_generation
      // — a known issue with this model). Asking in plain text with a low
      // reasoning effort and generous headroom, then parsing the JSON out of
      // the reply ourselves, is far more reliable.
      max_tokens: jsonMode ? 600 : 500,
      ...(jsonMode ? { reasoning_effort: 'low' } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}
const askGroq = (sys, msg) => callGroq(sys, msg, false);

// Converts an amount from one currency to another using the business's saved
// rate (ZiG per 1 USD). Returns {value, ok, converted} — ok is false when a
// conversion was needed but no rate has been set, so callers can flag it
// instead of silently pretending 1 ZiG = 1 USD.
function convertAmount(amount, fromCurrency, toCurrency, rate) {
  const from = fromCurrency || 'USD';
  if (from === toCurrency) return { value: Number(amount) || 0, ok: true, converted: false };
  if (!rate) return { value: Number(amount) || 0, ok: false, converted: false };
  if (from === 'USD' && toCurrency === 'ZiG') return { value: (Number(amount) || 0) * rate, ok: true, converted: true };
  if (from === 'ZiG' && toCurrency === 'USD') return { value: (Number(amount) || 0) / rate, ok: true, converted: true };
  return { value: Number(amount) || 0, ok: false, converted: false };
}

// Turns a natural-language time reference (as classified by the intent step)
// into concrete from/to dates, so "how much did I make this week" actually
// queries this week, not a generic all-time blob.
function periodBounds(period, customFrom, customTo, businessCreatedAt) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = iso(now);
  switch (period) {
    case 'today': return { from: todayIso, to: todayIso };
    case 'yesterday': { const y = new Date(now); y.setDate(y.getDate() - 1); return { from: iso(y), to: iso(y) }; }
    case 'this_week': { const m = new Date(now); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return { from: iso(m), to: todayIso }; }
    case 'last_week': { const m = new Date(now); m.setDate(m.getDate() - ((m.getDay() + 6) % 7) - 7); const s = new Date(m); s.setDate(m.getDate() + 6); return { from: iso(m), to: iso(s) }; }
    case 'this_month': { const f = new Date(now.getFullYear(), now.getMonth(), 1); return { from: iso(f), to: todayIso }; }
    case 'last_month': { const f = new Date(now.getFullYear(), now.getMonth() - 1, 1); const l = new Date(now.getFullYear(), now.getMonth(), 0); return { from: iso(f), to: iso(l) }; }
    case 'custom': if (customFrom && customTo) return { from: customFrom, to: customTo }; // else fall through
    case 'all_time':
    default: return { from: (businessCreatedAt || '2000-01-01').slice(0, 10), to: todayIso };
  }
}

// Computes exact figures for a specific date range — the same shape of
// summary whether it's answering a chat question or building a PDF report,
// so "what did I ask" and "what got computed" always match precisely.
function summarizeRange(txns, products, reportCurrency, rate, from, to) {
  let unconverted = 0;
  const c = (amount, fromCurrency) => {
    const r = convertAmount(amount, fromCurrency, reportCurrency, rate);
    if (!r.ok) unconverted++;
    return r.value;
  };
  const inRange = txns.filter(t => { const d = t.created_at.slice(0, 10); return d >= from && d <= to; });
  const upToEnd = txns.filter(t => t.created_at.slice(0, 10) <= to);
  const sumType = (list, type) => list.filter(t => t.type === type).reduce((s, t) => s + c(t.amount, t.currency), 0);

  const sales = sumType(inRange, 'sale');
  const cost = inRange.filter(t => t.type === 'sale').reduce((s, t) => s + c(t.cost || 0, t.currency), 0);
  const grossProfit = sales - cost;
  const expenses = sumType(inRange, 'expense');
  const otherIncome = sumType(inRange, 'other_income');
  const withdrawals = sumType(inRange, 'owner_withdrawal');
  const netProfit = grossProfit - expenses + otherIncome;

  const groupBy = (list, type, keyField, amountField) => {
    const out = {};
    list.filter(t => t.type === type).forEach(t => {
      const k = t[keyField] || 'Uncategorized';
      out[k] = (out[k] || 0) + c(t[amountField] ?? t.amount, t.currency);
    });
    return out;
  };
  const expCat = groupBy(inRange, 'expense', 'category', 'amount');
  const incCat = groupBy(inRange, 'other_income', 'category', 'amount');
  const salesCat = groupBy(inRange, 'sale', 'category', 'amount');

  const custTotals = {};
  upToEnd.filter(t => t.type === 'sale' && Number(t.owed || 0) > 0).forEach(t => {
    const k = t.customer || 'Unspecified customer'; custTotals[k] = (custTotals[k] || 0) + c(t.owed, t.currency);
  });
  upToEnd.filter(t => t.type === 'customer_payment').forEach(t => {
    const k = t.customer || 'Unspecified customer'; custTotals[k] = (custTotals[k] || 0) - c(t.amount, t.currency);
  });
  const suppTotals = {};
  upToEnd.filter(t => t.type === 'expense' && Number(t.owed_to_supplier || 0) > 0).forEach(t => {
    const k = t.supplier || 'Unspecified supplier'; suppTotals[k] = (suppTotals[k] || 0) + c(t.owed_to_supplier, t.currency);
  });
  upToEnd.filter(t => t.type === 'supplier_payment').forEach(t => {
    const k = t.supplier || 'Unspecified supplier'; suppTotals[k] = (suppTotals[k] || 0) - c(t.amount, t.currency);
  });

  const lowStock = (products || []).filter(p => p.stock <= p.low_stock).map(p => `${p.name} (${p.stock} ${p.unit} left)`);

  return { sales, cost, grossProfit, expenses, otherIncome, withdrawals, netProfit, expCat, incCat, salesCat, custTotals, suppTotals, lowStock, unconverted };
}
function fmtEntries(obj) {
  return Object.entries(obj).filter(([, v]) => Math.abs(v) > 0.005).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(', ') || 'none';
}

// Pulls a JSON object out of a plain-text model reply: strips ```json fences
// if present, then grabs the first {...} block. Retries once with a firmer
// instruction if the first attempt doesn't parse.
function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const braceMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonStr = braceMatch ? braceMatch[0] : candidate.trim();
  try { return JSON.parse(jsonStr); } catch (e) { return null; }
}
async function askGroqJSON(systemPrompt, userMessage) {
  const jsonSystem = systemPrompt + '\n\nRespond with ONLY the JSON object — no explanation, no markdown code fences, no extra text before or after it.';
  const raw = await callGroq(jsonSystem, userMessage, true);
  let parsed = extractJSON(raw);
  if (parsed) return parsed;
  // one retry, spelling it out even more plainly
  const raw2 = await callGroq(jsonSystem + '\n\nYour last reply was not valid JSON. Try again — output must start with { and end with }, nothing else.', userMessage, true);
  parsed = extractJSON(raw2);
  if (parsed) return parsed;
  throw new Error("The AI couldn't produce a valid answer for that. Try rephrasing it more simply.");
}

/* ---------------- Auth ---------------- */
// Frontend fetches this once on load to set up its own (browser-safe) Supabase
// client for login/signup. The anon key is meant to be public — it can only
// do what your RLS policies (or lack of matching backend calls) allow.
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

// Every /api/* route below (except /api/config) requires a valid Supabase
// session. The frontend sends the user's access token as a Bearer header;
// we verify it against Supabase Auth and attach req.user.
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Your session has expired — please log in again.' });
  req.user = data.user;
  next();
}
app.use('/api', (req, res, next) => {
  if (req.path === '/config') return next();
  requireAuth(req, res, next);
});

// Confirms the logged-in user actually owns this business before any read
// or write touches it. Returns the business row on success.
async function assertOwnsBusiness(business_id, user_id) {
  if (!business_id) throw new Error('Missing business_id');
  const { data, error } = await supabase.from('businesses').select().eq('id', business_id).single();
  if (error || !data) throw new Error('Business not found');
  if (data.owner_id !== user_id) throw new Error('You do not have access to this business');
  return data;
}

/* ---------------- Business ---------------- */
app.get('/api/my-business', async (req, res) => {
  const { data, error } = await supabase.from('businesses').select().eq('owner_id', req.user.id).maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || null);
});

app.post('/api/business', async (req, res) => {
  const { name, type, currency, language } = req.body;
  const { data: existing } = await supabase.from('businesses').select('id').eq('owner_id', req.user.id).maybeSingle();
  if (existing) return res.status(400).json({ error: 'You already have a business set up.' });
  const { data, error } = await supabase
    .from('businesses')
    .insert({ name, type, currency, language, owner_id: req.user.id })
    .select()
    .single();
  if (error) {
    if (/owner_id/i.test(error.message)) {
      return res.status(400).json({ error: `${error.message} — run migration-003-auth.sql in your Supabase SQL Editor, then try again.` });
    }
    return res.status(400).json({ error: error.message });
  }
  res.json(data);
});

app.get('/api/business/:id', async (req, res) => {
  try {
    const biz = await assertOwnsBusiness(req.params.id, req.user.id);
    res.json(biz);
  } catch (e) { res.status(403).json({ error: e.message }); }
});

app.put('/api/business/:id', async (req, res) => {
  try {
    await assertOwnsBusiness(req.params.id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { currency, language, name, type, exchange_rate } = req.body;
  const update = {};
  if (currency) update.currency = currency;
  if (language) update.language = language;
  if (name) update.name = name;
  if (type) update.type = type;
  if (exchange_rate !== undefined) update.exchange_rate = exchange_rate === null ? null : Number(exchange_rate);
  const { data, error } = await supabase
    .from('businesses')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    if (/exchange_rate/i.test(error.message)) {
      return res.status(400).json({ error: `${error.message} — run migration-001-exchange-rate.sql in your Supabase SQL Editor, then try again.` });
    }
    return res.status(400).json({ error: error.message });
  }
  res.json(data);
});

/* ---------------- Products ---------------- */
app.get('/api/products', async (req, res) => {
  try {
    await assertOwnsBusiness(req.query.business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { data, error } = await supabase
    .from('products')
    .select()
    .eq('business_id', req.query.business_id)
    .order('created_at');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/products', async (req, res) => {
  const { business_id, name, unit, price, cost, stock, low_stock, currency, category } = req.body;
  try {
    await assertOwnsBusiness(business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { data, error } = await supabase
    .from('products')
    .insert({ business_id, name, unit, price, cost, stock, low_stock, currency: currency || 'USD', category: category || 'General' })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.put('/api/products/:id', async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('business_id').eq('id', req.params.id).single();
  if (findErr || !existing) return res.status(404).json({ error: 'Product not found' });
  try {
    await assertOwnsBusiness(existing.business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { name, unit, price, cost, stock, low_stock, currency, category } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (unit !== undefined) update.unit = unit;
  if (price !== undefined) update.price = price;
  if (cost !== undefined) update.cost = cost;
  if (stock !== undefined) update.stock = stock;
  if (low_stock !== undefined) update.low_stock = low_stock;
  if (currency !== undefined) update.currency = currency;
  if (category !== undefined) update.category = category;
  const { data, error } = await supabase
    .from('products')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/products/:id', async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('business_id').eq('id', req.params.id).single();
  if (findErr || !existing) return res.status(404).json({ error: 'Product not found' });
  try {
    await assertOwnsBusiness(existing.business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

/* ---------------- Transactions ---------------- */
app.get('/api/transactions', async (req, res) => {
  try {
    await assertOwnsBusiness(req.query.business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { data, error } = await supabase
    .from('transactions')
    .select()
    .eq('business_id', req.query.business_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/sale', async (req, res) => {
  const { business_id, items, pay, customer } = req.body;
  try {
    await assertOwnsBusiness(business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  if (!items || !items.length) return res.status(400).json({ error: 'No items in sale' });

  let total = 0, costTotal = 0, descParts = [], saleCurrency = null, saleCategory = null, categoryMixed = false;
  for (const item of items) {
    const { data: product, error: pErr } = await supabase
      .from('products').select().eq('id', item.product_id).single();
    if (pErr || !product) return res.status(400).json({ error: 'Product not found' });
    if (product.stock < item.qty) {
      return res.status(400).json({ error: `Only ${product.stock} ${product.unit} of ${product.name} left in stock` });
    }
    const pCurrency = product.currency || 'USD';
    if (saleCurrency && pCurrency !== saleCurrency) {
      return res.status(400).json({ error: `This sale mixes ${saleCurrency} and ${pCurrency} priced products — split it into separate sales, one per currency.` });
    }
    saleCurrency = pCurrency;
    const pCategory = product.category || 'General';
    if (saleCategory === null) saleCategory = pCategory;
    else if (saleCategory !== pCategory) categoryMixed = true;
    total += product.price * item.qty;
    costTotal += product.cost * item.qty;
    descParts.push(`${item.qty} ${product.unit} ${product.name}`);

    const { error: uErr } = await supabase
      .from('products').update({ stock: product.stock - item.qty }).eq('id', product.id);
    if (uErr) return res.status(400).json({ error: uErr.message });
  }

  const owed = pay === 'Credit (customer owes)' ? total : 0;
  const { data: txn, error: tErr } = await supabase
    .from('transactions')
    .insert({
      business_id, type: 'sale', amount: total, cost: costTotal, currency: saleCurrency || 'USD',
      category: categoryMixed ? 'Mixed' : (saleCategory || 'General'),
      description: descParts.join(', '), payment_method: pay, customer, owed,
    })
    .select().single();
  if (tErr) return res.status(400).json({ error: tErr.message });
  res.json(txn);
});

// Generic recorder for the "describe what happened" flow, and for anything
// that isn't a stock-linked POS sale (which goes through /api/sale instead):
// business expenses (optionally bought on credit from a supplier), owner
// withdrawals, other income, and payments that settle a customer's or
// supplier's outstanding balance.
const TXN_TYPES = ['expense', 'owner_withdrawal', 'other_income', 'customer_payment', 'supplier_payment'];
const CATEGORIZED_TYPES = ['expense', 'other_income'];
app.post('/api/transactions', async (req, res) => {
  const { business_id, type, amount, category, desc, pay, supplier, on_credit, customer, currency } = req.body;
  try {
    await assertOwnsBusiness(business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  if (!TXN_TYPES.includes(type)) return res.status(400).json({ error: 'Unsupported transaction type' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
  if (!desc || !desc.trim()) return res.status(400).json({ error: 'Every transaction needs a short description.' });
  if (CATEGORIZED_TYPES.includes(type) && !category) {
    return res.status(400).json({ error: 'Please choose a category — every expense and other-income entry must be classified.' });
  }

  const row = { business_id, type, amount, currency: currency || 'USD', description: desc, payment_method: pay };
  if (CATEGORIZED_TYPES.includes(type)) row.category = category;
  if (type === 'expense') {
    // Track "bought on credit" by the flag itself, not by whether a supplier
    // name happened to be given — a debt is still a debt even unnamed.
    if (on_credit) {
      row.owed_to_supplier = Number(amount) || 0;
      row.supplier = supplier || null;
    }
  }
  if (type === 'customer_payment' && customer) row.customer = customer;
  if (type === 'supplier_payment' && supplier) row.supplier = supplier;

  const { data, error } = await supabase.from('transactions').insert(row).select().single();
  if (error) {
    if (/category|supplier|owed_to_supplier|currency/i.test(error.message)) {
      return res.status(400).json({ error: `${error.message} — run the migration-*.sql files in your Supabase SQL Editor, then try again.` });
    }
    return res.status(400).json({ error: error.message });
  }
  res.json(data);
});

/* ---------------- AI (real model, grounded on real Supabase data) ---------------- */

// Turns a plain-language description ("paid rent 50 cash") into a structured
// suggestion. Nothing is saved here — the frontend shows this for the owner
// to check and edit, and only /api/transactions actually writes a row.
app.post('/api/interpret', async (req, res) => {
  const { description } = req.body;
  if (!description || !description.trim()) return res.status(400).json({ error: 'Please describe what happened.' });
  try {
    const system = `You convert a small business owner's plain description of something that happened in their business into structured JSON for bookkeeping. The owner has no accounting background and writes casually, often in Zimbabwean English.

Return ONLY a JSON object with exactly these fields:
{
  "type": "expense" | "owner_withdrawal" | "other_income" | "customer_payment" | "supplier_payment",
  "amount": <number, the money amount mentioned, or null if none was mentioned>,
  "currency": "USD" | "ZiG" | null (null if not stated — look for $, "dollars", "USD" for USD, or "ZiG", "Zimbabwe Gold", "zig" for ZiG),
  "category": <for type "expense", one of "Rent","Wages","Transport","Stock & Supplies","Utilities","Marketing","Other"; for type "other_income", one of "Loan","Grant or Donation","Refund","Owner Contribution","Interest","Other"; otherwise null>,
  "on_credit": <true if type is "expense" AND the owner says they bought this on credit / owe a supplier for it / haven't paid for it yet, otherwise false>,
  "supplier": <the supplier's name if one was mentioned (for an on-credit expense or a supplier_payment), otherwise null>,
  "customer": <the customer's name if one was mentioned (for a customer_payment), otherwise null>,
  "description": <a short, clean 3-8 word description of what happened>,
  "needs_clarification": <true if the amount is missing or the type is genuinely ambiguous, otherwise false>
}

Guidance:
- Money the owner spent running the business (rent, wages/salaries paid to staff, transport/fuel, buying supplies or equipment, utilities, marketing, repairs) is "expense". If they bought it on credit / haven't paid the supplier yet / owe someone for it, set on_credit to true and capture the supplier name if given.
- Money the owner personally took out of the business for themselves, not a business cost, is "owner_withdrawal".
- Money that came INTO the business that is NOT a sale of products (a loan received, a refund, a grant) is "other_income".
- A customer paying back money they previously owed (settling a debt from an earlier credit sale) is "customer_payment" — this is NOT new sales revenue.
- The owner paying money to a supplier to settle what they owe (reducing a previous on-credit purchase) is "supplier_payment" — this is NOT a new expense, since the expense was already recorded when the goods were bought.
- Never invent an amount that wasn't stated.`;
    const parsed = await askGroqJSON(system, description);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ask', async (req, res) => {
  const { business_id, question, mode } = req.body;
  try {
    if (mode === 'learn') {
      const system = `You are a patient financial literacy tutor for small business owners in Zimbabwe with no formal accounting background. Explain concepts in plain, everyday language with a short local small-business example (a tuckshop, market stall, or salon). If you use a financial term, explain it in one simple sentence. Use a short bullet list with **bold** on key terms if it helps clarity; otherwise plain short paragraphs. No headers, no tables. Keep the whole answer under 150 words.`;
      const answer = await askGroq(system, question);
      return res.json({ answer });
    }

    try {
      await assertOwnsBusiness(business_id, req.user.id);
    } catch (e) { return res.status(403).json({ error: e.message }); }

    const { data: biz } = await supabase.from('businesses').select('currency, exchange_rate, created_at').eq('id', business_id).single();
    const reportCurrency = biz?.currency || 'USD';
    const rate = biz?.exchange_rate;
    const { data: txnsRaw } = await supabase.from('transactions').select().eq('business_id', business_id);
    const { data: products } = await supabase.from('products').select().eq('business_id', business_id);
    const txns = txnsRaw || [];
    const today = new Date().toISOString().slice(0, 10);

    // Stage 1 — NLP intent extraction: work out what they're actually asking
    // about (topic, time period, and any specific name mentioned) before
    // touching the data, instead of always handing the model one generic
    // everything-blob regardless of the question.
    const intentSystem = `Extract the intent behind a small business owner's question about their own business records. Today's date is ${today}. Return ONLY a JSON object:
{
  "topic": "sales" | "profit" | "expenses" | "other_income" | "customer_debt" | "supplier_debt" | "stock" | "category_breakdown" | "report" | "general",
  "period": "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "all_time" | "custom",
  "from": <"YYYY-MM-DD" ONLY if period is "custom" and a specific start date was stated, else null>,
  "to": <"YYYY-MM-DD" ONLY if period is "custom" and a specific end date was stated, else null>,
  "entity": <the specific customer name, supplier name, or product/category name mentioned, if any — else null>
}
If no time period is implied, use "all_time" for questions about totals/profit/overall standing, or "today" if the question clearly means right now.`;
    let intent;
    try {
      intent = await askGroqJSON(intentSystem, question);
    } catch (e) {
      intent = { topic: 'general', period: 'all_time', from: null, to: null, entity: null };
    }
    const bounds = periodBounds(intent.period, intent.from, intent.to, biz?.created_at);

    // Stage 2 — compute the EXACT figures for that specific period, no more
    // and no less, so the final answer is grounded in precisely what was asked.
    const s = summarizeRange(txns, products, reportCurrency, rate, bounds.from, bounds.to);

    const periodLabel = bounds.from === bounds.to ? bounds.from : `${bounds.from} to ${bounds.to}`;
    const conversionNote = s.unconverted > 0
      ? ` NOTE: ${s.unconverted} record(s) in this period were in a different currency and could NOT be converted because no exchange rate is saved (Settings) — figures may be understated. Mention this if relevant.`
      : '';
    let context = `Report currency: ${reportCurrency}. This answer covers the period ${periodLabel} (interpreted from the question as "${intent.period}") — state this period plainly in your answer so it's clear which numbers these are.${conversionNote}
Sales: ${s.sales.toFixed(2)}. Cost of goods sold: ${s.cost.toFixed(2)}. Gross profit: ${s.grossProfit.toFixed(2)}. Expenses: ${s.expenses.toFixed(2)}. Other income: ${s.otherIncome.toFixed(2)}. Net profit: ${s.netProfit.toFixed(2)}. Owner withdrawals (not an expense): ${s.withdrawals.toFixed(2)}.
Sales by product category: ${fmtEntries(s.salesCat)}.
Expenses by category: ${fmtEntries(s.expCat)}.
Other income by category: ${fmtEntries(s.incCat)}.
Customers who currently owe money (running balance as of ${bounds.to}): ${fmtEntries(s.custTotals)}.
Suppliers currently owed money (running balance as of ${bounds.to}): ${fmtEntries(s.suppTotals)}.
Low stock items right now: ${s.lowStock.join(', ') || 'none'}.`;
    if (intent.entity) {
      context += `\nThe owner specifically asked about "${intent.entity}" — find this name in the category/customer/supplier data above and answer specifically about it. If it does not appear anywhere above, say plainly that you found no record of it rather than guessing or inventing a figure.`;
    }

    const system = `You are MariWise, a financial assistant for a small business owner with no formal accounting background.

Priority order for every answer:
1. FIRST, answer using the business's own real data given below — this is always the primary content. Never invent figures; if the data doesn't cover something, say so plainly.
2. ONLY IF genuinely useful, add general business or financial knowledge/advice afterward, clearly marked as general (e.g. start it with "In general," or "As a tip,") so it's never confused with one of their actual numbers. Don't lead with general advice when their own data could answer the question.

This data is scoped specifically to what was asked — state the exact period or figure you're using early in the answer (e.g. "Looking at ${periodLabel}...") so it's unmistakable this is their real, current data and not a generic response.

Go beyond reciting numbers — give a real INSIGHT: what a figure means, whether something looks off or worth watching, or one concrete next step. A bare restatement of a number with no interpretation is not a complete answer.

When asked who owes money, who they owe, or for a breakdown, list each name and amount as its own bullet from the data above — never just give a single total when a breakdown is available. If an entry is "Unspecified", mention that a name wasn't recorded for that amount rather than skipping it.

Formatting for this chat bubble:
- Short paragraphs, skimmable.
- For anything with several figures (a report, a breakdown, "insights"), use a short bullet list with **bold** on the key numbers rather than one dense sentence.
- For a single quick fact, a plain sentence is fine — don't force bullets where they're not needed.
- No headers (#), no tables — plain bullets and bold only.
- Keep it concise unless a full report is explicitly asked for.

Business data:
${context}`;
    const answer = await askGroq(system, question);
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- PDF Reports ----------------
// A simplified management report (not statutory financial statements) for a
// date range: P&L, expense/other-income breakdowns, cash flow, and a
// receivables/payables snapshot as of the end date.
app.get('/api/reports/pdf', async (req, res) => {
  const { business_id, from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Please choose a start and end date.' });
  let biz;
  try {
    biz = await assertOwnsBusiness(business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }

  const reportCurrency = biz.currency || 'USD';
  const rate = biz.exchange_rate;
  const { data: txnsRaw } = await supabase.from('transactions').select().eq('business_id', business_id);
  const txns = txnsRaw || [];
  const inRange = txns.filter(t => {
    const d = t.created_at.slice(0, 10);
    return d >= from && d <= to;
  });
  const upToEnd = txns.filter(t => t.created_at.slice(0, 10) <= to);

  const c = (amount, fromCurrency) => convertAmount(amount, fromCurrency, reportCurrency, rate).value;
  const sumType = (list, type) => list.filter(t => t.type === type).reduce((s, t) => s + c(t.amount, t.currency), 0);
  const sym = (v) => `${{ USD: '$', ZiG: 'ZiG ' }[reportCurrency] || ''}${Number(v || 0).toFixed(2)}`;

  const sales = sumType(inRange, 'sale');
  const cost = inRange.filter(t => t.type === 'sale').reduce((s, t) => s + c(t.cost || 0, t.currency), 0);
  const grossProfit = sales - cost;
  const expenses = sumType(inRange, 'expense');
  const otherIncome = sumType(inRange, 'other_income');
  const withdrawals = sumType(inRange, 'owner_withdrawal');
  const netProfit = grossProfit - expenses + otherIncome;

  const expCat = {};
  inRange.filter(t => t.type === 'expense').forEach(t => {
    const k = t.category || 'Uncategorized';
    expCat[k] = (expCat[k] || 0) + c(t.amount, t.currency);
  });
  const incCat = {};
  inRange.filter(t => t.type === 'other_income').forEach(t => {
    const k = t.category || 'Uncategorized';
    incCat[k] = (incCat[k] || 0) + c(t.amount, t.currency);
  });

  const cashIn = inRange.filter(t => (t.type === 'sale' && t.payment_method !== 'Credit (customer owes)') || t.type === 'other_income' || t.type === 'customer_payment')
    .reduce((s, t) => s + c(t.amount, t.currency), 0);
  const cashOut = inRange.filter(t => (t.type === 'expense' && !(Number(t.owed_to_supplier || 0) > 0)) || t.type === 'owner_withdrawal' || t.type === 'supplier_payment')
    .reduce((s, t) => s + c(t.amount, t.currency), 0);

  // Receivables/payables as a running snapshot as of the report end date.
  const custTotals = {};
  upToEnd.filter(t => t.type === 'sale' && Number(t.owed || 0) > 0).forEach(t => {
    const k = t.customer || 'Unspecified customer'; custTotals[k] = (custTotals[k] || 0) + c(t.owed, t.currency);
  });
  upToEnd.filter(t => t.type === 'customer_payment').forEach(t => {
    const k = t.customer || 'Unspecified customer'; custTotals[k] = (custTotals[k] || 0) - c(t.amount, t.currency);
  });
  const suppTotals = {};
  upToEnd.filter(t => t.type === 'expense' && Number(t.owed_to_supplier || 0) > 0).forEach(t => {
    const k = t.supplier || 'Unspecified supplier'; suppTotals[k] = (suppTotals[k] || 0) + c(t.owed_to_supplier, t.currency);
  });
  upToEnd.filter(t => t.type === 'supplier_payment').forEach(t => {
    const k = t.supplier || 'Unspecified supplier'; suppTotals[k] = (suppTotals[k] || 0) - c(t.amount, t.currency);
  });
  const custEntries = Object.entries(custTotals).filter(([, v]) => Math.abs(v) > 0.005);
  const suppEntries = Object.entries(suppTotals).filter(([, v]) => Math.abs(v) > 0.005);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="MariWise-Report-${from}-to-${to}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  const TEAL = '#0B4A40', GOLD = '#B7791F', INK = '#1C2521', MUTED = '#5B6862';
  doc.fillColor(TEAL).fontSize(22).font('Helvetica-Bold').text('MariWise', { continued: false });
  doc.fillColor(MUTED).fontSize(10).font('Helvetica').text('Know your numbers. Grow your business.');
  doc.moveDown(0.6);
  doc.fillColor(INK).fontSize(15).font('Helvetica-Bold').text(biz.name || 'Business Report');
  doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(`Report period: ${from} to ${to}  ·  Currency: ${reportCurrency}  ·  Generated: ${new Date().toISOString().slice(0, 10)}`);
  doc.moveDown(1);

  function sectionHeader(title) {
    doc.moveDown(0.6);
    doc.fillColor(TEAL).fontSize(13).font('Helvetica-Bold').text(title);
    doc.moveTo(doc.x, doc.y + 2).lineTo(545, doc.y + 2).strokeColor(GOLD).lineWidth(1.2).stroke();
    doc.moveDown(0.5);
  }
  function row(label, value, opts = {}) {
    doc.fillColor(opts.bold ? TEAL : INK).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5);
    const y = doc.y;
    doc.text(label, 55, y, { continued: false, width: 350 });
    doc.text(value, 55, y, { width: 490, align: 'right' });
    doc.moveDown(0.35);
  }

  sectionHeader('Profit & Loss');
  row('Sales', sym(sales));
  row('Cost of goods sold', `(${sym(cost)})`);
  row('Gross profit', sym(grossProfit), { bold: true });
  row('Operating expenses', `(${sym(expenses)})`);
  row('Other income', sym(otherIncome));
  row('Net profit', sym(netProfit), { bold: true });

  if (Object.keys(expCat).length) {
    sectionHeader('Expenses by Category');
    Object.entries(expCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => row(k, sym(v)));
  }
  if (Object.keys(incCat).length) {
    sectionHeader('Other Income by Category');
    Object.entries(incCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => row(k, sym(v)));
  }

  sectionHeader('Cash Flow (this period)');
  row('Cash in', sym(cashIn));
  row('Cash out', `(${sym(cashOut)})`);
  row('Net cash movement', sym(cashIn - cashOut), { bold: true });
  if (withdrawals > 0) row('Owner withdrawals (not a business expense)', sym(withdrawals));

  sectionHeader(`Receivables & Payables (as of ${to})`);
  if (custEntries.length) {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text('Customers who owe the business:');
    doc.moveDown(0.2);
    custEntries.sort((a, b) => b[1] - a[1]).forEach(([k, v]) => row(k, sym(v)));
  } else {
    row('Customers who owe the business', 'None outstanding');
  }
  doc.moveDown(0.3);
  if (suppEntries.length) {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text('Suppliers the business owes:');
    doc.moveDown(0.2);
    suppEntries.sort((a, b) => b[1] - a[1]).forEach(([k, v]) => row(k, sym(v)));
  } else {
    row('Suppliers the business owes', 'None outstanding');
  }

  doc.moveDown(1);
  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Oblique').text(
    'This is a management report generated from records the owner entered themselves — not an audited financial statement. Figures are converted to the report currency using the exchange rate saved in Settings at the time this report was generated.',
    { width: 495 }
  );

  doc.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MariWise running at http://localhost:${PORT}`));
