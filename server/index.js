require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const compression = require('compression');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { Readable } = require('stream');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.set('trust proxy', 1);
app.use(compression());   // gzip responses (client-negotiated) — biggest win for the ~660KB index.html
app.use('/api/analyze_document', express.json({ limit: '30mb' }));   // statement/bill uploads (base64) can be several MB
app.use('/api/state', express.json({ limit: '6mb' }));               // full app-state sync blob
app.use(express.json({ limit: '50kb' }));
// ── CORS: locked to an allowlist. Set ALLOWED_ORIGINS in env (comma-separated) if
//    you ever call the API from a different domain. Same-origin app calls are
//    unaffected — browsers don't enforce CORS on same-origin requests.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                    // same-origin / server-to-server
    return cb(null, ALLOWED_ORIGINS.includes(origin));     // cross-origin only if allowlisted
  },
  credentials: true,
}));

// ── Minimal cookie parser (no extra dependency) ──
app.use((req, _res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) req.cookies[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  next();
});

// ── Security headers on every response ──
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://*.plaid.com",
  "frame-src https://cdn.plaid.com https://*.plaid.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
const APP_USER   = (process.env.APP_USERNAME || '').trim();
const APP_PASS   = (process.env.APP_PASSWORD || '').trim();
const APP_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!APP_USER || !APP_PASS) {
  console.warn('⚠️  APP_USERNAME or APP_PASSWORD not set — login will fail');
  console.warn('   Set them in Render → Environment');
}

