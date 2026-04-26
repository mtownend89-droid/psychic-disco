require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Plaid client setup ───────────────────────────────────────────────────────
const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(config);

// In-memory store (for demo). In production: use a database like Postgres/SQLite.
const store = {
  accessTokens: [],  // [{ itemId, accessToken, institutionName }]
  cursor: {},        // { [itemId]: cursor } for transaction sync
};

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.PLAID_ENV || 'sandbox' });
});

// Step 1: Create a link token (sent to frontend to open Plaid Link)
app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'user-matt-dana' },
      client_name: 'Matt & Dana Finance',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('create_link_token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// Step 2: Exchange public token for access token (called after user links bank)
app.post('/api/exchange_token', async (req, res) => {
  const { public_token, institution_name } = req.body;
  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;

    // Avoid duplicate items
    if (!store.accessTokens.find(t => t.itemId === item_id)) {
      store.accessTokens.push({ itemId: item_id, accessToken: access_token, institutionName: institution_name || 'Bank' });
    }

    res.json({ success: true, item_id, institution: institution_name });
  } catch (err) {
    console.error('exchange_token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// Get all linked accounts + balances
app.get('/api/accounts', async (req, res) => {
  if (store.accessTokens.length === 0) {
    return res.json({ accounts: [] });
  }
  try {
    const allAccounts = [];
    for (const item of store.accessTokens) {
      const response = await plaidClient.accountsBalanceGet({ access_token: item.accessToken });
      for (const acct of response.data.accounts) {
        allAccounts.push({
          ...acct,
          institution: item.institutionName,
          itemId: item.itemId,
        });
      }
    }
    res.json({ accounts: allAccounts });
  } catch (err) {
    console.error('accounts error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// Sync transactions (incremental — only fetches new ones each call)
app.get('/api/transactions', async (req, res) => {
  if (store.accessTokens.length === 0) {
    return res.json({ transactions: [], accounts: [] });
  }
  try {
    const allTransactions = [];
    const allAccounts = [];

    for (const item of store.accessTokens) {
      let cursor = store.cursor[item.itemId] || null;
      let hasMore = true;
      const added = [];

      while (hasMore) {
        const params = { access_token: item.accessToken };
        if (cursor) params.cursor = cursor;

        const response = await plaidClient.transactionsSync(params);
        const data = response.data;

        added.push(...data.added);
        cursor = data.next_cursor;
        hasMore = data.has_more;
      }

      store.cursor[item.itemId] = cursor;

      for (const txn of added) {
        allTransactions.push({ ...txn, institution: item.institutionName });
      }

      // Also get accounts
      const acctResponse = await plaidClient.accountsGet({ access_token: item.accessToken });
      for (const acct of acctResponse.data.accounts) {
        allAccounts.push({ ...acct, institution: item.institutionName });
      }
    }

    // Sort newest first
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions: allTransactions, accounts: allAccounts });
  } catch (err) {
    console.error('transactions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// Get spending summary by category
app.get('/api/summary', async (req, res) => {
  try {
    const txnRes = await fetch(`http://localhost:${PORT}/api/transactions`);
    const { transactions } = await txnRes.json();

    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const recent = transactions.filter(t =>
      new Date(t.date) >= thirtyDaysAgo && t.amount > 0
    );

    const byCategory = {};
    for (const txn of recent) {
      const cat = (txn.personal_finance_category?.primary || txn.category?.[0] || 'Other');
      const label = formatCategory(cat);
      byCategory[label] = (byCategory[label] || 0) + txn.amount;
    }

    const totalSpend = recent.reduce((s, t) => s + t.amount, 0);
    const totalIncome = transactions
      .filter(t => new Date(t.date) >= thirtyDaysAgo && t.amount < 0)
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    res.json({ byCategory, totalSpend, totalIncome, count: recent.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a linked institution
app.delete('/api/item/:itemId', async (req, res) => {
  const { itemId } = req.params;
  const item = store.accessTokens.find(t => t.itemId === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  try {
    await plaidClient.itemRemove({ access_token: item.accessToken });
    store.accessTokens = store.accessTokens.filter(t => t.itemId !== itemId);
    delete store.cursor[itemId];
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatCategory(raw) {
  return raw
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Matt & Dana Finance App running on port ${PORT}`);
  console.log(`   Plaid environment: ${process.env.PLAID_ENV || 'sandbox'}`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});
