require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(cors({ origin: true, credentials: true }));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const APP_USER   = (process.env.APP_USERNAME || '').trim();
const APP_PASS   = (process.env.APP_PASSWORD || '').trim();
const APP_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!APP_USER || !APP_PASS) {
  console.warn('⚠️  APP_USERNAME or APP_PASSWORD not set — login will fail');
  console.warn('   Set them in Render → Environment');
}

// ── TOKEN AUTH ────────────────────────────────────────────────────────────────
// Simple signed token stored in sessionStorage — no cookies needed

function makeToken() {
  const ts  = Date.now().toString();
  const rnd = crypto.randomBytes(16).toString('hex');
  const sig  = crypto.createHmac('sha256', APP_SECRET).update(ts + ':' + rnd).digest('hex');
  // encode as base64 to avoid dot-splitting issues
  const payload = Buffer.from(ts + ':' + rnd + ':' + sig).toString('base64');
  return payload;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    // parts: [ts, rnd, sig]  — sig is last 64 chars (sha256 hex)
    if (parts.length < 3) return false;
    const sig      = parts[parts.length - 1];
    const rnd      = parts[parts.length - 2];
    const ts       = parts.slice(0, parts.length - 2).join(':');
    const expected = crypto.createHmac('sha256', APP_SECRET).update(ts + ':' + rnd).digest('hex');
    if (sig.length !== expected.length) return false;
    const match = crypto.timingSafeEqual(
      Buffer.from(sig,      'hex'),
      Buffer.from(expected, 'hex')
    );
    if (!match) return false;
    const age = Date.now() - parseInt(ts, 10);
    return age < 7 * 24 * 60 * 60 * 1000; // 7 days
  } catch (e) {
    return false;
  }
}

function requireAuth(req, res, next) {
  const header = (req.headers['authorization'] || '').trim();
  const token  = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env:    process.env.PLAID_ENV || 'sandbox',
    user_set: !!APP_USER,
    pass_set: !!APP_PASS,
  });
});

app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};

  const u = String(username).trim();
  const p = String(password);

  // Log attempt (without password) to help debug
  console.log(`Login attempt: "${u}" (pass length: ${p.length})`);
  console.log(`Expected user: "${APP_USER}" (pass length: ${APP_PASS.length})`);

  if (!APP_USER || !APP_PASS) {
    return res.status(500).json({ error: 'Server not configured — set APP_USERNAME and APP_PASSWORD in Render environment.' });
  }

  if (u === APP_USER && p === APP_PASS) {
    const token = makeToken();
    console.log('Login successful ✓');
    return res.json({ success: true, token });
  }

  console.log('Login failed — credentials did not match');
  return res.status(401).json({ error: 'Incorrect username or password' });
});

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── PLAID ─────────────────────────────────────────────────────────────────────
const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
}));

// ── TOKEN STORE ───────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, '../.data/tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE))
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) { console.warn('Token load:', e.message); }
  return { accessTokens: [], cursor: {} };
}

function saveTokens(store) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(store), 'utf8');
  } catch (e) { console.warn('Token save (ok on free tier):', e.message); }
}

const store = loadTokens();
console.log(`Loaded ${store.accessTokens.length} saved connection(s)`);

// ── PROTECTED ROUTES ──────────────────────────────────────────────────────────

app.post('/api/create_link_token', requireAuth, async (req, res) => {
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'matt-dana' },
      client_name: 'Matt & Dana Finance',
      products: [Products.Transactions, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: r.data.link_token });
  } catch (err) {
    try {
      const r = await plaidClient.linkTokenCreate({
        user: { client_user_id: 'matt-dana' },
        client_name: 'Matt & Dana Finance',
        products: [Products.Transactions],
        country_codes: [CountryCode.Us],
        language: 'en',
      });
      res.json({ link_token: r.data.link_token });
    } catch (e) {
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  }
});

