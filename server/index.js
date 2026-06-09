// ─────────────────────────────────────────────────────────────────────────────
// Matt & Dana Finance — Secured server
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const session      = require('express-session');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
// Fail fast on startup if critical env vars are missing
const REQUIRED_ENV = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'SESSION_SECRET', 'APP_USERNAME', 'APP_PASSWORD'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.warn('\n⚠️  Missing environment variables:', missing.join(', '));
  console.warn('   Set these in Render → your service → Environment');
  console.warn('   App will start but auth and Plaid calls will not work until set.\n');
}

// ─── SECURITY HEADERS (Helmet) ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",        // needed for inline JS in index.html
        "https://cdn.plaid.com",
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com",
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
      ],
      fontSrc:  ["'self'", "https://fonts.gstatic.com"],
      imgSrc:   ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        "https://production.plaid.com",
        "https://sandbox.plaid.com",
        "https://cdn.plaid.com",
      ],
      frameSrc:  ["https://cdn.plaid.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // needed for Plaid Link iframe
}));

// ─── CORS — locked to your Render domain only ─────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no origin header) and the configured domain
    if (!origin || origin === ALLOWED_ORIGIN) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
}));

// ─── BODY PARSER ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' })); // prevent oversized payloads

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// General API limiter — 120 requests per 15 minutes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Strict limiter for auth endpoint — 10 attempts per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, try again in 15 minutes.' },
});

// Plaid-specific limiter — prevents burning your API quota
const plaidLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many Plaid requests, slow down.' },
});

app.use('/api/', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/create_link_token', plaidLimiter);
app.use('/api/transactions', plaidLimiter);
app.use('/api/accounts', plaidLimiter);

// ─── SESSION ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'mdf_session',          // don't use default 'connect.sid'
  cookie: {
    httpOnly: true,              // JS cannot read this cookie
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in prod
    sameSite: 'strict',          // no cross-site cookie leakage
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
  },
}));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ─── LOGIN / LOGOUT ROUTES (public) ──────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.APP_USERNAME;
  const validPass = process.env.APP_PASSWORD;

  // Timing-safe comparison — prevents timing attacks
  // Buffers must be same length for timingSafeEqual
  const toFixed = (s, len) => {
    const buf = Buffer.alloc(len, 0);
    Buffer.from(String(s || ''), 'utf8').copy(buf, 0, 0, len);
    return buf;
  };
  const userMatch = crypto.timingSafeEqual(toFixed(username, 64),  toFixed(validUser, 64));
  const passMatch = crypto.timingSafeEqual(toFixed(password, 128), toFixed(validPass, 128));

  if (userMatch && passMatch) {
    req.session.authenticated = true;
    req.session.loginTime = Date.now();
    return res.json({ success: true });
  }
  // Generic message — don't reveal which field was wrong
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    res.clearCookie('mdf_session');
    res.json({ success: true });
  });
});

app.get('/api/auth-check', (req, res) => {
  // Public route — no auth required
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ─── PLAID CLIENT ─────────────────────────────────────────────────────────────
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

// ─── PERSISTENT TOKEN STORAGE ─────────────────────────────────────────────────
// Tokens are stored encrypted in a JSON file so they survive server restarts.
// In production on Render, use a persistent disk or database instead.
const TOKEN_FILE = path.join(__dirname, '../.data/tokens.enc');
const ENCRYPTION_KEY = crypto.createHash('sha256')
  .update(process.env.SESSION_SECRET)
  .digest(); // 32-byte key from session secret

function encryptData(obj) {
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const text = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptData(str) {
  const [ivHex, encHex] = str.split(':');
  const iv        = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher  = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return { accessTokens: [], cursor: {} };
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    return decryptData(raw);
  } catch (e) {
    console.warn('Could not load tokens (first run or key changed):', e.message);
    return { accessTokens: [], cursor: {} };
  }
}

function saveTokens(store) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, encryptData(store), { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    // On Render free tier the filesystem may be read-only — log and continue
    console.warn('Could not persist tokens (filesystem may be read-only):', e.message);
    console.warn('Tokens are in memory only — will need re-linking after restart.');
  }
}

// Load persisted tokens on startup
const store = loadTokens();
console.log(`   Loaded ${store.accessTokens.length} persisted bank connection(s)`);

// ─── HEALTH (public — needed for app startup check) ───────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.PLAID_ENV || 'sandbox',
    authenticated: !!(req.session && req.session.authenticated),
    connections: store.accessTokens.length,
  });
});

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
// Serve static files BEFORE auth middleware so login page assets load
app.use(express.static(path.join(__dirname, '../public')));

