#!/usr/bin/env node
/* Zero-dependency smoke test — a fast pre-deploy tripwire, not a full suite.
 *   Run:  npm test   (or:  node test/smoke.js)
 *
 * Tier 1 — syntax & structure: the checks CLAUDE.md already asks for by hand.
 * Tier 2 — persistence/sync INVARIANTS: guards the exact code shapes whose
 *          regression caused a long "dashboard reverts to the build gate on
 *          reload" production hunt. If one trips, read the message before
 *          "fixing" the test — you're probably reintroducing that bug.
 * Tier 3 — behavioral: actually executes the two root-cause pieces
 *          (_makeSafe storage fallback; server widget-count anti-wipe rule).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

let failures = 0;
const ok = name => console.log('  ✓ ' + name);
const fail = (name, msg) => { failures++; console.error('  ✗ ' + name + (msg ? '  — ' + msg : '')); };
const assert = (cond, name, msg) => (cond ? ok(name) : fail(name, msg));

// Slice a top-level function (signature + body) by brace-matching from its first '{'.
function sliceFunction(src, signature) {
  const i = src.indexOf(signature);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

console.log('\n1. Syntax & structure');
(() => {
  const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  try { scripts.forEach(s => new vm.Script(s)); ok(`frontend inline <script> parses (${scripts.length} block)`); }
  catch (e) { fail('frontend inline <script> parses', e.message); }
})();
try { new vm.Script(SERVER, { filename: 'server/index.js' }); ok('server/index.js parses'); }
catch (e) { fail('server/index.js parses', e.message); }
(() => {
  const o = (HTML.match(/<div/g) || []).length, c = (HTML.match(/<\/div>/g) || []).length;
  assert(o === c, `balanced <div> tags (${o}/${c})`, `${o} open vs ${c} close`);
})();

console.log('\n2. Persistence/sync invariants (regressions here = the reload-wipe saga)');
assert(/function saveState\(\)\{[^]*?_saveActiveLayout\(\);[^]*?LS\.setItem\('richie_app'[^]*?syncPush\(\)/.test(HTML),
  'saveState stays synchronous (_saveActiveLayout → write → push)',
  'do NOT re-add the debounced LS write — it ships stale/empty layouts');
assert(/function syncCollect\(\)\{\s*try\{\s*_saveActiveLayout\(\)/.test(HTML),
  'syncCollect folds the active layout before every push');
assert(/if\(_stateHasWidgets\(APP\)\)\s*_sawWidgets=true;\s*else if\(_sawWidgets\)\{\s*_syncDirty=false;\s*return;/.test(HTML),
  'client refuses to push a widget-less state once a dashboard was seen (_sawWidgets)');
(() => {
  const i = HTML.indexOf('// START BLANK');
  const j = HTML.indexOf('} else {', i);
  const seg = (i >= 0 && j > i) ? HTML.slice(i, j) : '';
  assert(seg && !/saveState\(\)/.test(seg) && !/LS\.setItem\('richie_app'/.test(seg),
    'build-gate seed branch is in-memory only (never persists or pushes)',
    'the gate must not be saved/pushed — it overwrites the real dashboard');
})();
assert(/exW\s*>\s*0\s*&&\s*inW\s*===\s*0/.test(SERVER),
  'server rejects ONLY a zero-widget gate over a populated dashboard');

console.log('\n3. Behavioral: _makeSafe storage fallback (Edge silent-drop root cause)');
(() => {
  const src = sliceFunction(HTML, 'function _makeSafe(real, mem)');
  if (!src) return fail('extract _makeSafe');
  const _makeSafe = new Function(src + '\nreturn _makeSafe;')();
  const edge = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; // silently drops, never throws
  const LS = _makeSafe(edge, {});
  LS.setItem('richie_app', 'DASH');
  assert(LS.getItem('richie_app') === 'DASH', 'reads a value back even when real storage silently drops writes');
  const store = {}, real = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: k => delete store[k] };
  const LS2 = _makeSafe(real, {});
  LS2.setItem('x', '1');
  assert(LS2.getItem('x') === '1', 'reads back from working real storage');
  assert(LS2.getItem('missing') === null, 'returns null for a genuinely absent key');
})();

console.log('\n4. Behavioral: server widget-count anti-wipe rule');
(() => {
  const src = sliceFunction(SERVER, 'function _stateMaxWidgets(s)');
  if (!src) return fail('extract _stateMaxWidgets');
  const _stateMaxWidgets = new Function(src + '\nreturn _stateMaxWidgets;')();
  const w = n => ({ app: { pages: [{ widgets: Array(n).fill(0) }], layouts: {} } });
  const dash = { app: { pages: [{ widgets: [0, 0, 0] }], layouts: { me: { pages: [{ widgets: Array(13).fill(0) }] } } } };
  assert(_stateMaxWidgets(dash) === 13, '_stateMaxWidgets counts the richest page-set (incl. layouts)', 'got ' + _stateMaxWidgets(dash));
  assert(_stateMaxWidgets(w(0)) === 0, '_stateMaxWidgets = 0 for the gate');
  const reject = (ex, inc) => _stateMaxWidgets(ex) > 0 && _stateMaxWidgets(inc) === 0;
  assert(reject(dash, w(0)) === true, 'gate (0w) over a dashboard → rejected');
  assert(reject(dash, dash) === false, 'a real edit (same widget count) → accepted');
  assert(reject(dash, w(11)) === false, 'a shrinking-but-nonzero edit (11w) → accepted');
})();

console.log('\n' + (failures ? `✗ ${failures} check(s) failed\n` : '✓ all smoke checks passed\n'));
process.exit(failures ? 1 : 0);
