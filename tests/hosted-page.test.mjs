// Loads the hosted page (as /app serves it) in jsdom with a fake API, and checks that it boots, talks to the
// workspace store, saves through the API, and shows the data sources panel. No real browser or server is involved,
// so this does not check drawing (canvas) or layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
const require = createRequire(import.meta.url);
const OPS = require('../hud/src/ops.js');

function hostedHtml(config) {
  const ts = readFileSync(new URL('../lib/hud/hud-html.generated.ts', import.meta.url), 'utf8');
  const pick = name => JSON.parse(ts.match(new RegExp('export const ' + name + ' = ("(?:[^"\\\\]|\\\\.)*");'))[1]);
  const papa = readFileSync(require.resolve('papaparse/papaparse.min.js'), 'utf8');
  return (pick('HUD_BEFORE') + JSON.stringify(config) + pick('HUD_AFTER'))
    .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/PapaParse\/[^"]+"><\/script>/, () => '<script>' + papa + '</script>');
}

function fakeApi(initial) {
  const calls = [];
  const db = { datasets: [], runs: [], exceptions: [], meta: [], ...initial };
  const sources = [{ id: 'src-1', kind: 'snowflake', name: 'Claims warehouse', config: { account: 'myorg-acct1', user: 'DQ_SERVICE', warehouse: 'DQ_WH', role: '' }, last_test_ok: true }];
  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    const u = String(url);
    if (u === '/api/store' && method === 'GET') return reply(200, db);
    let m = u.match(/^\/api\/store\/([a-z]+)\/(.+)$/);
    if (m && method === 'PUT') return reply(200, { doc: JSON.parse(init.body) });
    if (m && method === 'DELETE') return reply(200, { ok: true });
    if (u === '/api/sources') return reply(200, { sources });
    if (u === '/api/schedules') return reply(200, { schedules: db.datasets.filter(d => d.source).map(d => ({ dataset_id: d.id, next_run_at: '2026-11-11T13:00:00Z', last_status: null })) });
    if ((m = u.match(/^\/api\/datasets\/(.+)\/run$/))) return reply(200, { ok: true });
    return reply(404, { error: 'not found' });
  }
  return { fetch, calls };
}

async function boot(initial) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/getContext|Not implemented/.test(String(e && e.message))) errors.push(e); });
  vc.on('error', (...a) => errors.push(new Error(a.join(' '))));
  const api = fakeApi(initial);
  const config = { user: { email: 'tester@example.com' }, workspace: { id: 'ws-1', name: 'Claims DQ', role: 'owner' } };
  const dom = new JSDOM(hostedHtml(config), {
    url: 'http://localhost:3000/app', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = api.fetch;
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.addEventListener('error', ev => errors.push(ev.error || new Error(ev.message)));
    }
  });
  const w = dom.window;
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await new Promise(r => setTimeout(r, 25)); } return false; };
  await until(() => w.HoloOps && w.HoloOps.state.ready);
  return { dom, w, api, errors, until };
}

test('the hosted page boots in server mode and shows the account', async () => {
  const { w, api, errors, dom } = await boot();
  try {
    assert.deepEqual(errors.map(e => String(e && e.stack || e)), []);
    assert.equal(w.HoloOps.state.mode, 'server');
    const load = api.calls.find(c => c.url === '/api/store');
    assert.ok(load, 'loaded the workspace store');
    assert.equal(load.headers['x-holo'], '1', 'sends the same-origin guard header');
    assert.match(w.document.getElementById('acct').textContent, /tester@example\.com · Claims DQ/);
    assert.match(w.document.getElementById('opsStore').textContent, /Saved to your workspace/);
  } finally { dom.window.close(); }
});

test('saving from the page goes through the app API', async () => {
  const { w, api, until, dom } = await boot();
  try {
    const doc = { id: 'ex-test', ds: 'ds-x', kind: 'rule', status: 'open', log: [] };
    w.HoloOps.put('exceptions', doc);
    assert.ok(await until(() => api.calls.some(c => c.method === 'PUT' && c.url === '/api/store/exceptions/ex-test')));
    assert.deepEqual(api.calls.find(c => c.method === 'PUT').body, doc);
    assert.ok(await until(() => /Saved to your workspace/.test(w.document.getElementById('opsStore').textContent)), 'save finished');
    await new Promise(r => setTimeout(r, 100));
  } finally { dom.window.close(); }
});

test('the Schedules tab shows data sources and server runs for a monitored dataset', async () => {
  const now = Date.UTC(2026, 10, 10, 18);
  const ds = OPS.newDataset({ name: 'Claims', file: 'claims.csv', headers: ['claim_id', 'amount'], rules: [], now });
  ds.source = { id: 'src-1', object: 'DB.SCHEMA.CLAIMS' };
  const { w, api, until, errors, dom } = await boot({ datasets: [ds] });
  try {
    assert.ok(w.HoloOps.state.ds[ds.id], 'dataset loaded from the workspace');
    w.HoloOps.show('schedules');
    assert.ok(await until(() => /Claims warehouse/.test(w.document.body.textContent)), 'sources panel lists the saved source');
    assert.ok(api.calls.some(c => c.url === '/api/schedules'));
    assert.match(w.document.body.textContent, /runs on the server at its scheduled time/);
    assert.deepEqual(errors.map(e => String(e && e.stack || e)), []);
  } finally { dom.window.close(); }
});

test('a signed-out API answer shows the sign-in banner instead of failing silently', async () => {
  const { w, dom } = await boot();
  try {
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) });
    await assert.rejects(w.HoloServer.sources.list(), e => e.code === 'signed_out');
    assert.ok(w.document.getElementById('holoSignedOut'));
  } finally { dom.window.close(); }
});
