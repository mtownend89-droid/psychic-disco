require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();

// ── Trust Render's proxy (required for secure cookies behind HTTPS proxy) ─────
app.set('trust proxy', 1);

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: true,          // reflect the request origin (works on all domains)
  credentials: true,
}));

// ── Simple token-based auth (no sessions, no cookies) ────────────────────────
// On login: server returns a signed token. Client stores in sessionStorage.
// Client sends it as Authorization header on every request.
// This avoids ALL cookie/session problems on Render + Safari + iPad.

const AUTH_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

function makeToken() {
  // signed token: timestamp + random + hmac
  const payload = Date.now() + '.' + crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  const sig = parts[2];
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  try {
    const match = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!match) return false;
    // Token expires after 7 days
    const ts = parseInt(parts[0], 10);
    return (Date.now() - ts) < 7 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();
  if (verifyToken(token)) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── Public routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.PLAID_ENV || 'sandbox' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const APP_USER = process.env.APP_USERNAME || '';
  const APP_PASS = process.env.APP_PASSWORD || '';

  // Simple string comparison — safe enough for personal use
  const ok = (String(username).trim() === APP_USER && String(password) === APP_PASS);

  if (ok) {
    const token = makeToken();
    return res.json({ success: true, token });
  }
  res.status(401).json({ error: 'Incorrect username or password' });
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Plaid client ──────────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ── Token store (in-memory + optional file persist) ───────────────────────────
const TOKEN_FILE = path.join(__dirname, '../.data/tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (e) {}
  return { accessTokens: [], cursor: {} };
}

function saveTokens(store) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not persist tokens:', e.message);
  }
}

const store = loadTokens();
console.log(`Loaded ${store.accessTokens.length} saved connection(s)`);

// ── Protected routes ──────────────────────────────────────────────────────────

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
      store.accessTokens.push({
        itemId: item_id,
        accessToken: access_token,
        institutionName: institution_name || 'Bank',
      });
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
  const cards = [], loans = [], mortgages = [];
  for (const item of store.accessTokens) {
    try {
      const r = await plaidClient.liabilitiesGet({ access_token: item.accessToken });
      const liab = r.data.liabilities;
      const acctMap = {};
      r.data.accounts.forEach(a => { acctMap[a.account_id] = a; });
      liab.credit?.forEach(cc => {
        const a = acctMap[cc.account_id] || {};
        cards.push({
          account_id: cc.account_id, name: a.name || 'Credit Card',
          institution: item.institutionName, mask: a.mask,
          current_balance: a.balances?.current ?? 0,
          minimum_payment: cc.minimum_payment_amount ?? 0,
          last_payment_date: cc.last_payment_date,
          last_payment_amount: cc.last_payment_amount ?? 0,
          next_payment_due_date: cc.next_payment_due_date,
          aprs: cc.aprs || [],
          apr: cc.aprs?.find(x => x.apr_type === 'purchase_apr')?.apr_percentage ?? null,
          is_overdue: cc.is_overdue ?? false,
        });
      });
      liab.mortgage?.forEach(m => {
        const a = acctMap[m.account_id] || {};
        mortgages.push({
          account_id: m.account_id, name: a.name || 'Mortgage',
          institution: item.institutionName,
          current_balance: m.current_outstanding_balance ?? 0,
          minimum_payment: m.next_monthly_payment ?? 0,
          next_payment_due_date: m.next_payment_due_date,
          interest_rate: m.interest_rate?.percentage ?? null,
          is_overdue: m.is_overdue ?? false,
        });
      });
    } catch (e) {
      // fall back to basic account data
      try {
        const r = await plaidClient.accountsGet({ access_token: item.accessToken });
        r.data.accounts.filter(a => a.type === 'credit').forEach(a => {
          cards.push({
            account_id: a.account_id, name: a.name,
            institution: item.institutionName, mask: a.mask,
            current_balance: a.balances?.current ?? 0,
            minimum_payment: null, apr: null, aprs: [], limited_data: true,
          });
        });
      } catch (_) {}
    }
  }
  res.json({ credit_cards: cards, mortgages, student_loans: loans });
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
  const { itemId } = req.params;
  const item = store.accessTokens.find(t => t.itemId === itemId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    await plaidClient.itemRemove({ access_token: item.accessToken });
    store.accessTokens = store.accessTokens.filter(t => t.itemId !== itemId);
    delete store.cursor[itemId];
    saveTokens(store);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`   Plaid: ${process.env.PLAID_ENV || 'sandbox'}`);
  console.log(`   User:  ${process.env.APP_USERNAME ? '✓ set' : '⚠ APP_USERNAME not set'}`);
  console.log(`   Pass:  ${process.env.APP_PASSWORD ? '✓ set' : '⚠ APP_PASSWORD not set'}\n`);
});
