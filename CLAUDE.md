# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Matt & Dana Finance ("Richie") — a personal-finance web app. Wizard-style sandbox where every page/dashboard and widget is user-created (not a fixed set of screens). Two files carry almost the entire app:

- [public/index.html](public/index.html) — the entire frontend: markup, CSS, and vanilla JS all inline in one file (~9,400 lines). No framework, no bundler, no build step, no JSX. Only external deps are CDN `<script>` tags (Chart.js, SheetJS/xlsx, Plaid Link).
- [server/index.js](server/index.js) — the entire backend: a single Express app (~960 lines) with Plaid integration, OpenAI-backed "Richie" endpoints, auth, and file-based encrypted storage.

There is no test suite and no linter configured — verify changes by running the app and exercising the affected flow in a browser.

Deployed on Render; a push to `main` auto-redeploys. Combined with the git workflow below, this means `main` is effectively production — nothing lands there without review.

## Rules

- **Never break working functionality** — every change must preserve existing behavior.
- **Validate before delivering:**
  - Frontend: extract the `<script>` contents from `public/index.html` and run `new Function(js)` as a syntax check; grep for key markers you touched; confirm `<div>` open/close counts are still balanced.
  - Backend: `node --check server/index.js`.
  - For large edits to `index.html`, prefer a Python string-replacement script over shell escaping — the file is too large and quote-heavy for reliable sed/shell edits.
- Secrets (`PLAID_CLIENT_ID`/`PLAID_SECRET`, `OPENAI_API_KEY`, `SESSION_SECRET`, `TOKEN_ENC_KEY`, `APP_USERNAME`/`APP_PASSWORD`) live only in Render environment variables — never commit them or write them into a file in this repo.

## Git

Never commit directly to `main` — work on a branch and open a PR for review.

## Commands

```bash
npm install       # install deps (no lockfile committed — check before assuming exact versions)
npm start          # node server/index.js — serves http://localhost:3000
```

No `.env.example` is committed despite the README mentioning one — create `.env` from the env vars list below. Without `OPENAI_API_KEY`/Plaid keys the app still runs: AI routes return 501 and the frontend falls back to sample data.

There is no `npm test`, `npm run build`, or `npm run lint` — none are configured.

## Environment variables (read in [server/index.js](server/index.js))

