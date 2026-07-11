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
5. Plaid integration — link token creation, token exchange, accounts/liabilities/transactions fetching. `transactionsSync` is always paginated from scratch (no stored cursor) so responses stay the complete history rather than only-new-since-last-sync.
6. Persistence — no database. Two encrypted (AES-256-GCM) JSON files under `DATA_DIR`: `tokens.json` (Plaid access tokens) and `appstate.json` (synced app state — layouts, categories, gamification). `auth.json` similarly holds the hashed user login. All three have a `loadX`/`saveX` pair that transparently upgrades legacy plaintext to the encrypted format.
7. App-state sync (`/api/state`) — lets multiple devices in a household share one state blob. Merge rule: XP/level are monotonic (max of both sides survives), everything else is last-write-wins by `_ts` timestamp.
8. A duplicate-bank failsafe (`dedupeAccounts`, `_acctNatKey`) drops accounts/transactions that are a re-link of an already-connected bank, keyed by institution+mask+name+subtype (not Plaid's account_id, which changes on re-link).

### Frontend ([public/index.html](public/index.html))

Single global mutable state object `APP` (defined ~line 4584: household, profiles, persona, level, xp, pages, activePage, etc.) drives the whole UI. Key patterns:

- **Storage wrapper**: all reads/writes go through `LS`/`SS` (safe wrappers around `localStorage`/`sessionStorage`, `_makeSafe`) that fall back to an in-memory store when the browser blocks storage (private mode, tracking prevention) — never call `localStorage` directly.
- **State keys**: `richie_app` (serialized `APP`), `richie_setup` (onboarding profile), plus feature-specific keys under `SYNC_KEYS` (`mdf_categories`, `mdf_txn_notes`, `mdf_fire`, `mdf_gami`, etc.) that get pushed/pulled via `/api/state` for cross-device sync.
- **Pages/widgets**: the dashboard is user-authored — `APP.pages` is an array of pages, each with a `widgets` array; `renderCanvas(page)` / `renderWidgetBody(w)` render them. There's no fixed set of screens to look for; check `APP.pages` shape and `renderWidgetBody` for what widget types exist.
- **Financial engine functions**: a large set of pure-ish `eng*` functions (`engNetBalance`, `engSpend`, `engIncome`, `engBudgetVsActual`, `engCashFlowProjection`, `engCategoryBreakdown`, ...) derive all dashboard numbers from `allAccts`/`allTxns` (Plaid data) plus manual accounts/bills/income (`APP.manualAccounts`, `APP.manualBills`, `_incomeList`). Start here when a number on screen looks wrong — it's almost always computed in one of these.
- **Categorization**: transaction categories are resolved through a layered lookup — explicit user rule (`mdf_cat_rules`) → Plaid category mapping (`mapPlaidCategory`) → default. Category defs come from `getUserCategories()`, falling back to `DEFAULT_CATEGORIES`.
- **Richie persona/coaching**: `richieSay`, `newRichieTip`/`richieCoachNow` call `/api/coach` with the current screen context; `PERSONA_STYLE` on the backend must stay in sync with the persona ids used on the frontend (`coach`, `crusher`, `accountant`, `mascot`, `retired`, `investor`).
- Auth/session on the frontend is token-based (no cookies required client-side beyond the httpOnly `sid`) — see the `/api/login`, `/api/auth_status`, `/api/set_password` fetch calls near the bottom of the file for the login/onboarding flow.

### Editing the frontend

Because it's one large file, use `Grep` to jump to relevant sections rather than reading top-to-bottom — search for the specific `eng*` function, `/api/...` fetch call, or `function render...` you need. Line numbers shift easily; re-grep rather than trusting stale line numbers across edits.

### Stray files

A top-level `download` file and [render.yaml](render.yaml) both look like Render deploy configs but differ from each other (different env var sets, different start commands) — `render.yaml` is the one referenced by the README's deploy instructions; treat `download` as legacy/unused unless told otherwise.