// ─── PROTECTED ROUTES — all Plaid/data routes require auth ──────────────────
// Note: /api/login, /api/logout, /api/auth-check and /api/health are PUBLIC
// Everything else requires a valid session

// ─── Create link token ────────────────────────────────────────────────────────
app.post('/api/create_link_token', requireAuth, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'user-matt-dana' },
      client_name: 'Matt & Dana Finance',
      products: [Products.Transactions, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    try {
      const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: 'user-matt-dana' },
        client_name: 'Matt & Dana Finance',
        products: [Products.Transactions],
        country_codes: [CountryCode.Us],
        language: 'en',
      });
      res.json({ link_token: response.data.link_token });
    } catch (err2) {
      console.error('create_link_token error:', err2.response?.data || err2.message);
      res.status(500).json({ error: err2.response?.data?.error_message || err2.message });
    }
  }
});

// ─── Exchange token ───────────────────────────────────────────────────────────
app.post('/api/exchange_token', requireAuth, async (req, res) => {
  const { public_token, institution_name } = req.body;
  if (!public_token || typeof public_token !== 'string') {
    return res.status(400).json({ error: 'Invalid token' });
  }
  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;
    if (!store.accessTokens.find(t => t.itemId === item_id)) {
      store.accessTokens.push({
        itemId: item_id,
        accessToken: access_token,
        institutionName: institution_name || 'Bank',
        addedAt: new Date().toISOString(),
      });
      saveTokens(store); // persist immediately
    }
    res.json({ success: true, item_id, institution: institution_name });
  } catch (err) {
    console.error('exchange_token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ─── Accounts + balances ──────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ accounts: [] });
  try {
    const allAccounts = [];
    for (const item of store.accessTokens) {
      const response = await plaidClient.accountsBalanceGet({ access_token: item.accessToken });
      for (const acct of response.data.accounts) {
        allAccounts.push({ ...acct, institution: item.institutionName, itemId: item.itemId });
      }
    }
    res.json({ accounts: allAccounts });
  } catch (err) {
    console.error('accounts error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ─── Liabilities ─────────────────────────────────────────────────────────────
app.get('/api/liabilities', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ liabilities: [], accounts: [] });
  const allCreditCards = [], allStudentLoans = [], allMortgages = [], allAccounts = [];
  for (const item of store.accessTokens) {
    try {
      const liabRes = await plaidClient.liabilitiesGet({ access_token: item.accessToken });
      const liab = liabRes.data.liabilities;
      const accts = liabRes.data.accounts;
      const acctMap = {};
      accts.forEach(a => { acctMap[a.account_id] = { ...a, institution: item.institutionName }; });
      accts.forEach(a => allAccounts.push({ ...a, institution: item.institutionName }));
      if (liab.credit) {
        liab.credit.forEach(cc => {
          const acct = acctMap[cc.account_id] || {};
          allCreditCards.push({
            account_id: cc.account_id, name: acct.name || 'Credit Card',
            institution: item.institutionName, mask: acct.mask,
            current_balance: acct.balances?.current ?? 0,
            statement_balance: cc.last_statement_balance ?? 0,
            minimum_payment: cc.minimum_payment_amount ?? 0,
            last_payment_date: cc.last_payment_date,
            last_payment_amount: cc.last_payment_amount ?? 0,
            next_payment_due_date: cc.next_payment_due_date,
            last_statement_issue_date: cc.last_statement_issue_date,
            aprs: cc.aprs || [],
            apr: cc.aprs?.find(a => a.apr_type === 'purchase_apr')?.apr_percentage ?? null,
            is_overdue: cc.is_overdue ?? false,
          });
        });
      }
      if (liab.student) {
        liab.student.forEach(loan => {
          const acct = acctMap[loan.account_id] || {};
          allStudentLoans.push({
            account_id: loan.account_id, name: acct.name || 'Student Loan',
            institution: item.institutionName,
            current_balance: acct.balances?.current ?? 0,
            minimum_payment: loan.minimum_payment_amount ?? 0,
            next_payment_due_date: loan.next_payment_due_date,
            last_payment_date: loan.last_payment_date,
            last_payment_amount: loan.last_payment_amount ?? 0,
            interest_rate: loan.interest_rate_percentage ?? null,
            is_overdue: loan.is_overdue ?? false,
          });
        });
      }
      if (liab.mortgage) {
        liab.mortgage.forEach(m => {
          const acct = acctMap[m.account_id] || {};
          allMortgages.push({
            account_id: m.account_id, name: acct.name || 'Mortgage',
            institution: item.institutionName,
            current_balance: m.current_outstanding_balance ?? acct.balances?.current ?? 0,
            minimum_payment: m.next_monthly_payment ?? 0,
            next_payment_due_date: m.next_payment_due_date,
            interest_rate: m.interest_rate?.percentage ?? null,
            is_overdue: m.is_overdue ?? false,
          });
        });
      }
    } catch (err) {
      console.warn(`Liabilities fallback for ${item.institutionName}:`, err.response?.data?.error_code || err.message);
      try {
        const acctRes = await plaidClient.accountsGet({ access_token: item.accessToken });
        for (const acct of acctRes.data.accounts) {
          allAccounts.push({ ...acct, institution: item.institutionName });
          if (acct.type === 'credit') {
            allCreditCards.push({
              account_id: acct.account_id, name: acct.name,
              institution: item.institutionName, mask: acct.mask,
              current_balance: acct.balances?.current ?? 0,
              statement_balance: acct.balances?.current ?? 0,
              minimum_payment: null, apr: null, aprs: [],
              is_overdue: false, limited_data: true,
            });
          }
        }
      } catch (e) { console.error('accounts fallback error:', e.message); }
    }
  }
  res.json({ credit_cards: allCreditCards, student_loans: allStudentLoans, mortgages: allMortgages, accounts: allAccounts });
});

// ─── Transactions ─────────────────────────────────────────────────────────────
app.get('/api/transactions', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ transactions: [], accounts: [] });
  try {
    const allTransactions = [], allAccounts = [];
    for (const item of store.accessTokens) {
      let cursor = store.cursor[item.itemId] || null;
      let hasMore = true;
      const added = [];
      while (hasMore) {
        const params = { access_token: item.accessToken };
        if (cursor) params.cursor = cursor;
        const response = await plaidClient.transactionsSync(params);
        added.push(...response.data.added);
        cursor = response.data.next_cursor;
        hasMore = response.data.has_more;
      }
      store.cursor[item.itemId] = cursor;
      saveTokens(store); // save cursor progress
      added.forEach(txn => allTransactions.push({ ...txn, institution: item.institutionName }));
      const acctRes = await plaidClient.accountsGet({ access_token: item.accessToken });
      acctRes.data.accounts.forEach(a => allAccounts.push({ ...a, institution: item.institutionName }));
    }
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: allTransactions, accounts: allAccounts });
  } catch (err) {
    console.error('transactions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ─── Remove item ──────────────────────────────────────────────────────────────
app.delete('/api/item/:itemId', requireAuth, async (req, res) => {
  const { itemId } = req.params;
  // Validate itemId format (alphanumeric only)
  if (!/^[a-zA-Z0-9_-]+$/.test(itemId)) {
    return res.status(400).json({ error: 'Invalid item ID' });
  }
  const item = store.accessTokens.find(t => t.itemId === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  try {
    await plaidClient.itemRemove({ access_token: item.accessToken });
    store.accessTokens = store.accessTokens.filter(t => t.itemId !== itemId);
    delete store.cursor[itemId];
    saveTokens(store); // persist removal
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// Catches any unhandled errors and returns a clean response (no stack traces)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Matt & Dana Finance running on port ${PORT}`);
  console.log(`   Plaid environment : ${process.env.PLAID_ENV || 'sandbox'}`);
  console.log(`   CORS origin       : ${ALLOWED_ORIGIN}`);
  console.log(`   Token storage     : ${TOKEN_FILE}`);
  console.log(`   Auth              : session-based login\n`);
});