// ── RICHIE VOICE (OpenAI TTS, streamed) ─────────────────────────────────────────
// Streams the audio straight through so the first bytes reach the browser fast.
// gpt-4o-mini-tts carries the persona tone via the `instructions` field.
// Set OPENAI_TTS_MODEL=tts-1 in Render for a faster (flatter) voice if you prefer.
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice, instructions } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'no text' });
    }
    if (!process.env.OPENAI_API_KEY) {
      // Not configured → the app quietly falls back to the device voice.
      return res.status(501).json({ error: 'TTS not configured' });
    }

    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: voice || 'cedar',                       // cedar/marin = newest, highest quality
        input: String(text).slice(0, 1000),            // safety cap
        instructions: instructions ||
          'Speak as Richie, a warm, upbeat money coach. Friendly, encouraging, conversational pace.',
        response_format: 'mp3',
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error('OpenAI TTS error', upstream.status, detail);
      return res.status(502).json({ error: 'tts upstream', status: upstream.status });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    // Stream the upstream body straight to the client (Node 18+).
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    console.error('TTS route error', e);
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// ── RICHIE DOCUMENT ANALYSIS (statements/bills → structured data) ────────────────
function _trimStatement(text, limit) {
  text = String(text || '');
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  let idx = -1;
  for (const kw of ['common stocks', 'holdings', 'exchange-traded', 'security description', 'account detail', 'asset allocation', 'positions']) {
    const i = lower.indexOf(kw); if (i >= 0) { idx = i; break; }
  }
  const head = text.slice(0, 7000);
  if (idx < 0) return text.slice(0, limit);
  const region = text.slice(Math.max(0, idx - 800), idx + (limit - 8000));
  return head + '\n[... additional pages omitted ...]\n' + region;
}
app.post('/api/analyze_document', requireAuth, async (req, res) => {
  const { file, mimeType, filename } = req.body || {};
  if (!file) return res.status(400).json({ error: 'No file provided.' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Document analysis needs OPENAI_API_KEY set on the server.' });
  const SYSTEM = 'You extract structured data from ANY financial document that matters to a person\'s finances: bank statements, credit-card statements, brokerage/IRA/401k/retirement investment statements, insurance statements, loan/mortgage statements, and any recurring bill (phone, cable/internet, electric/gas/water utilities, streaming, medical, rent, HOA, etc.). First identify the document type, then fill the matching fields. Return ONLY valid minified JSON, no prose, no markdown fences. Schema: {"docType":"bank_statement|credit_card|investment|insurance|loan|utility|phone|cable|bill|receipt|credit_score|other","institution":string|null,"accountName":string|null,"accountMask":string|null,"statementBalance":number|null,"accountValue":number|null,"amountDue":number|null,"premium":number|null,"dueDate":"YYYY-MM-DD"|null,"apr":number|null,"creditLimit":number|null,"minimumPayment":number|null,"transactions":[{"date":"YYYY-MM-DD","description":string,"amount":number}],"holdings":[{"name":string,"symbol":string|null,"shares":number|null,"value":number,"costBasis":number|null,"gain":number|null}],"periodContribution":number|null,"ytdContribution":number|null,"creditScore":number|null,"scoreDate":"YYYY-MM-DD"|null,"scoreModel":string|null,"promoAPR":number|null,"promoEndDate":"YYYY-MM-DD"|null,"promoBalance":number|null,"promoDescription":string|null}. Rules: bank_statement/credit_card -> statementBalance + transactions (amount sign: POSITIVE=charge/purchase money out, NEGATIVE=payment/credit/refund money in); credit_card also amountDue, apr, creditLimit, minimumPayment. For credit_card and loan statements ALSO look for promotional/introductory rate details — usually in an "Interest Charge Calculation" table, a "Promotional balances" section, or a deferred-interest notice: promoAPR = the promotional rate as a number (0 for 0% intro APR), promoEndDate = the promotion or deferred-interest expiration date, promoBalance = the balance subject to that promotional rate when itemized separately, promoDescription = a short label like "0% intro APR on purchases" or "Deferred interest promotion". All four null when the statement shows no promotion. investment -> accountValue = the account ENDING TOTAL VALUE (labeled e.g. "Ending Total Value" or "TOTAL VALUE"); accountName should include the account type (e.g. "Roth IRA","Traditional IRA","401k","Brokerage"). Pull EVERY position from the HOLDINGS / STOCKS / COMMON STOCKS / EXCHANGE-TRADED & CLOSED-END FUNDS / MUTUAL FUNDS / CASH sections. For each security use its summary/TOTAL row (which already combines Purchases + Reinvestments) for shares (Quantity) and value (Market Value) — do NOT output the separate Purchases/Reinvestments sub-rows as their own holdings. The ticker symbol is usually in parentheses in the name: "NVIDIA CORPORATION (NVDA)"->NVDA, "VANGUARD S&P 500 ETF (VOO)"->VOO, "STATE STREET SPDR PORTFOLIO (SPYD)"->SPYD. Include cash / money-market / bank-deposit balances as one holding named "Cash". For each holding also set costBasis = its Total Cost and gain = its Unrealized Gain/(Loss) (negative for a loss) when shown. investment holdings must sum close to accountValue. For investment statements also extract money the OWNER added to the account (contributions, deposits, employee + employer 401k contributions — NOT dividends, reinvestments of dividends, or market gains): periodContribution = total added during this statement period, ytdContribution = the year-to-date contributions total when the statement shows one; null when not shown. credit_score -> a credit-score screen or report snippet (Credit Karma, Experian, a FICO or VantageScore display, or the score page inside a card issuer app): creditScore = the score number (300-850), scoreDate = the "as of" or "updated" date when shown (else null), scoreModel = the model name when shown (e.g. "FICO Score 8", "VantageScore 3.0"), institution = the app, bureau, or issuer showing the score. insurance -> premium + dueDate. loan/mortgage -> statementBalance (amount owed), amountDue, minimumPayment, apr, dueDate. utility/phone/cable/bill -> amountDue + dueDate (institution = the provider). Always set institution to the company/provider name. Use null for unknown fields, dates YYYY-MM-DD, numbers with no currency symbols or commas. If truly unreadable, return {"error":"reason"}.';
  try {
    let userContent;
    const mt = (mimeType || '').toLowerCase();
    if (mt.startsWith('image/')) {
      userContent = [
        { type: 'text', text: 'Extract the financial data from this statement/bill image.' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${file}` } },
      ];
    } else if (mt.includes('pdf')) {
      let text = '';
      try { const pdfParse = require('pdf-parse'); const d = await pdfParse(Buffer.from(file, 'base64')); text = d.text || ''; }
      catch (e) { return res.status(422).json({ error: "Couldn't read that PDF (the pdf-parse package may not be installed). Upload a screenshot/image of the statement instead." }); }
      if (!text.trim()) return res.status(422).json({ error: 'That PDF looks like a scanned image with no text — upload it as an image (PNG/JPG) instead.' });
      userContent = `Extract the financial data from this statement text:\n\n${_trimStatement(text, 60000)}`;
    } else {
      const text = Buffer.from(file, 'base64').toString('utf8');
      userContent = `Extract the financial data from this file (${filename || 'upload'}):\n\n${_trimStatement(text, 60000)}`;
    }
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }],
        max_tokens: 3500, temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!r.ok) { const d = await r.text().catch(() => ''); console.error('analyze_document AI error', r.status, d.slice(0, 300)); return res.status(502).json({ error: 'AI analysis failed — try again, or use a clearer image.' }); }
    const data = await r.json();
    let parsed;
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); }
    catch (e) { return res.status(502).json({ error: "Couldn't parse the analysis result." }); }
    if (parsed.error) return res.status(422).json({ error: parsed.error });
    if (Array.isArray(parsed.transactions)) parsed.transactions = parsed.transactions.slice(0, 500);
    res.json({ result: parsed });
  } catch (e) {
    console.error('analyze_document error', e);
    res.status(500).json({ error: 'Analysis failed — ' + (e.message || 'unknown error') });
  }
});

// ── RICHIE AI COACH (OpenAI chat) ───────────────────────────────────────────────
const PERSONA_STYLE = {
  coach:      'a warm, encouraging coach. Celebrate progress, keep it kind.',
  crusher:    'a tough-love debt crusher. Punchy, urgent, no excuses — but never mean.',
  accountant: 'a precise, dry, matter-of-fact accountant. Exact and calm.',
  mascot:     'a hyper, goofy cartoon mascot. Playful, high-energy, a little silly.',
  retired:    'a relaxed retired millionaire. Big-picture, unhurried, wise.',
  investor:   'a patient, folksy value investor. Calm, long-term, reassuring.',
};

// ── Deep financial-advisor knowledge (folded in from FinClear) ──────────────────
// Gives Richie real breadth + depth to draw on. Used by the coach (short tips) and
// the advisor route (full answers). Frontend/persona are unchanged.
const FINCLEAR_PERSONAL = 'You have deep personal-finance expertise spanning: budgeting (50/30/20, zero-based, envelope), '
  + 'emergency funds, debt repayment (avalanche vs snowball), investing basics (index funds, ETFs, 401k, IRA, Roth IRA, brokerage, '
  + 'dollar-cost averaging, diversification), credit scores, insurance, mortgages, tax strategy, and retirement planning '
  + '(Social Security, safe withdrawal rates, sequence-of-returns risk). Core principles: use plain English and define any term you use; '
  + 'be warm and non-judgmental (many people feel shame about money — normalize it); when given real numbers, work with them specifically '
  + 'with concrete examples; NEVER give specific stock/crypto picks — principles only; flag when a licensed CFP or CPA is genuinely warranted; '
  + 'this is educational guidance, not professional financial advice.';
const FINCLEAR_BUSINESS = 'You also advise small businesses, freelancers, and LLCs on: separating personal & business finances, '
  + 'cash-flow management, accounts receivable/payable, P&L statements, balance sheets, pricing for profitability, break-even analysis, '
  + 'quarterly estimated taxes, deductions (Schedule C, S-corp, home office, mileage, depreciation), business credit, SBA loans, '
  + 'invoice financing, payroll and bookkeeping basics, and financial forecasting. Always recommend a licensed CPA for actual tax filings; '
  + 'educational guidance only.';

app.post('/api/coach', async (req, res) => {
  try {
    const { context = {}, persona = 'coach', level = 1, seen = [] } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ error: 'coach not configured' });
    }

    const style = PERSONA_STYLE[persona] || PERSONA_STYLE.coach;
    const sys = [
      `You are Richie, an in-app money coach. Speak as ${style}`,
      `The user is at knowledge level ${level} of 5 (1 = brand new, 5 = expert).`,
      `Give ONE short, specific, helpful pointer (max 2 sentences) about what is on their screen right now.`,
      `Always end with one concrete action. Never shame the user.`,
      `At low levels explain basics simply; at high levels be sharper and more strategic. No fluff, no greeting every time.`,
      `Ground the tip in the actual numbers provided. Never invent figures. Do not repeat any idea in the "alreadySeen" list.`,
      `Plain text only — no markdown, no emoji unless the persona is the mascot.`,
      `Draw on this expertise so your pointer is genuinely smart and correct (but keep it to the short format above): ${FINCLEAR_PERSONAL}`,
      `If the context has a "gamification" block with a nextMilestone, you may occasionally nudge the user one concrete step toward it (e.g. their next badge or streak) — only when it fits naturally.`,
    ].join(' ');

    const user = JSON.stringify({ screen: context, alreadySeen: seen });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_COACH_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        max_tokens: 90,
        temperature: 0.7,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('OpenAI coach error', r.status, detail);
      return res.status(502).json({ error: 'coach upstream', status: r.status });
    }

    const data = await r.json();
    const tip = (data.choices?.[0]?.message?.content || '').trim();
    res.json({ tip });
  } catch (e) {
    console.error('coach route error', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// ── RICHIE DEEP ADVISOR (full FinClear-style answers, multi-turn) ───────────────
// Same Richie voice/persona, but for in-depth questions: multi-turn, personal OR
// small-business mode, grounded in the user's live numbers when provided.
app.post('/api/advisor', async (req, res) => {
  try {
    const { messages = [], mode = 'personal', persona = 'coach', level = 1, context = null } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ error: 'advisor not configured' });
    }
    const style = PERSONA_STYLE[persona] || PERSONA_STYLE.coach;
    const domain = mode === 'business' ? (FINCLEAR_PERSONAL + ' ' + FINCLEAR_BUSINESS) : FINCLEAR_PERSONAL;
    const sys = [
      `You are Richie, a warm, sharp in-app financial advisor — the money-bag coach. Speak as ${style}`,
      `The user is at knowledge level ${level} of 5; calibrate how much you explain accordingly.`,
      domain,
      context
        ? `Here is the user's live financial context — ground your answer in these real numbers and never invent figures: ${JSON.stringify(context)}`
        : `If you genuinely need a number the user has not given, ask ONE short clarifying question rather than guessing.`,
      `Answer clearly and concretely. You may use **bold** for key terms, short bullet lists, and put a key number or formula on its own line. Keep it focused and actionable with no long preamble. Stay encouraging; never shame.`,
      `If the context includes a "gamification" block, you may motivate the user by referencing their level, streak, or how close they are to their next milestone — and offer a concrete step to reach it. Keep it natural, not gimmicky.`,
    ].join(' ');

    const convo = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12);
    if (!convo.length) return res.status(400).json({ error: 'no messages' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_ADVISOR_MODEL || process.env.OPENAI_COACH_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, ...convo],
        max_tokens: 700,
        temperature: 0.6,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('OpenAI advisor error', r.status, detail);
      return res.status(502).json({ error: 'advisor upstream', status: r.status });
    }
    const data = await r.json();
    const reply = (data.choices?.[0]?.message?.content || '').trim();
    res.json({ reply });
  } catch (e) {
    console.error('advisor route error', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// ── RICHIE VALUE ESTIMATOR (VIN decode via free NHTSA API + AI dollar ballpark) ──
async function aiDollarEstimate(thing) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_COACH_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You give rough US dollar value estimates. Reply with ONLY a single whole number of US dollars — no symbols, words, or commas. If you cannot estimate, reply 0.' },
          { role: 'user', content: `Estimate the value of: ${thing}` },
        ],
        max_tokens: 12, temperature: 0.2,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const n = parseInt((data.choices?.[0]?.message?.content || '').replace(/[^0-9]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

app.post('/api/estimate', requireAuth, async (req, res) => {
  const { type, vin, address } = req.body || {};
  try {
    if (type === 'vehicle') {
      const clean = String(vin || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (clean.length < 11) return res.status(400).json({ error: 'Enter the full VIN (usually 17 characters).' });
      let label = '';
      try {
        const vr = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${encodeURIComponent(clean)}?format=json`);
        const vd = await vr.json();
        const v = (vd.Results && vd.Results[0]) || {};
        label = [v.ModelYear, v.Make, v.Model, v.Trim].filter(Boolean).join(' ').trim();
      } catch (_) {}
      if (!label) return res.status(422).json({ error: "Couldn't decode that VIN." });
      const value = await aiDollarEstimate(`a used ${label} in average condition — typical private-party resale value in US dollars`);
      return res.json({ label, value: value || null, note: 'Rough estimate — confirm on KBB or Edmunds.' });
    }
    if (type === 'home') {
      const a = String(address || '').trim();
      if (a.length < 5) return res.status(400).json({ error: 'Enter an address or ZIP plus a few home details.' });
      const value = await aiDollarEstimate(`a typical single-family home at or near "${a}" — a rough, conservative US market value in dollars`);
      return res.json({ label: a, value: value || null, note: 'Very rough ballpark from limited info — verify on Zillow or Redfin and adjust.' });
    }
    return res.status(400).json({ error: 'Provide a VIN (vehicle) or address (home).' });
  } catch (e) {
    console.error('estimate route error', e);
    res.status(500).json({ error: 'Estimate failed — you can enter the value manually.' });
  }
});

// ── RICHIE AI ONBOARDING (adaptive interview → profile) ─────────────────────────
app.post('/api/onboard', async (req, res) => {
  try {
    const { history = [], mode = 'next' } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ error: 'onboard not configured' });
    }
    const convo = history.map(h => `Richie: ${h.q}\nUser: ${h.a || ''}`).join('\n') || '(no answers yet)';

    let sys, wantJson = false;
    if (mode === 'finalize') {
      wantJson = true;
      sys = 'You are Richie, a money coach. From this onboarding conversation, infer the user\'s profile. '
        + 'Return ONLY valid JSON (no markdown, no prose) with exactly these keys: '
        + '"level" (integer 1-5 for financial literacy/experience), '
        + '"persona" (one of: coach, crusher, accountant, mascot, retired, investor — the coaching style that fits them best), '
        + '"goals" (array of 1-4 objects, each {"name": short label under 5 words, "metric": one of emergency, debt, savings, networth, savingsrate, retirement}), '
        + '"summary" (one short sentence). Base everything strictly on what the user actually said.';
    } else {
      wantJson = true;
      sys = 'You are Richie, a warm, sharp money coach onboarding a new user. '
        + 'Based on the conversation so far, ask ONE short, friendly, specific question (max 18 words) to learn their financial literacy, situation, or goals, '
        + 'AND provide 3-4 short multiple-choice answer options (each max 8 words) spanning the likely range of answers so they can just tap one. '
        + 'Adapt to what they have already said; never repeat an earlier question; vary the angle. '
        + 'Return ONLY valid JSON: {"question":"...","options":["...","...","..."]}';
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_COACH_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: convo }],
        max_tokens: wantJson ? 260 : 60,
        temperature: mode === 'finalize' ? 0.3 : 0.8,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('OpenAI onboard error', r.status, detail);
      return res.status(502).json({ error: 'onboard upstream', status: r.status });
    }
    const data = await r.json();
    let content = (data.choices?.[0]?.message?.content || '').trim();
    content = content.replace(/```json|```/g, '').trim();
    try { return res.json(JSON.parse(content)); }   // finalize → {level,persona,goals}; next → {question,options}
    catch (e) { return res.json({}); }               // client falls back to its own questions/heuristic
  } catch (e) {
    console.error('onboard route error', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// ── TOKEN AUTH ────────────────────────────────────────────────────────────────
// Simple signed token stored in sessionStorage — no cookies needed
function makeToken() {
  const ts  = Date.now().toString();
  const rnd = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(ts + ':' + rnd).digest('hex');
  return Buffer.from(ts + ':' + rnd + ':' + sig).toString('base64');
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length < 3) return false;
    const sig      = parts[parts.length - 1];
    const rnd      = parts[parts.length - 2];
    const ts       = parts.slice(0, parts.length - 2).join(':');
    const expected = crypto.createHmac('sha256', APP_SECRET).update(ts + ':' + rnd).digest('hex');
    if (sig.length !== expected.length) return false;
    const match = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    if (!match) return false;
    const age = Date.now() - parseInt(ts, 10);
    return age < 7 * 24 * 60 * 60 * 1000; // 7 days
  } catch (e) {
    return false;
  }
}

function requireAuth(req, res, next) {
  const cookieTok = req.cookies && req.cookies.sid;
  if (cookieTok && verifyToken(cookieTok)) return next();
  const header = (req.headers['authorization'] || '').trim();
  const token  = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const a = loadAuth();
  res.json({
    status: 'ok',
    env:    (process.env.PLAID_ENV || 'sandbox').trim().toLowerCase(),
    user_set: !!APP_USER,
    pass_set: !!APP_PASS,
    login_configured: !!(a && a.pwHash),
    openai_set: !!process.env.OPENAI_API_KEY,
    connections: store.accessTokens.length,
    connection_names: store.accessTokens.map(t => t.institutionName),
  });
});

// ── Login rate limiting (in-memory, per-IP; no dependency) ──
const LOGIN_MAX_FAILS = 5;                  // failed attempts allowed within the window
const LOGIN_WINDOW_MS = 15 * 60 * 1000;     // rolling window
const LOGIN_BLOCK_MS  = 15 * 60 * 1000;     // lockout length once tripped
const loginAttempts = new Map();            // ip -> { fails, first, blockedUntil }

function loginRateGate(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  if (loginAttempts.size > 1000) {          // opportunistic prune
    for (const [k, v] of loginAttempts)
      if ((now - v.first) > LOGIN_WINDOW_MS && (!v.blockedUntil || v.blockedUntil < now)) loginAttempts.delete(k);
  }
  const rec = loginAttempts.get(ip);
  if (rec && rec.blockedUntil > now) {
    const secs = Math.ceil((rec.blockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(secs));
    return res.status(429).json({ error: `Too many attempts. Try again in about ${Math.ceil(secs / 60)} min.` });
  }
  next();
}
function recordLoginFail(req) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || (now - rec.first) > LOGIN_WINDOW_MS) rec = { fails: 0, first: now, blockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(ip, rec);
}
function recordLoginSuccess(req) { loginAttempts.delete(req.ip || 'unknown'); }

app.post('/api/login', loginRateGate, (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const u = String(username).trim();
  const p = String(password);

  console.log(`Login attempt: "${u}" (pass length: ${p.length})`);

  const a0 = loadAuth();
  if ((!a0 || !a0.pwHash) && (!APP_USER || !APP_PASS)) {
    return res.status(500).json({ error: 'Server not configured — set a login, or set APP_USERNAME and APP_PASSWORD in Render.' });
  }
  if (checkCredentials(u, p)) {
    const token = makeToken();
    setLoginCookie(res, token);
    console.log('Login successful ✓');
    recordLoginSuccess(req);
    return res.json({ success: true, ok: true });   // no token in the body
  }
  console.log('Login failed — credentials did not match');
  recordLoginFail(req);
  return res.status(401).json({ error: 'Incorrect username or password' });
});

// Has a user-set login been created yet? (drives first-run "create login" screen)
app.get('/api/auth_status', (req, res) => {
  const a = loadAuth();
  res.json({ configured: !!(a && a.pwHash) });
});

// First-run: create the login. Allowed only when none is set yet.
app.post('/api/set_password', loginRateGate, (req, res) => {
  const a = loadAuth();
  if (a && a.pwHash) return res.status(409).json({ error: 'A login already exists. Use Change password or Forgot password.' });
  const u = String((req.body || {}).username || '').trim();
  const p = String((req.body || {}).password || '');
  if (u.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (p.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const recovery = genRecoveryCode();
  saveAuth({ username: u, pwHash: hashSecret(p), recoveryHash: hashSecret(recovery) });
  setLoginCookie(res, makeToken());   // auto sign-in
  console.log('Login created for:', u);
  return res.json({ ok: true, recovery_code: recovery });
});

// Change password (must be signed in; verify current — user password or env master).
app.post('/api/change_password', requireAuth, (req, res) => {
  const cur = String((req.body || {}).current || '');
  const nw  = String((req.body || {}).new || '');
  if (nw.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const a = loadAuth();
  const okCur = (a && a.pwHash && verifySecret(cur, a.pwHash)) || (APP_PASS && cur === APP_PASS);
  if (!okCur) return res.status(403).json({ error: 'Current password is incorrect.' });
  const username = (a && a.username) || APP_USER || 'user';
  const recovery = genRecoveryCode();
  saveAuth({ username, pwHash: hashSecret(nw), recoveryHash: hashSecret(recovery) });
  return res.json({ ok: true, recovery_code: recovery });
});

// Forgot password: reset with the recovery code shown when the password was set.
app.post('/api/reset_password', loginRateGate, (req, res) => {
  const u    = String((req.body || {}).username || '').trim();
  const code = String((req.body || {}).recovery_code || '').trim().toUpperCase().replace(/\s+/g, '');
  const nw   = String((req.body || {}).new_password || '');
  if (nw.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const a = loadAuth();
  if (!(a && a.recoveryHash && u === a.username && verifySecret(code, a.recoveryHash))) {
    recordLoginFail(req);
    return res.status(403).json({ error: 'Username or recovery code is incorrect.' });
  }
  const recovery = genRecoveryCode();
  saveAuth({ username: a.username, pwHash: hashSecret(nw), recoveryHash: hashSecret(recovery) });
  setLoginCookie(res, makeToken());   // auto sign-in
  return res.json({ ok: true, recovery_code: recovery });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('sid', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
  res.json({ success: true });
});

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── PLAID ─────────────────────────────────────────────────────────────────────
const PLAID_ENV       = (process.env.PLAID_ENV || 'sandbox').trim().toLowerCase();
const PLAID_CLIENT_ID = (process.env.PLAID_CLIENT_ID || '').trim();   // trim: stray newline/space in the env value is a common cause of "invalid client_id or secret"
const PLAID_SECRET    = (process.env.PLAID_SECRET || '').trim();
if (!PlaidEnvironments[PLAID_ENV]) {
  console.warn(`⚠️  PLAID_ENV="${PLAID_ENV}" is not valid — use exactly "sandbox" or "production". Falling back to sandbox.`);
}
if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.warn('⚠️  PLAID_CLIENT_ID or PLAID_SECRET is missing in the environment.');
}
console.log(`Plaid config → env: ${PLAID_ENV} | client_id: ${PLAID_CLIENT_ID ? PLAID_CLIENT_ID.slice(0,6)+'…(len '+PLAID_CLIENT_ID.length+')' : 'MISSING'} | secret: ${PLAID_SECRET ? 'set (len '+PLAID_SECRET.length+')' : 'MISSING'}`);
const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV] || PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET':    PLAID_SECRET,
    },
  },
}));

// ── TOKEN STORE ───────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../.data');   // point at a Render Persistent Disk mount (e.g. /var/data) so tokens/auth survive redeploys
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'appstate.json');   // synced app state (layouts, edits, holdings, etc.)

// Encrypt the Plaid access tokens at rest (AES-256-GCM). Key is derived from
// TOKEN_ENC_KEY (or SESSION_SECRET). Set one of those in Render so the key is
// stable across restarts, otherwise saved connections can't be decrypted later.
if (!process.env.TOKEN_ENC_KEY && !process.env.SESSION_SECRET) {
  console.warn('⚠️  No TOKEN_ENC_KEY/SESSION_SECRET set — encrypted connections won\'t survive a restart.');
}
const ENC_KEY = crypto.createHash('sha256').update(process.env.TOKEN_ENC_KEY || APP_SECRET).digest();
function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') };
}
function decryptJSON(blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (raw && raw.v === 1 && raw.data) return decryptJSON(raw);   // encrypted store
      return raw;                                                    // legacy plaintext → re-encrypted on next save
    }
  } catch (e) { console.warn('Token load:', e.message); }
  return { accessTokens: [], cursor: {} };
}

function saveTokens(store) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(encryptJSON(store)), 'utf8');
  } catch (e) { console.warn('Token save (ok on free tier):', e.message); }
}

// ── USER CREDENTIALS (scrypt-hashed, encrypted at rest) ─────────────────────────
// A user-set password lives in .data/auth.json (AES-GCM encrypted, scrypt-hashed).
// APP_USERNAME/APP_PASSWORD from env always remain valid as a permanent master /
// recovery credential, so you can never be locked out of your own server.
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(secret), salt, 32);
  return salt.toString('hex') + ':' + dk.toString('hex');
}
function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  try {
    const dk = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), 32);
    const a = Buffer.from(hashHex, 'hex');
    return a.length === dk.length && crypto.timingSafeEqual(a, dk);
  } catch (e) { return false; }
}
function genRecoveryCode() {
  return crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'); // XXXX-XXXX-XXXX-XXXX-XXXX
}
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (raw && raw.v === 1 && raw.data) return decryptJSON(raw);
      return raw;
    }
  } catch (e) { console.warn('Auth load:', e.message); }
  return null;
}
function saveAuth(a) {
  try {
    const dir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(encryptJSON(a)), 'utf8');
  } catch (e) { console.warn('Auth save (ok on free tier):', e.message); }
}
// True if the supplied username/password match the user-set login OR the env master.
function checkCredentials(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  const a = loadAuth();
  if (a && a.pwHash && u === a.username && verifySecret(p, a.pwHash)) return true;
  if (APP_USER && APP_PASS && u === APP_USER && p === APP_PASS) return true;   // permanent master
  return false;
}
function setLoginCookie(res, token) {
  res.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
}

const store = loadTokens();
console.log(`Loaded ${store.accessTokens.length} saved connection(s)`);

// ── PROTECTED ROUTES ──────────────────────────────────────────────────────────
app.post('/api/create_link_token', requireAuth, async (req, res) => {
  const base = {
    user: { client_user_id: 'matt-dana' },
    client_name: 'Matt & Dana Finance',
    country_codes: [CountryCode.Us],
    language: 'en',
  };
  // Update mode: re-authenticate an existing item (expired login) — pass its access_token
  // and no products; the item and its accounts survive, so no re-exchange and no duplicates.
  const itemId = (req.body || {}).item_id;
  if (itemId) {
    const item = store.accessTokens.find(t => t.itemId === itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item — remove and reconnect the bank instead.' });
    try {
      const r = await plaidClient.linkTokenCreate({ ...base, access_token: item.accessToken });
      return res.json({ link_token: r.data.link_token, update_mode: true });
    } catch (e) {
      const pd = (e.response && e.response.data) || {};
      console.error('Update-mode link token failed:', pd.error_code || '', pd.error_message || e.message);
      return res.status(500).json({ error: pd.error_message || e.message, error_code: pd.error_code });
    }
  }
  try {
    const r = await plaidClient.linkTokenCreate({
      ...base,
      products: [Products.Transactions],              // widely supported → asset-only banks connect
      optional_products: [Products.Liabilities],       // fetched when the bank has them, never blocks linking
    });
    res.json({ link_token: r.data.link_token });
  } catch (err) {
    try {   // fallback for environments that reject optional_products
      const r = await plaidClient.linkTokenCreate({ ...base, products: [Products.Transactions] });
      res.json({ link_token: r.data.link_token });
    } catch (e) {
      const pd = (e.response && e.response.data) || {};
      console.error('Link token failed:', PLAID_ENV, pd.error_code || '', pd.error_message || e.message);
      res.status(500).json({ error: (pd.error_message || e.message) + ` (Plaid env: ${PLAID_ENV})`, error_code: pd.error_code });
    }
  }
});

// ── DUPLICATE FAILSAFE ──────────────────────────────────────────────────────────
// Re-linking the same bank creates a new Item whose accounts have DIFFERENT ids but the
// same real identity — so we dedupe by a natural key (institution|mask|name|subtype),
// then drop any transactions that belonged to the dropped duplicate accounts.
function _acctNatKey(a) {
  return [
    (a.institution || '').toLowerCase().trim(),
    // No mask → fall back to account_id: several same-named accounts (e.g. multiple HYSAs at
    // one bank) must never merge. Costs re-link dupe detection only for maskless accounts.
    (a.mask || a.account_id || ''),
    (a.name || a.official_name || '').toLowerCase().trim(),
    (a.subtype || a.type || ''),
  ].join('|');
}
function dedupeAccounts(list) {
  const seen = new Set(), out = [];
  for (const a of (list || [])) {
    const k = _acctNatKey(a);
    if (seen.has(k)) continue;
    seen.add(k); out.push(a);
  }
  return out;
}

app.post('/api/exchange_token', requireAuth, async (req, res) => {
  const { public_token, institution_name } = req.body;
  try {
    const r = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = r.data;
    if (store.accessTokens.find(t => t.itemId === item_id)) return res.json({ success: true, item_id });
    // FAILSAFE: if every account on this new link already exists on a connected bank, it's a
    // duplicate re-link — remove it and don't store it. (Different masks/names are NOT duplicates,
    // so a second login at the same bank, or business vs personal, is still kept.)
    let newKeys = [];
    try {
      const ar = await plaidClient.accountsGet({ access_token });
      newKeys = ar.data.accounts.map(a => _acctNatKey({ ...a, institution: institution_name }));
    } catch (_) {}
    if (newKeys.length) {
      const existingKeys = new Set();
      for (const t of store.accessTokens) {
        try {
          const er = await plaidClient.accountsGet({ access_token: t.accessToken });
          er.data.accounts.forEach(a => existingKeys.add(_acctNatKey({ ...a, institution: t.institutionName })));
        } catch (_) {}
      }
      if (newKeys.every(k => existingKeys.has(k))) {
        try { await plaidClient.itemRemove({ access_token }); } catch (_) {}
        return res.json({ success: true, item_id, duplicate: true, message: 'That bank is already connected — skipped the duplicate.' });
      }
    }
    store.accessTokens.push({ itemId: item_id, accessToken: access_token, institutionName: institution_name || 'Bank', addedAt: new Date().toISOString() });
    saveTokens(store);
    res.json({ success: true, item_id });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ── APP STATE SYNC (shared across a household's devices) ─────────────────────────
function loadAppState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (raw && raw.v === 1 && raw.data) return decryptJSON(raw);
      return raw;
    }
  } catch (e) { console.warn('state load:', e.message); }
  return null;
}
function saveAppState(blob) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(encryptJSON(blob)), 'utf8');
  } catch (e) { console.warn('state save (ok on free tier):', e.message); }
}
app.get('/api/state', requireAuth, (req, res) => { res.json({ state: loadAppState() }); });
app.post('/api/state', requireAuth, (req, res) => {
  const { state } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'no state' });
  const existing = loadAppState();
  // XP and level are accumulative — always keep the highest any device has reported.
  const maxXp = Math.max(+((state.app || {}).xp) || 0, +((existing && existing.app || {}).xp) || 0);
  const maxLevel = Math.max(+((state.app || {}).level) || 0, +((existing && existing.app || {}).level) || 0);
  // Newest by timestamp wins for everything else (layouts, edits); older push keeps the server's edits.
  let base = state;
  if (existing && existing._ts && state._ts && state._ts < existing._ts) base = existing;
  if (base.app) { base.app.xp = maxXp; base.app.level = maxLevel; }
  saveAppState(base);
  res.json({ ok: true, ts: base._ts || Date.now(), xp: maxXp, level: maxLevel });
});

app.get('/api/items', requireAuth, (req, res) => {
  res.json({
    items: store.accessTokens.map(t => ({
      itemId: t.itemId,
      institutionName: t.institutionName,
      addedAt: t.addedAt || null,
      hasCursor: !!store.cursor[t.itemId],
    })),
    count: store.accessTokens.length,
  });
});

app.get('/api/accounts', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ accounts: [], items: [] });
  const all = [], errors = [];
  for (const item of store.accessTokens) {
    try {
      const r = await plaidClient.accountsBalanceGet({ access_token: item.accessToken });
      r.data.accounts.forEach(a => all.push({ ...a, institution: item.institutionName, itemId: item.itemId }));
    } catch (err) {
      const code = err.response?.data?.error_code || err.message;
      console.warn(`Accounts error for ${item.institutionName}:`, code);
      errors.push({ institution: item.institutionName, itemId: item.itemId, error: code });
      if (code === 'ITEM_LOGIN_REQUIRED') errors[errors.length - 1].needsRelink = true;
    }
  }
  res.json({ accounts: dedupeAccounts(all), items: store.accessTokens.map(t => ({ itemId: t.itemId, institutionName: t.institutionName })), errors: errors.length ? errors : undefined });
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
        cards.push({ account_id: cc.account_id, name: a.name || 'Credit Card', institution: item.institutionName, mask: a.mask, current_balance: a.balances?.current ?? 0, limit: a.balances?.limit ?? null, available: a.balances?.available ?? null, minimum_payment: cc.minimum_payment_amount ?? 0, last_payment_date: cc.last_payment_date, last_payment_amount: cc.last_payment_amount ?? 0, next_payment_due_date: cc.next_payment_due_date, aprs: cc.aprs || [], apr: cc.aprs?.find(x => x.apr_type === 'purchase_apr')?.apr_percentage ?? null, is_overdue: cc.is_overdue ?? false });
      });
      r.data.liabilities.mortgage?.forEach(m => {
        const a = acctMap[m.account_id] || {};
        mortgages.push({ account_id: m.account_id, name: a.name || 'Mortgage', institution: item.institutionName, current_balance: m.current_outstanding_balance ?? 0, minimum_payment: m.next_monthly_payment ?? 0, next_payment_due_date: m.next_payment_due_date, interest_rate: m.interest_rate?.percentage ?? null, is_overdue: m.is_overdue ?? false });
      });
    } catch (e) {
      try {
        const r = await plaidClient.accountsGet({ access_token: item.accessToken });
        r.data.accounts.filter(a => a.type === 'credit').forEach(a => {
          cards.push({ account_id: a.account_id, name: a.name, institution: item.institutionName, mask: a.mask, current_balance: a.balances?.current ?? 0, limit: a.balances?.limit ?? null, available: a.balances?.available ?? null, minimum_payment: null, apr: null, aprs: [], limited_data: true });
        });
      } catch (_) {}
    }
  }
  res.json({ credit_cards: dedupeAccounts(cards), mortgages: dedupeAccounts(mortgages), student_loans: [] });
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  if (!store.accessTokens.length) return res.json({ transactions: [], accounts: [] });
  const txns = [], accts = [], errors = [];

  for (const item of store.accessTokens) {
    try {
      // Full sync every request (cursor from scratch) so we always return the COMPLETE
      // transaction history — not just what changed since a stored cursor. Storing the
      // cursor made later loads return nothing (it only reports NEW activity). transactionsSync
      // paginates; a handful of pages covers a couple of years.
      let cursor = null, hasMore = true, guard = 0;
      const added = [];
      while (hasMore && guard++ < 80) {
        const params = { access_token: item.accessToken };
        if (cursor) params.cursor = cursor;
        const r = await plaidClient.transactionsSync(params);
        added.push(...r.data.added);
        cursor = r.data.next_cursor;
        hasMore = r.data.has_more;
      }
      added.forEach(t => txns.push({ ...t, institution: item.institutionName }));

      const acctRes = await plaidClient.accountsGet({ access_token: item.accessToken });
      acctRes.data.accounts.forEach(a => accts.push({ ...a, institution: item.institutionName, itemId: item.itemId }));
    } catch (err) {
      const code = err.response?.data?.error_code || err.message;
      console.error(`Transaction error for ${item.institutionName}:`, code);
      errors.push({ institution: item.institutionName, error: code });
      try {
        const acctRes = await plaidClient.accountsGet({ access_token: item.accessToken });
        acctRes.data.accounts.forEach(a => accts.push({ ...a, institution: item.institutionName, itemId: item.itemId }));
      } catch (_) {}
    }
  }

  txns.sort((a, b) => new Date(b.date) - new Date(a.date));
  const keptAccts = dedupeAccounts(accts);
  const keptIds = new Set(keptAccts.map(a => a.account_id));
  const keptTxns = txns.filter(t => keptIds.has(t.account_id));
  res.json({ transactions: keptTxns, accounts: keptAccts, errors: errors.length ? errors : undefined });
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

// ── SPA CATCH-ALL ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Running on port ${PORT}`);
  console.log(`   Plaid:    ${PLAID_ENV}`);
  console.log(`   OpenAI:   ${process.env.OPENAI_API_KEY ? '✓ set' : '✗ NOT SET (voice + coach will fall back)'}`);
  console.log(`   User set: ${APP_USER ? '✓ ' + APP_USER : '✗ NOT SET'}`);
  console.log(`   Pass set: ${APP_PASS ? '✓ (length ' + APP_PASS.length + ')' : '✗ NOT SET'}\n`);
});