app.post('/api/exchange_token', requireAuth, async (req, res) => {
  const { public_token, institution_name } = req.body;
  try {
    const r = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = r.data;
    if (!store.accessTokens.find(t => t.itemId === item_id)) {
      store.accessTokens.push({ itemId: item_id, accessToken: access_token, institutionName: institution_name || 'Bank' });
      saveTokens(store);
    }
    res.json({ success: true, item_id });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

app.get('/api/accounts', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ accounts: [] });
  try {
    const all = [];
    for (const item of store.accessTokens) {
      const r = await plaidClient.accountsBalanceGet({ access_token: item.accessToken });
      r.data.accounts.forEach(a => all.push({ ...a, institution: item.institutionName, itemId: item.itemId }));
    }
    res.json({ accounts: all });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

app.get('/api/liabilities', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ credit_cards: [], mortgages: [], student_loans: [] });
  const cards = [], mortgages = [];
  for (const item of store.accessTokens) {
    try {
      const r = await plaidClient.liabilitiesGet({ access_token: item.accessToken });
      const acctMap = {};
      r.data.accounts.forEach(a => { acctMap[a.account_id] = a; });
      r.data.liabilities.credit?.forEach(cc => {
        const a = acctMap[cc.account_id] || {};
        cards.push({ account_id: cc.account_id, name: a.name || 'Credit Card', institution: item.institutionName, mask: a.mask, current_balance: a.balances?.current ?? 0, minimum_payment: cc.minimum_payment_amount ?? 0, last_payment_date: cc.last_payment_date, last_payment_amount: cc.last_payment_amount ?? 0, next_payment_due_date: cc.next_payment_due_date, aprs: cc.aprs || [], apr: cc.aprs?.find(x => x.apr_type === 'purchase_apr')?.apr_percentage ?? null, is_overdue: cc.is_overdue ?? false });
      });
      r.data.liabilities.mortgage?.forEach(m => {
        const a = acctMap[m.account_id] || {};
        mortgages.push({ account_id: m.account_id, name: a.name || 'Mortgage', institution: item.institutionName, current_balance: m.current_outstanding_balance ?? 0, minimum_payment: m.next_monthly_payment ?? 0, next_payment_due_date: m.next_payment_due_date, interest_rate: m.interest_rate?.percentage ?? null, is_overdue: m.is_overdue ?? false });
      });
    } catch (e) {
      try {
        const r = await plaidClient.accountsGet({ access_token: item.accessToken });
        r.data.accounts.filter(a => a.type === 'credit').forEach(a => {
          cards.push({ account_id: a.account_id, name: a.name, institution: item.institutionName, mask: a.mask, current_balance: a.balances?.current ?? 0, minimum_payment: null, apr: null, aprs: [], limited_data: true });
        });
      } catch (_) {}
    }
  }
  res.json({ credit_cards: cards, mortgages, student_loans: [] });
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ transactions: [], accounts: [] });
  try {
    const txns = [], accts = [];
    for (const item of store.accessTokens) {
      let cursor = store.cursor[item.itemId] || null, hasMore = true;
      const added = [];
      while (hasMore) {
        const params = { access_token: item.accessToken };
        if (cursor) params.cursor = cursor;
        const r = await plaidClient.transactionsSync(params);
        added.push(...r.data.added);
        cursor = r.data.next_cursor;
        hasMore = r.data.has_more;
      }
      store.cursor[item.itemId] = cursor;
      saveTokens(store);
      added.forEach(t => txns.push({ ...t, institution: item.institutionName }));
      const r = await plaidClient.accountsGet({ access_token: item.accessToken });
      r.data.accounts.forEach(a => accts.push({ ...a, institution: item.institutionName }));
    }
    txns.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: txns, accounts: accts });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

app.delete('/api/item/:itemId', requireAuth, async (req, res) => {
  const item = store.accessTokens.find(t => t.itemId === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    await plaidClient.itemRemove({ access_token: item.accessToken });
    store.accessTokens = store.accessTokens.filter(t => t.itemId !== req.params.itemId);
    delete store.cursor[req.params.itemId];
    saveTokens(store);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Running on port ${PORT}`);
  console.log(`   Plaid: ${process.env.PLAID_ENV || 'sandbox'}`);
  console.log(`   User set:   ${APP_USER  ? '✓ ' + APP_USER : '✗ NOT SET'}`);
  console.log(`   Pass set:   ${APP_PASS  ? '✓ (length ' + APP_PASS.length + ')' : '✗ NOT SET'}\n`);
});
