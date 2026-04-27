require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Plaid client ─────────────────────────────────────────────────────────────
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

const store = {
  accessTokens: [],
  cursor: {},
};

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.PLAID_ENV || 'sandbox' });
});

// ─── Create link token ────────────────────────────────────────────────────────
app.post('/api/create_link_token', async (req, res) => {
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
    // Fallback: try without Liabilities product if not enabled
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
app.post('/api/exchange_token', async (req, res) => {
  const { public_token, institution_name } = req.body;
  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;
    if (!store.accessTokens.find(t => t.itemId === item_id)) {
      store.accessTokens.push({
        itemId: item_id,
        accessToken: access_token,
        institutionName: institution_name || 'Bank',
      });
    }
    res.json({ success: true, item_id, institution: institution_name });
  } catch (err) {
    console.error('exchange_token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ─── Accounts + balances ──────────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  if (store.accessTokens.length === 0) return res.json({ accounts: [] });
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

// ─── Liabilities (credit cards + loans) ──────────────────────────────────────
app.get('/api/liabilities', async (req, res) => {
  if (store.accessTokens.length === 0) return res.json({ liabilities: [], accounts: [] });

  const allCreditCards = [];
  const allStudentLoans = [];
  const allMortgages = [];
  const allAccounts = [];

  for (const item of store.accessTokens) {
    try {
      // Get liabilities
      const liabRes = await plaidClient.liabilitiesGet({ access_token: item.accessToken });
      const liab = liabRes.data.liabilities;

      // Enrich with account info
      const accts = liabRes.data.accounts;
      const acctMap = {};
      accts.forEach(a => { acctMap[a.account_id] = { ...a, institution: item.institutionName }; });
      accts.forEach(a => allAccounts.push({ ...a, institution: item.institutionName }));

      // Credit cards
      if (liab.credit) {
        liab.credit.forEach(cc => {
          const acct = acctMap[cc.account_id] || {};
          allCreditCards.push({
            account_id: cc.account_id,
            name: acct.name || 'Credit Card',
            institution: item.institutionName,
            mask: acct.mask,
            // Balances
            current_balance: acct.balances?.current ?? 0,
            statement_balance: cc.last_statement_balance ?? 0,
            minimum_payment: cc.minimum_payment_amount ?? 0,
            // Dates
            last_payment_date: cc.last_payment_date,
            last_payment_amount: cc.last_payment_amount ?? 0,
            next_payment_due_date: cc.next_payment_due_date,
            last_statement_issue_date: cc.last_statement_issue_date,
            // APR info
            aprs: cc.aprs || [],
            // Derived
            apr: cc.aprs?.find(a => a.apr_type === 'purchase_apr')?.apr_percentage ?? null,
            is_overdue: cc.is_overdue ?? false,
          });
        });
      }

      // Student loans
      if (liab.student) {
        liab.student.forEach(loan => {
          const acct = acctMap[loan.account_id] || {};
          allStudentLoans.push({
            account_id: loan.account_id,
            name: acct.name || 'Student Loan',
            institution: item.institutionName,
            current_balance: acct.balances?.current ?? 0,
            minimum_payment: loan.minimum_payment_amount ?? 0,
            next_payment_due_date: loan.next_payment_due_date,
            last_payment_date: loan.last_payment_date,
            last_payment_amount: loan.last_payment_amount ?? 0,
            origination_date: loan.origination_date,
            origination_principal: loan.origination_principal_amount ?? 0,
            interest_rate: loan.interest_rate_percentage ?? null,
            is_overdue: loan.is_overdue ?? false,
            loan_status: loan.loan_status?.type ?? null,
          });
        });
      }

      // Mortgages
      if (liab.mortgage) {
        liab.mortgage.forEach(m => {
          const acct = acctMap[m.account_id] || {};
          allMortgages.push({
            account_id: m.account_id,
            name: acct.name || 'Mortgage',
            institution: item.institutionName,
            current_balance: m.current_outstanding_balance ?? acct.balances?.current ?? 0,
            minimum_payment: m.next_monthly_payment ?? 0,
            next_payment_due_date: m.next_payment_due_date,
            last_payment_date: m.last_payment_date,
            last_payment_amount: m.last_payment_amount ?? 0,
            interest_rate: m.interest_rate?.percentage ?? null,
            origination_date: m.origination_date,
            origination_principal: m.origination_principal_amount ?? 0,
            escrow_balance: m.escrow_balance ?? 0,
            ytd_interest_paid: m.ytd_interest_paid ?? 0,
            ytd_principal_paid: m.ytd_principal_paid ?? 0,
            is_overdue: m.is_overdue ?? false,
          });
        });
      }

    } catch (err) {
      // Liabilities not available for this item — fall back to account data
      console.warn(`Liabilities not available for ${item.institutionName}:`, err.response?.data?.error_code || err.message);

      // Still get account data
      try {
        const acctRes = await plaidClient.accountsGet({ access_token: item.accessToken });
        for (const acct of acctRes.data.accounts) {
          allAccounts.push({ ...acct, institution: item.institutionName });
          // Build basic credit card entries from account data if no liabilities access
          if (acct.type === 'credit') {
            allCreditCards.push({
              account_id: acct.account_id,
              name: acct.name,
              institution: item.institutionName,
              mask: acct.mask,
              current_balance: acct.balances?.current ?? 0,
              statement_balance: acct.balances?.current ?? 0,
              minimum_payment: null,
              next_payment_due_date: null,
              last_payment_date: null,
              last_payment_amount: null,
              apr: null,
              aprs: [],
              is_overdue: false,
              limited_data: true,
            });
          }
        }
      } catch (acctErr) {
        console.error('accounts fallback error:', acctErr.message);
      }
    }
  }

  res.json({
    credit_cards: allCreditCards,
    student_loans: allStudentLoans,
    mortgages: allMortgages,
    accounts: allAccounts,
  });
});

// ─── Transactions ─────────────────────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  if (store.accessTokens.length === 0) return res.json({ transactions: [], accounts: [] });
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
        added.push(...response.data.added);
        cursor = response.data.next_cursor;
        hasMore = response.data.has_more;
      }
      store.cursor[item.itemId] = cursor;
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

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Matt & Dana Finance running on port ${PORT}`);
  console.log(`   Plaid environment: ${process.env.PLAID_ENV || 'sandbox'}\n`);
});
