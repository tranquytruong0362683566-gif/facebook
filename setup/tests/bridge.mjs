import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixture, ADMIN_ID, KEY } from './database.mjs';

const setup = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = process.env.TQT_EXTENSION_ROOT || path.resolve(setup, '../../extension/auto binh luan');
const { createTqtLicenseClient } = await import(pathToFileURL(path.join(extension, 'src/shared/license-client.js')));
const config = { managementUrl: 'https://tranquytruong.top/', supabaseUrl: 'https://tqt-fixture.supabase.co',
  supabasePublishableKey: 'sb_publishable_SYNTHETIC_TEST', checkIntervalMs: 30000,
  failureCacheMs: 5000, requestTimeoutMs: 50 };
const { db, call } = await createFixture();
let timestamp = Date.now();
let mode = 'allow';
let barrier = null;
let fetchCalls = [];
const report = [];
const test = async (name, fn) => { await fn(); report.push(`PASS: ${name}`); console.log(report.at(-1)); };
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
function fakeChrome(initial = {}) {
  const values = structuredClone(initial);
  const effects = { cookies: 0, removedTabs: [] };
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  return { values, effects, api: {
    runtime: { id, getURL: value => `chrome-extension://${id}/${value}`,
      getManifest: () => ({ version: '3.1.0' }), onMessage: event(), onConnect: event() },
    storage: { local: {
      get: (keys, cb) => queueMicrotask(() => cb(Object.fromEntries(keys.map(key => [key, values[key]])))),
      set: (updates, cb) => { Object.assign(values, structuredClone(updates)); queueMicrotask(cb); },
      remove: (keys, cb) => { keys.forEach(key => delete values[key]); queueMicrotask(cb); }
    } },
    system: {
      cpu: { getInfo: cb => queueMicrotask(() => cb({ modelName: 'Intel Test CPU' })) },
      memory: { getInfo: cb => queueMicrotask(() => cb({ capacity: 16 * 1024 ** 3 })) },
      storage: { getInfo: cb => queueMicrotask(() => cb([{ type: 'fixed', name: 'C:', capacity: 500 * 1024 ** 3 }])) }
    },
    action: { onClicked: event() },
    cookies: { getAll: (_options, cb) => { effects.cookies += 1; queueMicrotask(() => cb([])); } },
    tabs: { remove: (id, cb) => { effects.removedTabs.push(id); queueMicrotask(cb); } }
  } };
}
async function fetchMock(url, options) {
  assert.equal(url, `${config.supabaseUrl}/rest/v1/rpc/tqt_register_device`);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.apikey, config.supabasePublishableKey);
  assert.equal(options.headers.Authorization, undefined);
  const params = JSON.parse(options.body);
  assert.deepEqual(Object.keys(params), ['p_machine_key']);
  fetchCalls.push(params);
  if (barrier) await barrier;
  if (mode === 'offline') throw new Error('Synthetic network outage');
  if (mode === 'timeout') return new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  if (mode === 'http-error') return new Response('{}', { status: 503 });
  if (mode === 'bad-json') return new Response('{broken', { status: 200 });
  const data = (await call('anon', '', 'select public.tqt_register_device($1) as data', [params.p_machine_key])).rows[0].data;
  if (mode === 'wrong-key') data.machineKey = `TQT-${'B'.repeat(27)}`;
  if (mode === 'inconsistent') { data.status = 'blocked'; data.authorized = true; }
  if (mode === 'invalid-expiry') data.expiresAt = 'invalid';
  if (mode === 'string-boolean') data.authorized = 'true';
  return new Response(JSON.stringify(data), { status: 200 });
}
const browser = fakeChrome({ tqtMachineKeyV1: KEY,
  tqtLicenseActivationV1: { machineKey: KEY, authorized: true },
  tqtLicenseDailyStatusV1: { machineKey: KEY, authorized: true } });
const client = createTqtLicenseClient({ chromeApi: browser.api, fetchImpl: fetchMock,
  cryptoApi: webcrypto, config, now: () => timestamp });
