require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

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
  const { business_id, name, unit, price, cost, stock, low_stock, currency } = req.body;
  try {
    await assertOwnsBusiness(business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  const { data, error } = await supabase
    .from('products')
    .insert({ business_id, name, unit, price, cost, stock, low_stock, currency: currency || 'USD' })
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
  const { name, unit, price, cost, stock, low_stock, currency } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (unit !== undefined) update.unit = unit;
  if (price !== undefined) update.price = price;
  if (cost !== undefined) update.cost = cost;
  if (stock !== undefined) update.stock = stock;
  if (low_stock !== undefined) update.low_stock = low_stock;
  if (currency !== undefined) update.currency = currency;
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

  let total = 0, costTotal = 0, descParts = [], saleCurrency = null;
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
app.post('/api/transactions', async (req, res) => {
  const { business_id, type, amount, category, desc, pay, supplier, on_credit, customer, currency } = req.body;
  try {
    await assertOwnsBusiness(business_id, req.user.id);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  if (!TXN_TYPES.includes(type)) return res.status(400).json({ error: 'Unsupported transaction type' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

  const row = { business_id, type, amount, currency: currency || 'USD', description: desc, payment_method: pay };
  if (type === 'expense') {
    row.category = category || null;
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
  "category": <one of "Rent","Wages","Transport","Stock & Supplies","Utilities","Marketing","Other" — ONLY when type is "expense", otherwise null>,
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

    const today = new Date().toISOString().slice(0, 10);
    const { data: biz } = await supabase.from('businesses').select('currency, exchange_rate').eq('id', business_id).single();
    const reportCurrency = biz?.currency || 'USD';
    const rate = biz?.exchange_rate;
    const { data: txnsRaw } = await supabase.from('transactions').select().eq('business_id', business_id);
    const { data: products } = await supabase.from('products').select().eq('business_id', business_id);
    const txns = txnsRaw || [];
    const todays = txns.filter(t => t.created_at.slice(0, 10) === today);

    let unconvertedCount = 0;
    const c = (amount, fromCurrency) => {
      const r = convertAmount(amount, fromCurrency, reportCurrency, rate);
      if (!r.ok) unconvertedCount++;
      return r.value;
    };
    const sumType = (list, type) => list.filter(t => t.type === type).reduce((s, t) => s + c(t.amount, t.currency), 0);

    const salesToday = sumType(todays, 'sale');
    const costToday = todays.filter(t => t.type === 'sale').reduce((s, t) => s + c(t.cost || 0, t.currency), 0);
    const expToday = sumType(todays, 'expense');

    const totalSales = sumType(txns, 'sale');
    const totalCost = txns.filter(t => t.type === 'sale').reduce((s, t) => s + c(t.cost || 0, t.currency), 0);
    const totalExpenses = sumType(txns, 'expense');
    const totalWithdrawals = sumType(txns, 'owner_withdrawal');
    const totalOtherIncome = sumType(txns, 'other_income');

    const customerOwed = txns.reduce((s, t) => s + c(t.owed || 0, t.currency), 0) - sumType(txns, 'customer_payment');
    const supplierOwed = txns.filter(t => t.type === 'expense').reduce((s, t) => s + c(t.owed_to_supplier || 0, t.currency), 0) - sumType(txns, 'supplier_payment');

    const lowStock = (products || []).filter(p => p.stock <= p.low_stock).map(p => `${p.name} (${p.stock} ${p.unit} left)`);

    const catTotals = {};
    txns.filter(t => t.type === 'expense').forEach(t => {
      const cat = t.category || 'Uncategorized';
      catTotals[cat] = (catTotals[cat] || 0) + c(t.amount, t.currency);
    });
    const catBreakdown = Object.entries(catTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, v]) => `${cat}: ${v.toFixed(2)}`).join(', ') || 'none recorded';

    const supplierTotals = {};
    txns.filter(t => t.type === 'expense' && Number(t.owed_to_supplier || 0) > 0).forEach(t => {
      const name = t.supplier || 'Unspecified supplier';
      supplierTotals[name] = (supplierTotals[name] || 0) + c(t.owed_to_supplier, t.currency);
    });
    txns.filter(t => t.type === 'supplier_payment').forEach(t => {
      const name = t.supplier || 'Unspecified supplier';
      supplierTotals[name] = (supplierTotals[name] || 0) - c(t.amount || 0, t.currency);
    });
    const supplierBreakdown = Object.entries(supplierTotals)
      .filter(([, v]) => Math.abs(v) > 0.001)
      .sort((a, b) => b[1] - a[1])
      .map(([s, v]) => `${s}: ${v.toFixed(2)}`).join(', ') || 'none recorded';

    const customerTotals = {};
    txns.filter(t => t.type === 'sale' && Number(t.owed || 0) > 0).forEach(t => {
      const name = t.customer || 'Unspecified customer';
      customerTotals[name] = (customerTotals[name] || 0) + c(t.owed, t.currency);
    });
    txns.filter(t => t.type === 'customer_payment').forEach(t => {
      const name = t.customer || 'Unspecified customer';
      customerTotals[name] = (customerTotals[name] || 0) - c(t.amount || 0, t.currency);
    });
    const customerBreakdown = Object.entries(customerTotals)
      .filter(([, v]) => Math.abs(v) > 0.001)
      .sort((a, b) => b[1] - a[1])
      .map(([cName, v]) => `${cName}: ${v.toFixed(2)}`).join(', ') || 'none recorded';

    const conversionNote = unconvertedCount > 0
      ? ` NOTE: ${unconvertedCount} record(s) were in a different currency than the report currency and could NOT be converted because no exchange rate is saved (Settings) — the figures above may be incomplete or understated. Mention this if it seems relevant.`
      : '';

    const context = `Report currency: ${reportCurrency}. All figures below are converted into this currency using the owner's saved exchange rate where needed — the original transaction records themselves keep whatever currency they were actually made in.${conversionNote}
TODAY — sales: ${salesToday.toFixed(2)}, cost of goods sold: ${costToday.toFixed(2)}, expenses: ${expToday.toFixed(2)}.
ALL-TIME (everything recorded so far) — total sales: ${totalSales.toFixed(2)}, total cost of goods sold: ${totalCost.toFixed(2)}, total gross profit (sales minus cost of goods sold): ${(totalSales - totalCost).toFixed(2)}, total overheads/expenses: ${totalExpenses.toFixed(2)}, total net profit (gross profit minus overheads): ${(totalSales - totalCost - totalExpenses).toFixed(2)}.
Overheads by category: ${catBreakdown}.
Total owner withdrawals so far (personal money taken out — this does NOT count as a business expense): ${totalWithdrawals.toFixed(2)}.
Total other income so far (money in that wasn't a product sale, e.g. loans, refunds): ${totalOtherIncome.toFixed(2)}.
Total customer debt currently owed to the business: ${customerOwed.toFixed(2)}. By customer: ${customerBreakdown}.
Total the business currently owes to suppliers: ${supplierOwed.toFixed(2)}. By supplier: ${supplierBreakdown}.
Low stock items: ${lowStock.join(', ') || 'none'}.`;

    const system = `You are MariWise, a financial assistant for a small business owner with no formal accounting background.

Priority order for every answer:
1. FIRST, answer using the business's own real data given below — this is always the primary content. Never invent figures; if the data doesn't cover something, say so plainly.
2. ONLY IF genuinely useful, add general business or financial knowledge/advice afterward, clearly marked as general (e.g. start it with "In general," or "As a tip,") so it's never confused with one of their actual numbers. Don't lead with general advice when their own data could answer the question.

Go beyond reciting numbers — give a real INSIGHT: what a figure means, whether something looks off or worth watching, or one concrete next step. A bare restatement of a number with no interpretation is not a complete answer.

When asked who owes money, who they owe, or for a breakdown of customer or supplier debt, use the "By customer" / "By supplier" lists in the data below and name each name and amount as its own bullet — never just give the single total when a breakdown is available. If an entry is "Unspecified supplier" or "Unspecified customer", mention that a name wasn't recorded for that amount rather than skipping it.

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MariWise running at http://localhost:${PORT}`));