- `PORT` — server port (default 3000)
- `APP_USERNAME` / `APP_PASSWORD` — permanent master login credentials (in addition to any user-created login)
- `SESSION_SECRET` — HMAC key for auth tokens; also doubles as the token-encryption key if `TOKEN_ENC_KEY` is unset. Should stay stable across restarts or saved logins/connections become invalid.
- `TOKEN_ENC_KEY` — AES-256-GCM key for encrypting Plaid tokens / app state at rest
- `DATA_DIR` — where encrypted JSON stores live (default `../.data`); point this at a persistent disk mount in production or data is lost on redeploy
- `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` (`sandbox` or `production`)
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist for cross-origin API calls (same-origin app calls don't need this)
- `OPENAI_API_KEY` — enables `/api/tts`, `/api/coach`, `/api/advisor`, `/api/onboard`, `/api/estimate`, `/api/analyze_document`; all degrade gracefully (501/fallback) without it
- `OPENAI_TTS_MODEL` / `OPENAI_COACH_MODEL` / `OPENAI_ADVISOR_MODEL` / `OPENAI_VISION_MODEL` — override default OpenAI models per feature

## Architecture

### Backend ([server/index.js](server/index.js))

Everything runs as routes on one Express app, roughly in this order:
1. Security middleware — CORS allowlist, a hand-rolled cookie parser (no `cookie-parser` dep), CSP/HSTS/security headers.
2. "Richie" AI routes (`/api/tts`, `/api/analyze_document`, `/api/coach`, `/api/advisor`, `/api/estimate`, `/api/onboard`) — thin wrappers around OpenAI's chat/speech APIs with persona prompts baked in (`PERSONA_STYLE`, `FINCLEAR_PERSONAL`/`FINCLEAR_BUSINESS`). All are anonymous-safe to call except `/api/analyze_document` and `/api/estimate`, which require auth.
3. Custom auth — no session store or JWT library. `makeToken`/`verifyToken` build a signed `timestamp:random:hmac` token stored in an httpOnly cookie (`sid`) or `Authorization: Bearer`. Login supports a user-created username/password (scrypt-hashed) *and* a permanent `APP_USERNAME`/`APP_PASSWORD` master fallback so the owner can never be locked out. Includes password reset via a one-time recovery code and in-memory per-IP login rate limiting.
4. Static file serving of `public/`, then a SPA catch-all (`app.get('*', ...)`) that always returns `index.html`.
5. Plaid integration — link token creation, token exchange (plus update-mode re-link), accounts/liabilities/transactions fetching; per-bank calls run in parallel (`Promise.all`). Transactions use a persisted per-item cursor + accumulated cache (`txncache.json`, see `syncItemTransactions`): first request per bank pulls full history, later requests apply `added`/`modified`/`removed` deltas; a rejected cursor self-heals with a full re-pull, and an unreachable bank serves its cached history. Don't store the cursor without the accumulated transactions — deltas alone aren't history.
6. Persistence — no database. Encrypted (AES-256-GCM) JSON files under `DATA_DIR`: `tokens.json` (Plaid access tokens), `appstate.json` (synced app state — layouts, categories, gamification), `txncache.json` (per-item transaction cursor + history), and `auth.json` (hashed user login). Each has a `loadX`/`saveX` pair that transparently upgrades legacy plaintext to the encrypted format.
7. App-state sync (`/api/state`) — lets multiple devices in a household share one state blob. Merge rule: **newest save wins** (the incoming push replaces the stored copy) with two exceptions — XP/level are monotonic (max survives), and a **narrow anti-wipe guard** rejects a push *only* when it would replace a populated dashboard (>0 widgets) with a zero-widget "gate" state (`_stateMaxWidgets`). The response reports `kept: 'incoming'|'existing'` so the client can surface a rejected push. Do **not** re-add a broad widget-ratchet that rejects any shrink — it silently discarded legitimate edits (completing a goal / deleting a widget) and reverted whole sessions; only the all-the-way-to-zero gate is the corruption worth blocking.
8. A duplicate-bank failsafe (`dedupeAccounts`, `_acctNatKey`) drops accounts/transactions that are a re-link of an already-connected bank, keyed by institution+mask+name+subtype (not Plaid's account_id, which changes on re-link).

### Frontend ([public/index.html](public/index.html))

Single global mutable state object `APP` (defined ~line 4584: household, profiles, persona, level, xp, pages, activePage, etc.) drives the whole UI. Key patterns:

- **Storage wrapper**: all reads/writes go through `LS`/`SS` (safe wrappers around `localStorage`/`sessionStorage`, `_makeSafe`) that fall back to an in-memory store when the browser blocks storage (private mode, tracking prevention) — never call `localStorage` directly. **Gotcha (hard-won):** `_makeSafe.getItem` must fall back to the in-memory copy whenever real storage returns `null`, not only when it *throws*. Edge/Strict tracking prevention silently drops writes and returns `null` on read (no exception), which otherwise strands a just-written value as unreadable — the root cause of a long "stuck at the build gate on reload" hunt.
- **Persistence & restore flow** (respect these invariants — violating them reintroduces the reload-wipe bug): `saveState()` must stay **synchronous** — it calls `_saveActiveLayout()` (folds live `APP.pages` into `APP.layouts[profile]`, which is what restore reads and what pushes ship) *before* writing `richie_app` and before `syncPush()`; deferring any of it lets pushes ship stale/empty layouts. On boot a returning user with cleared storage is restored from the server: `start()` checks `/api/auth_status` (a configured login ⇒ show login, not onboarding), and `enterApp()`/`doLogin()` pull `/api/state` and apply it *before* `loadState()` so it never falls into the "setup but no app" blank-gate branch. That gate branch is **in-memory only** — it must never persist or push. The client also refuses to push a widget-less `APP` once a real dashboard has been seen this session (`_sawWidgets`), and `syncPull` applies adopted state **in place** (no `location.reload()`, which re-triggered the wipe cycle on storage-clearing browsers). Full reset uses `POST /api/full_reset` (deletes `appstate.json`; optional bank disconnect) plus an `rz_force_onboard` flag so the wiped device runs onboarding instead of the returning-user restore path.
- **State keys**: `richie_app` (serialized `APP`), `richie_setup` (onboarding profile), plus feature-specific keys under `SYNC_KEYS` (`mdf_categories`, `mdf_txn_notes`, `mdf_fire`, `mdf_gami`, etc.) that get pushed/pulled via `/api/state` for cross-device sync.
- **Pages/widgets**: the dashboard is user-authored — `APP.pages` is an array of pages, each with a `widgets` array; `renderCanvas(page)` / `renderWidgetBody(w)` render them. There's no fixed set of screens to look for; check `APP.pages` shape and `renderWidgetBody` for what widget types exist.
- **Financial engine functions**: a large set of pure-ish `eng*` functions (`engNetBalance`, `engSpend`, `engIncome`, `engBudgetVsActual`, `engCashFlowProjection`, `engCategoryBreakdown`, ...) derive all dashboard numbers from `allAccts`/`allTxns` (Plaid data) plus manual accounts/bills/income (`APP.manualAccounts`, `APP.manualBills`, `_incomeList`). Start here when a number on screen looks wrong — it's almost always computed in one of these.
- **Categorization**: transaction categories are resolved through a layered lookup — explicit user rule (`mdf_cat_rules`) → Plaid category mapping (`mapPlaidCategory`) → default. Category defs come from `getUserCategories()`, falling back to `DEFAULT_CATEGORIES`.
- **Richie persona/coaching**: `richieSay`, `newRichieTip`/`richieCoachNow` call `/api/coach` with the current screen context; `PERSONA_STYLE` on the backend must stay in sync with the persona ids used on the frontend (`coach`, `crusher`, `accountant`, `mascot`, `retired`, `investor`).
- Auth/session on the frontend is token-based (no cookies required client-side beyond the httpOnly `sid`) — see the `/api/login`, `/api/auth_status`, `/api/set_password` fetch calls near the bottom of the file for the login/onboarding flow.

### Editing the frontend

Because it's one large file, use `Grep` to jump to relevant sections rather than reading top-to-bottom — search for the specific `eng*` function, `/api/...` fetch call, or `function render...` you need. Line numbers shift easily; re-grep rather than trusting stale line numbers across edits.

### Deploy config

[render.yaml](render.yaml) is the canonical Render deploy config (referenced by the README). A legacy stray `download` file — an older browser-downloaded copy with a deprecated schema and a self-rotating `SESSION_SECRET` (`generateValue: true`) that would invalidate saved logins/tokens on every deploy — was removed; don't reintroduce it.
