# Matt &amp; Dana Finance 💰

A personal-finance web app that treats money like a journey, not a chore — guided by **Richie**, a money-bag assistant. Built as a fully customizable, wizard-style sandbox: every page and widget is user-created.

## What's in this package

```
.
├── public/
│   └── index.html        ← the entire frontend (single page, ~159KB)
├── server.js             ← Node/Express + Plaid backend
├── package.json
├── .env.example          ← copy to .env and fill in Plaid keys
├── .gitignore
└── README.md
```

The frontend is self-contained (Chart.js loaded via CDN). It calls four API routes — `/api/accounts`, `/api/transactions`, `/api/create_link_token`, `/api/exchange_token` — and **gracefully falls back to sample data** when the server or Plaid isn't available, so it runs even before a bank is linked.

## Run locally

```bash
npm install
cp .env.example .env      # then add your Plaid keys
npm start                 # http://localhost:3000
```

Without Plaid keys the app still runs — widgets show clearly-labeled sample data.

## Deploy to Render

1. **Push to GitHub** (see commands below).
2. In Render: **New → Web Service**, connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** add `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (Render provides `PORT` automatically).
4. Deploy. Render gives you a public URL.

### Push to GitHub

If this replaces your existing repo contents:

```bash
git init
git add .
git commit -m "Richie rebuild: sandbox app + ported engine"
git branch -M main
git remote add origin https://github.com/mtownend89-droid/psychic-disco.git
git push -u origin main          # use --force only if intentionally overwriting
```

If the repo is already cloned, just copy these files in, then:

```bash
git add .
git commit -m "Richie rebuild: sandbox app + ported engine"
git push
```

## Notes

- **Access tokens** are kept in memory in `server.js` for simplicity. For multi-user or persistence, store them per-user in a database.
- **Richie's AI backend** is not wired yet by design. The seam is `newRichieTip()` / `richieSay()` in `index.html` — swap the static persona quips there for live API calls (pass persona + level + financial context).
- The frontend persists state in `localStorage` (`richie_setup`, `richie_app`, `mdf_categories`, `mdf_fire`).