async function change(status, expiresAt = null) {
  const revision = (await db.query('select revision from public.tqt_device_licenses where machine_key=$1', [KEY])).rows[0].revision;
  return call('authenticated', ADMIN_ID, 'select public.tqt_admin_update_license($1,$2,$3,$4,$5,$6)',
    [KEY, status, 'Integration fixture', '', expiresAt, revision]);
}
try {
  await test('Legacy local approvals cannot unlock an unapproved KEY; existing machine KEY is preserved', async () => {
    const status = await client.verify();
    assert.equal(status.machineKey, KEY); assert.equal(status.authorized, false);
    assert.equal(status.status, 'pending');
    assert.equal(browser.values.tqtLicenseActivationV1, undefined);
    assert.equal(browser.values.tqtLicenseDailyStatusV1, undefined);
    assert.deepEqual(Object.keys(browser.values), ['tqtMachineKeyV1']);
  });
  await test('ADMIN approval in PostgreSQL opens the extension on a forced check', async () => {
    await change('approved');
    assert.equal((await client.verify({ forceRefresh: true })).authorized, true);
  });
  await test('A second installation with the same KEY shares the web approval without an installation token', async () => {
    const second = createTqtLicenseClient({ chromeApi: fakeChrome({ tqtMachineKeyV1: KEY }).api,
      fetchImpl: fetchMock, config });
    assert.equal((await second.verify()).authorized, true);
    assert.equal((await db.query('select count(*)::int as total from public.tqt_device_licenses')).rows[0].total, 1);
  });
  await test('Force refresh bypasses a positive cache immediately after ADMIN blocks the KEY', async () => {
    await change('blocked');
    const data = await client.verify({ forceRefresh: true });
    assert.equal(data.authorized, false); assert.equal(data.code, 'TQT_LICENSE_BLOCKED');
  });
  await test('Ordinary action checks reuse a short cache and enforce revocation at the next 30-second check', async () => {
    await change('approved'); await client.verify({ forceRefresh: true });
    await change('blocked'); const count = fetchCalls.length;
    timestamp += 29999;
    assert.equal((await client.verify()).authorized, true); assert.equal(fetchCalls.length, count);
    timestamp += 1;
    assert.equal((await client.verify()).authorized, false); assert.equal(fetchCalls.length, count + 1);
  });
  await test('Expiry crossing cannot extend authorization to the end of the positive cache', async () => {
    await change('approved', new Date(timestamp + 1000).toISOString());
    assert.equal((await client.verify({ forceRefresh: true })).authorized, true);
    timestamp += 1001;
    const result = await client.verify();
    assert.equal(result.authorized, false); assert.equal(result.status, 'expired');
  });
  await test('Server-side expired KEYs are denied independently of the client cache', async () => {
    await change('approved', '2000-01-01T00:00:00Z');
    assert.equal((await client.verify({ forceRefresh: true })).status, 'expired');
  });
  await test('Network failure removes the positive cache; recovering the service permits a fresh check', async () => {
    await change('approved'); await client.verify({ forceRefresh: true });
    mode = 'offline';
    assert.equal((await client.verify({ forceRefresh: true })).authorized, false);
    timestamp += 5000; mode = 'allow';
    assert.equal((await client.verify()).authorized, true);
  });
  await test('Mismatched KEY, contradictory permission, invalid expiry, invalid JSON and HTTP errors all deny access', async () => {
    for (const failure of ['wrong-key', 'inconsistent', 'invalid-expiry', 'bad-json', 'string-boolean', 'http-error']) {
      mode = failure;
      const result = await client.verify({ forceRefresh: true });
      assert.equal(result.authorized, false); assert.equal(result.code, 'TQT_LICENSE_SOURCE_UNAVAILABLE');
    }
    mode = 'allow';
  });
  await test('Request timeout aborts the pending HTTP request and denies access', async () => {
    mode = 'timeout';
    const result = await client.verify({ forceRefresh: true });
    assert.equal(result.authorized, false); assert(result.message.includes('quá thời gian'));
    mode = 'allow';
  });
  await test('Concurrent dashboard/action checks issue one registration request', async () => {
    let release; barrier = new Promise(resolve => { release = resolve; });
    const before = fetchCalls.length;
    const pending = Array.from({ length: 16 }, () => client.verify({ forceRefresh: true }));
    await flush(); assert.equal(fetchCalls.length, before + 1);
    release(); barrier = null;
    assert((await Promise.all(pending)).every(result => result.authorized));
  });
  await test('The hardware formula keeps matching new browsers on the same KEY; concurrent creation stores one KEY', async () => {
    const firstChrome = fakeChrome(); const secondChrome = fakeChrome();
    const first = createTqtLicenseClient({ chromeApi: firstChrome.api, fetchImpl: fetchMock, config });
    const second = createTqtLicenseClient({ chromeApi: secondChrome.api, fetchImpl: fetchMock, config });
    const results = await Promise.all([first.getMachineKey(), first.getMachineKey(), second.getMachineKey()]);
    assert.equal(new Set(results).size, 1); assert.equal(firstChrome.values.tqtMachineKeyV1, results[0]);
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('SIMULATED_UIDintel test cpu16C::500GB'));
    const hex = Buffer.from(digest).toString('hex').toUpperCase().slice(0, 27);
    assert.equal(results[0], `TQT-${hex}`);
  });
  await test('Unavailable hardware APIs cannot mint a universal empty-fingerprint KEY', async () => {
    const missing = fakeChrome(); missing.api.system = {};
    const target = createTqtLicenseClient({ chromeApi: missing.api, fetchImpl: fetchMock, config });
    await assert.rejects(target.getMachineKey(), error => error.code === 'TQT_MACHINE_KEY_UNAVAILABLE');
    assert.equal(missing.values.tqtMachineKeyV1, undefined);
  });

  class TestDate extends Date { static now() { return timestamp; } }
  const workerChrome = fakeChrome({ tqtMachineKeyV1: KEY,
    tqtLicenseDailyStatusV1: { machineKey: KEY, authorized: true } });
  const context = vm.createContext({ console, URL, TextEncoder, TextDecoder, Uint8Array, Headers,
    Response, Blob, AbortController, DOMException, crypto: webcrypto, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval, Date: TestDate,
    chrome: workerChrome.api, fetch: fetchMock });
  const modules = new Map();
  async function load(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename);
    const source = filename === path.join(extension, 'config/license-config.js')
      ? `export const TQT_LICENSE_CONFIG = ${JSON.stringify(config)};` : await fs.readFile(filename, 'utf8');
    const module = new vm.SourceTextModule(source, { context, identifier: filename });
    modules.set(filename, module);
    return module;
  }
  const workerModule = await load(path.join(extension, 'src/background/service-worker.js'));
  await workerModule.link((specifier, ref) => load(path.resolve(path.dirname(ref.identifier), specifier)));
  await workerModule.evaluate();
  const sender = { id: workerChrome.api.runtime.id,
    url: workerChrome.api.runtime.getURL('src/dashboard/dashboard.html') };
  const send = (action, payload = {}, origin = sender) => new Promise(resolve => {
    const kept = workerChrome.api.runtime.onMessage.listeners[0]({ action,
      source: 'autovip-extension-page', ...payload }, origin, resolve);
    assert.equal(kept, true);
  });
  await test('The actual service worker rejects dashboard commands from an untrusted origin before checking KEYs', async () => {
    const count = fetchCalls.length;
    const data = await send('GET_TQT_LICENSE_STATUS', {}, { id: sender.id, url: 'https://attacker.example/' });
    assert.equal(data.code, 'UNTRUSTED_WEB_ORIGIN'); assert.equal(fetchCalls.length, count);
  });
  await test('The actual service worker permits account reads only while the server approval is valid', async () => {
    const allowed = await send('GET_FACEBOOK_ACCOUNT');
    assert.equal(allowed.ok, true); assert.equal(allowed.code, 'FACEBOOK_ACCOUNT_NOT_FOUND');
    const reads = workerChrome.effects.cookies;
    await change('blocked'); await send('GET_TQT_LICENSE_STATUS', { forceRefresh: true });
    const denied = await send('GET_FACEBOOK_ACCOUNT');
    assert.equal(denied.ok, false); assert.equal(denied.code, 'TQT_LICENSE_BLOCKED');
    assert.equal(workerChrome.effects.cookies, reads);
  });
  await test('The actual service worker blocks comment commands and still permits tab cleanup after revocation', async () => {
    const denied = await send('COMMENT_POST', { url: 'https://www.facebook.com/123/posts/456', commentText: 'fixture' });
    assert.equal(denied.ok, false); assert.equal(denied.code, 'TQT_LICENSE_BLOCKED');
    const closed = await send('CLOSE_TAB', { tabId: 55 });
    assert.equal(closed.ok, true); assert.deepEqual(workerChrome.effects.removedTabs, [55]);
  });
  await test('The extension manifest contains the configured API host and no legacy GitHub license host', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
    assert(manifest.host_permissions.includes('https://aaafdlzajmifgvdzdfse.supabase.co/*'));
    assert(!manifest.host_permissions.some(host => host.includes('github.io')));
  });
  await fs.writeFile(path.join(setup, 'BRIDGE_TEST_REPORT.txt'), `${report.join('\n')}\n\n${report.length} extension / PostgreSQL integration checks passed.\nTest date: ${new Date().toISOString().slice(0,10)}.\nReal extension modules and service worker execute against embedded PostgreSQL RPCs. Chrome APIs, HTTP transport and hardware values are simulated. No live website, Supabase account or Facebook posting was performed.\n`);
} finally { await db.close(); }
