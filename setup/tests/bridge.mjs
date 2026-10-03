import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ext = path.join(root, 'extension');
const web = path.join(root, 'web-github');
const report = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const flush = () => new Promise(resolve => setImmediate(resolve));
const test = async (name, fn) => { await fn(); report.push(`PASS: ${name}`); console.log(report.at(-1)); };
const read = p => fs.readFile(p, 'utf8');
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); }, listeners };
};
const timers = new Set();
const intervals = new Set();
const globals = {
  console, URL, TextEncoder, TextDecoder, Uint8Array, Headers, Response, Blob,
  AbortController, DOMException, crypto: webcrypto, queueMicrotask,
  setTimeout: (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); timers.add(t); return t; },
  clearTimeout: t => { clearTimeout(t); timers.delete(t); },
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); intervals.add(t); return t; },
  clearInterval: t => { clearInterval(t); intervals.delete(t); }
};
class FakeCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
class FakeWindow {
  constructor(href) {
    this.location = new URL(href);
    this.top = this;
    this.listeners = new Map();
    this.sent = [];
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(ev) { for (const fn of [...(this.listeners.get(ev.type) || [])]) fn(ev); return true; }
  postMessage(data, origin) {
    assert.equal(origin, this.location.origin);
    this.sent.push(structuredClone(data));
    queueMicrotask(() => this.dispatchEvent({ type: 'message', source: this, origin, data }));
  }
}
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)),
    removeItem: k => values.delete(k), values };
}
function fakeElement() {
  const attrs = new Map();
  const classes = new Set();
  return { dataset: {}, disabled: false, value: '', textContent: '',
    classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k), getAttribute: k => attrs.get(k),
    addEventListener() {}, focus() {}, select() {} };
}
function loader(context) {
  const cache = new Map();
  async function get(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const m = new vm.SourceTextModule(await read(filename), { context, identifier: filename });
    cache.set(filename, m);
    await m.link((specifier, ref) => get(path.resolve(path.dirname(ref.identifier), specifier)));
    return m;
  }
  return async filename => { const m = await get(filename); await m.evaluate(); return m; };
}
const policyContext = vm.createContext({ ...globals });
vm.runInContext(await read(path.join(ext, 'src/shared/dashboard-bridge-policy.js')), policyContext);
const P = policyContext.TqtDashboardBridgePolicy;
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const page = new FakeWindow(P.DEFAULT_URL);
const webStorage = fakeStorage();
let webNow = Date.now();
class WebDate extends Date {
  constructor(...args) { super(...(args.length ? args : [webNow])); }
  static now() { return webNow; }
}
const licenseCalls = [];
let licenseMode = 'allow';
const webContext = vm.createContext({ ...globals, CustomEvent: FakeCustomEvent,
  window: page, location: page.location, Date: WebDate, localStorage: webStorage, fetch: licenseFetchMock });

const stored = { tqtMachineKeyV1: `TQT-${'A'.repeat(27)}`,
  autovipDashboardUrlV1: 'https://old.github.io/previous/' };
const storageEvent = event();
const allowedOrigins = new Set([`${new URL(P.DEFAULT_URL).origin}/*`]);
const registration = new Map([['autovip-web-bridge-v1', { id: 'autovip-web-bridge-v1', matches: ['https://old.github.io/*'] }]]);
const roleEvents = { worker: event(), offscreen: event() };
const onConnect = event();
const ports = [];
const fetchCalls = [];
let fetchMode = 'ok';
let offscreenCreated = false;
const contentSender = { id: extensionId, tab: { id: 55, url: page.location.href },
  frameId: 0, documentId: 'document-55', url: page.location.href, origin: page.location.origin };
const popupSender = { id: extensionId, frameId: 0,
  url: `chrome-extension://${extensionId}/src/popup/account-popup.html` };

function runtimeSend(role, message, callback) {
  const sender = role === 'content' ? contentSender : { id: extensionId,
    url: `chrome-extension://${extensionId}/src/background/service-worker.js` };
  const targets = message.target === 'offscreen' ? ['worker', 'offscreen'] : ['worker'];
  const promise = new Promise((resolve, reject) => {
    let keptOpen = false;
    let responded = false;
    const respond = response => { if (!responded) { responded = true; resolve(response); } };
    for (const target of targets) {
      for (const fn of roleEvents[target].listeners) {
        const kept = fn(message, sender, respond);
        if (kept === true) keptOpen = true;
      }
    }
    if (!keptOpen && !responded) resolve(undefined);
  });
  if (callback) promise.then(callback);
  return promise;
}
function makeChrome(role) {
  return {
    runtime: { id: extensionId, getManifest: () => ({ version: '4.2.0' }),
      getURL: p => `chrome-extension://${extensionId}/${p}`,
      onMessage: roleEvents[role] || event(), onConnect,
      onInstalled: event(), onStartup: event(),
      sendMessage: (message, cb) => runtimeSend(role, message, cb),
      connect: ({ name }) => {
        const incoming = event(), outgoing = event(), aDisconnect = event(), bDisconnect = event();
        let disconnected = false;
        const disconnect = () => { if (disconnected) return; disconnected = true; aDisconnect.emit(); bDisconnect.emit(); };
        const a = { name, onMessage: incoming, onDisconnect: aDisconnect, disconnect,
          postMessage: message => { if (disconnected) throw new Error('disconnected'); queueMicrotask(() => outgoing.emit(message)); } };
        const b = { name, sender: contentSender, onMessage: outgoing, onDisconnect: bDisconnect, disconnect,
          postMessage: message => { if (disconnected) throw new Error('disconnected'); queueMicrotask(() => incoming.emit(message)); } };
        ports.push(a);
        onConnect.emit(b);
        return a;
      }
    },
    storage: { onChanged: storageEvent, local: {
      get: async (keys, cb) => {
        if (typeof keys === 'string') keys = [keys];
        const result = Object.fromEntries((keys || Object.keys(stored)).map(k => [k, stored[k]]));
        if (cb) queueMicrotask(() => cb(result));
        return result;
      },
      set: async (data, cb) => {
        const changes = {};
        for (const [k, v] of Object.entries(data)) { changes[k] = { oldValue: stored[k], newValue: v }; stored[k] = v; }
        queueMicrotask(() => storageEvent.emit(changes, 'local'));
        if (cb) queueMicrotask(cb);
      },
      remove: async (keys, cb) => { for (const k of typeof keys === 'string' ? [keys] : keys) delete stored[k]; if (cb) queueMicrotask(cb); }
    } },
    scripting: {
      getRegisteredContentScripts: async () => [...registration.values()],
      registerContentScripts: async definitions => definitions.forEach(d => { assert(!registration.has(d.id)); registration.set(d.id, d); }),
      updateContentScripts: async definitions => definitions.forEach(d => { assert(registration.has(d.id)); registration.set(d.id, d); }),
      unregisterContentScripts: async ({ ids }) => ids.forEach(id => registration.delete(id)),
      executeScript: async () => []
    },
    permissions: { contains: async ({ origins }) => origins.every(o => allowedOrigins.has(o)), onRemoved: event() },
    tabs: { query: async () => [], onUpdated: event(), create: async data => ({ id: 71, ...data }),
      update: async () => {}, remove: async () => {}, get: () => {} },
    windows: { update: async () => {} },
    action: { onClicked: event() },
    offscreen: { hasDocument: async () => offscreenCreated,
      createDocument: async () => { offscreenCreated = true; }, closeDocument: async () => { offscreenCreated = false; } },
    declarativeNetRequest: { updateSessionRules: (_data, cb) => cb() },
    cookies: { getAll: (_data, cb) => cb([]) }
  };
}
function fetchMock(url, options) {
  fetchCalls.push({ url: String(url), options });
  assert(!String(url).includes('/key/keys.json'), 'License fetch must run only on the web');
  assert(!String(url).includes('facebook.com'), 'Tests must not invoke Facebook');
  if (fetchMode === 'hang') return new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  if (fetchMode === 'rate-limit') return Promise.resolve(new Response('{"error":{"message":"quota"}}', { status: 429 }));
  if (fetchMode === 'large') return Promise.resolve(new Response(new Uint8Array(20 * 1024 * 1024 + 1)));
  return Promise.resolve(new Response('{"result":"synthetic-only"}', { status: 200 }));
}
function licenseFetchMock(url, options) {
  licenseCalls.push({ url: String(url), options });
  assert.equal(String(url), 'https://tqt-fixture.supabase.co/rest/v1/rpc/tqt_register_device');
  assert.equal(options.headers.apikey, 'sb_publishable_SYNTHETIC_TEST');
  const params = JSON.parse(options.body);
  assert.equal(params.p_machine_key, stored.tqtMachineKeyV1);
  assert.deepEqual(Object.keys(params), ['p_machine_key']);
  if (licenseMode === 'unavailable') return Promise.resolve(new Response('{}', { status: 503 }));
  if (licenseMode === 'malformed') return Promise.resolve(new Response('{}'));
  const status = licenseMode === 'allow' ? 'approved' : licenseMode === 'deny' ? 'blocked' : licenseMode;
  return Promise.resolve(new Response(JSON.stringify({ machineKey: stored.tqtMachineKeyV1,
    authorized: status === 'approved', status, expiresAt: null, message: 'Synthetic license status' })));
}
const workerContext = vm.createContext({ ...globals, chrome: makeChrome('worker'), fetch: fetchMock });
const workerLoad = loader(workerContext);
const offscreenContext = vm.createContext({ ...globals, chrome: makeChrome('offscreen'), fetch: fetchMock });
await loader(offscreenContext)(path.join(ext, 'src/offscreen/provider-api-host.js'));
await workerLoad(path.join(ext, 'src/background/service-worker.js'));
const contentContext = vm.createContext({ ...globals, chrome: makeChrome('content'), window: page, location: page.location });
vm.runInContext(await read(path.join(ext, 'src/shared/dashboard-bridge-policy.js')), contentContext);
vm.runInContext(await read(path.join(web, 'scripts/background-bridge-client.js')), webContext);
vm.runInContext(await read(path.join(web, 'scripts/provider-api-client.js')), webContext);
vm.runInContext(await read(path.join(ext, 'src/content/dashboard-web-bridge.js')), contentContext);
async function settle(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await flush(); } throw new Error('Async condition not reached'); }
async function direct(message, sender) {
  return new Promise(resolve => { for (const fn of roleEvents.worker.listeners) fn(message, sender, resolve); });
}
try {
  await test('Web and extension handshake through actual worker/content bridge', async () => {
    await settle(() => page.fbBridgeApi.bridgeAvailable());
    const pong = await page.fbBridgeApi.sendRawBridge('PING_BRIDGE');
    assert.equal(pong.code, 'BRIDGE_READY');
    assert.equal(pong.version, '4.2.0');
    assert.equal(pong.protocolVersion, 3);
    const before = ports.length;
    vm.runInContext(await read(path.join(ext, 'src/content/dashboard-web-bridge.js')), contentContext);
    assert.equal(ports.length, before, 'Reopening an active dashboard must keep its connection');
  });
  await test('Manifest automatically injects the fixed domain; legacy dynamic registration is removed', async () => {
    await settle(() => registration.size === 0);
    const manifest = JSON.parse(await read(path.join(ext, 'manifest.json')));
    const d = manifest.content_scripts.find(script => script.js.includes('src/content/dashboard-web-bridge.js'));
    assert.equal(d.run_at, 'document_start');
    assert.equal(d.all_frames, false);
    assert.equal(d.world, 'ISOLATED');
    assert.deepEqual(d.matches, ['https://tranquytruong.top/*']);
    assert(manifest.host_permissions.includes('https://tranquytruong.top/*'));
    assert.equal(manifest.optional_host_permissions, undefined);
    assert(!manifest.host_permissions.some(host => host.includes('github.io')));
  });
  await test('Correct project path/index alias accepted; foreign page, origin and frame rejected', () => {
    assert(P.isSameDashboardPage(`${P.DEFAULT_URL}index.html?x=1#queue`, P.DEFAULT_URL));
    assert(!P.isSameDashboardPage(`${page.location.origin}/another-repo/`, P.DEFAULT_URL));
    assert(!P.isSameDashboardPage('https://evil.example/auto-binh-luan/', P.DEFAULT_URL));
    assert(!P.isTrustedWebSender({ ...contentSender, frameId: 1 }, extensionId, P.DEFAULT_URL));
    assert(!P.isTrustedWebSender({ ...contentSender, origin: 'https://evil.example' }, extensionId, P.DEFAULT_URL));
    assert.throws(() => P.normalizeDashboardUrl('javascript:alert(1)'));
    assert.throws(() => P.normalizeDashboardUrl('https://name:secret@example.com/'));
    assert.throws(() => P.normalizeDashboardUrl('http://localhost:8000/index.html'));
    assert.throws(() => P.normalizeDashboardUrl('https://www.tranquytruong.top/'));
  });
  await test('Worker denies an untrusted page even when it spoofs an internal source', async () => {
    for (const source of ['autovip-web-page', 'autovip-extension-page', '']) {
      const response = await direct({ action: 'PING_BRIDGE', source }, { ...contentSender, url: `${page.location.origin}/other/` });
      assert.equal(response.code, 'UNTRUSTED_WEB_ORIGIN');
    }
    const response = await direct({ action: 'GET_DASHBOARD_CONFIG', source: 'autovip-web-page' }, contentSender);
    assert.equal(response.code, 'UNSUPPORTED_ACTION');
    const originPattern = `${page.location.origin}/*`;
    allowedOrigins.delete(originPattern);
    const revoked = await direct({ action: 'PING_BRIDGE', source: 'autovip-web-page' }, contentSender);
    assert.equal(revoked.code, 'UNTRUSTED_WEB_ORIGIN');
    allowedOrigins.add(originPattern);
  });
  await test('Extension supplies the existing machine key without any license checking', async () => {
    const before = fetchCalls.length;
    const key = await page.fbBridgeApi.sendRawBridge('GET_MACHINE_KEY');
    assert.equal(key.data.machineKey, stored.tqtMachineKeyV1);
    assert.equal(key.data.authorized, undefined);
    assert.equal(fetchCalls.length, before);
    assert.equal(stored.tqtLicenseDailyStatusV1, undefined);
    const removed = await direct({ action: 'GET_TQT_LICENSE_STATUS', source: 'autovip-web-page' }, contentSender);
    assert.equal(removed.code, 'UNSUPPORTED_ACTION');
    await assert.rejects(page.fbBridgeApi.sendRawBridge('REQUEST_PROVIDER_API', {}), e => e.code === 'TQT_LICENSE_NOT_READY');
  });
  const elements = new Map(['licenseGate', 'dashboardApp', 'tqtMachineKeyInput', 'tqtLicenseStatus', 'copyTqtMachineKeyBtn', 'retryTqtLicenseBtn'].map(id => [id, fakeElement()]));
  const html = fakeElement();
  webContext.document = { getElementById: id => elements.get(id), documentElement: html,
    addEventListener() {}, hidden: false };
  await test('Web checks the existing KEY without creating or sending an installation credential', async () => {
    vm.runInContext(await read(path.join(web, 'config/license-config.js')), webContext);
    page.TqtLicenseConfig = { dashboardUrl: P.DEFAULT_URL, supabaseUrl: 'https://tqt-fixture.supabase.co', supabasePublishableKey: 'sb_publishable_SYNTHETIC_TEST' };
    vm.runInContext(await read(path.join(web, 'shared/supabase-api.js')), webContext);
    vm.runInContext(await read(path.join(web, 'scripts/license-verifier.js')), webContext);
    vm.runInContext(await read(path.join(web, 'scripts/license-access-controller.js')), webContext);
    await settle(() => html.dataset.tqtLicenseAuthorized === 'true');
    assert.equal(elements.get('tqtMachineKeyInput').value, stored.tqtMachineKeyV1);
    assert.equal(licenseCalls.length, 1);
    assert.equal(stored.tqtDeviceCredentialV1, undefined);
    assert.equal(licenseCalls[0].options.credentials, 'omit');
    assert.equal(licenseCalls[0].options.cache, 'no-store');
    assert.equal(fetchCalls.length, 0);
  });
  await test('Two extension credentials for the same approved KEY leave web authorization unchanged', async () => {
    for (const token of ['A'.repeat(64), 'B'.repeat(64)]) {
      stored.tqtDeviceCredentialV1 = { machineKey: stored.tqtMachineKeyV1, deviceToken: token };
      const before = page.sent.length;
      assert.equal((await page.TqtWebLicense.verify({ forceRefresh: true })).authorized, true);
      assert.equal(stored.tqtDeviceCredentialV1.deviceToken, token);
      assert(!page.sent.slice(before).some(message => message.action === 'GET_DEVICE_REGISTRATION'));
      assert.deepEqual(Object.keys(JSON.parse(licenseCalls.at(-1).options.body)), ['p_machine_key']);
    }
    delete stored.tqtDeviceCredentialV1;
  });
  await test('Pending, blocked, expired and legacy conflicting registrations lock the dashboard before sending actions', async () => {
    for (const [mode, code] of [['pending','TQT_LICENSE_PENDING'],['deny','TQT_LICENSE_BLOCKED'],['expired','TQT_LICENSE_EXPIRED'],['registration_conflict','TQT_LICENSE_REGISTRATION_CONFLICT']]) {
      licenseMode = mode;
      const denied = await page.TqtWebLicense.verify({ forceRefresh: true });
      assert.equal(denied.code, code);
      assert.equal(html.dataset.tqtLicenseAuthorized, 'false');
      const before = page.sent.length;
      await assert.rejects(page.fbBridgeApi.sendRawBridge('COMMENT_FACEBOOK_POST', { commentText: 'fixture' }), e => e.code === code);
      await assert.rejects(page.fbProviderApi.fetch('https://api.openai.com/v1/responses', { body: '{}' }), e => e.code === code);
      assert.equal(page.sent.length, before);
      assert.equal(fetchCalls.length, 0);
    }
    licenseMode = 'allow';
    assert.equal((await page.TqtWebLicense.verify({ forceRefresh: true })).authorized, true);
    assert.equal(html.dataset.tqtLicenseAuthorized, 'true');
  });
  await test('Short-lived in-memory status coalesces checks and honors revocation after expiry', async () => {
    const before = licenseCalls.length;
    await page.TqtWebLicense.requireAuthorized();
    assert.equal(licenseCalls.length, before);
    webNow += 16000;
    licenseMode = 'deny';
    const results = await Promise.all(Array.from({ length: 6 }, () => page.TqtWebLicense.verify()));
    assert(results.every(status => !status.authorized));
    assert.equal(licenseCalls.length, before + 1);
    assert.equal(webStorage.length, 0, 'No stored authorized flag may survive a page reload');
    licenseMode = 'allow'; await page.TqtWebLicense.verify({ forceRefresh: true });
  });
  await test('Backend failure and malformed responses lock the dashboard; manual retry recovers', async () => {
    licenseMode = 'unavailable';
    assert.equal((await page.TqtWebLicense.verify({ forceRefresh: true })).code, 'TQT_LICENSE_SOURCE_UNAVAILABLE');
    assert.equal(html.dataset.tqtLicenseAuthorized, 'false');
    const before = licenseCalls.length;
    await assert.rejects(page.TqtWebLicense.requireAuthorized(), e => e.code === 'TQT_LICENSE_SOURCE_UNAVAILABLE');
    assert.equal(licenseCalls.length, before);
    licenseMode = 'malformed';
    assert.equal((await page.TqtWebLicense.verify({ forceRefresh: true })).code, 'TQT_LICENSE_SOURCE_UNAVAILABLE');
    licenseMode = 'allow'; await page.TqtWebLicense.verify({ forceRefresh: true });
  });
  await test('Reconnection rereads the KEY and does not reuse another KEY status', async () => {
    const before = licenseCalls.length;
    ports.at(-1).disconnect();
    await settle(() => !page.fbBridgeApi.bridgeAvailable());
    assert.equal(html.dataset.tqtLicenseAuthorized, 'false');
    stored.tqtMachineKeyV1 = `TQT-${'B'.repeat(27)}`;
    vm.runInContext(await read(path.join(ext, 'src/content/dashboard-web-bridge.js')), contentContext);
    await settle(() => html.dataset.tqtLicenseAuthorized === 'true');
    assert.equal(elements.get('tqtMachineKeyInput').value, stored.tqtMachineKeyV1);
    assert.equal(licenseCalls.length, before + 1);
    assert.equal(stored.tqtDeviceCredentialV1, undefined);
  });
  await test('AI and Apify proxy round trip uses packaged offscreen code without browser CORS', async () => {
    for (const url of ['https://api.openai.com/v1/responses', 'https://router.flatkey.ai/v1/chat/completions', 'https://api.apify.com/v2/actors/caprolok~facebook-groups-scraper/run-sync-get-dataset-items?format=json&clean=true&timeout=300']) {
      const response = await page.fbProviderApi.fetch(url, { method: 'POST', headers: { Authorization: 'Bearer synthetic-test-key' }, body: '{"model":"fixture"}' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { result: 'synthetic-only' });
      const request = fetchCalls.at(-1);
      assert.equal(request.options.redirect, 'error');
      assert.equal(request.options.credentials, 'omit');
      assert.equal(request.options.headers.Authorization, 'Bearer synthetic-test-key');
      assert.equal(request.options.referrerPolicy, 'no-referrer');
    }
  });
  await test('Proxy preserves HTTP errors and blocks arbitrary destinations before fetch', async () => {
    fetchMode = 'rate-limit';
    const r = await page.fbProviderApi.fetch('https://api.openai.com/v1/responses', { headers: { Authorization: 'Bearer synthetic-test-key' }, body: '{}' });
    assert.equal(r.status, 429);
    assert.equal(r.ok, false);
    fetchMode = 'ok';
    const before = fetchCalls.length;
    await assert.rejects(page.fbProviderApi.fetch('https://evil.example/collect', { headers: { Authorization: 'Bearer synthetic-test-key' }, body: '{}' }));
    await assert.rejects(page.fbProviderApi.fetch('https://api.apify.com/v2/actors/evil~actor/run-sync-get-dataset-items', { headers: { Authorization: 'Bearer synthetic-test-key' }, body: '{}' }));
    assert.equal(fetchCalls.length, before);
  });
  await test('Caller cancellation reaches the offscreen fetch and closes the request', async () => {
    fetchMode = 'hang';
    const controller = new AbortController();
    const before = fetchCalls.length;
    const pending = page.fbProviderApi.fetch('https://api.openai.com/v1/responses', { headers: { Authorization: 'Bearer synthetic-test-key' }, body: '{}', signal: controller.signal });
    const caught = assert.rejects(pending, error => error.name === 'AbortError');
    await settle(() => fetchCalls.length > before);
    controller.abort();
    await caught;
    await settle(() => fetchCalls.at(-1).options.signal.aborted);
    fetchMode = 'ok';
  });
  await test('Large API responses are rejected at 20 MB', async () => {
    fetchMode = 'large';
    await assert.rejects(page.fbProviderApi.fetch('https://api.openai.com/v1/responses', { headers: { Authorization: 'Bearer synthetic-test-key' }, body: '{}' }), /20 MB/);
    fetchMode = 'ok';
  });
  await test('Unsupported aliases may fall back; unknown completion never replays a mutation', async () => {
    const pong = await page.fbBridgeApi.sendBridge(['NOT_SUPPORTED', 'PING_BRIDGE']);
    assert.equal(pong.code, 'BRIDGE_READY');
    const callback = event => {
      const d = event.data;
      if (d.direction !== 'web-to-extension' || d.kind !== 'request' || d.action !== 'COMMENT_FACEBOOK_POST') return;
      page.postMessage({ channel: P.CHANNEL, direction: 'extension-to-web', protocolVersion: 3,
        kind: 'response', requestId: d.requestId, response: { ok: false, code: 'BRIDGE_TIMEOUT', error: 'Synthetic unknown completion' } }, page.location.origin);
    };
    page.addEventListener('message', callback);
    // Remove content forwarding so this scenario remains entirely synthetic.
    contentContext.__tqtDashboardBridgeDispose();
    const before = page.sent.length;
    await assert.rejects(page.fbBridgeApi.sendBridge(['COMMENT_FACEBOOK_POST', 'COMMENT_FB_POST'], { commentText: 'fixture' }), e => e.code === 'BRIDGE_TIMEOUT');
    const requests = page.sent.slice(before).filter(d => d.direction === 'web-to-extension' && d.kind === 'request');
    assert.equal(requests.length, 1);
    page.removeEventListener('message', callback);
  });
  await test('Same-origin and window checks reject messages from a foreign frame', () => {
    const before = page.fbBridgeApi.bridgeAvailable();
    page.dispatchEvent({ type: 'message', source: {}, origin: page.location.origin,
      data: { channel: P.CHANNEL, direction: 'extension-to-web', protocolVersion: 3, kind: 'status', connected: !before } });
    assert.equal(page.fbBridgeApi.bridgeAvailable(), before);
    page.dispatchEvent({ type: 'message', source: page, origin: 'https://evil.example',
      data: { channel: P.CHANNEL, direction: 'extension-to-web', protocolVersion: 3, kind: 'status', connected: !before } });
    assert.equal(page.fbBridgeApi.bridgeAvailable(), before);
  });
  await test('Popup opens the fixed website; saved or injected URLs cannot change it', async () => {
    const config = await direct({ action: 'GET_DASHBOARD_CONFIG' }, popupSender);
    assert.equal(config.data.dashboardUrl, 'https://tranquytruong.top/');
    const denied = await direct({ action: 'SAVE_DASHBOARD_CONFIG', payload: { dashboardUrl: 'https://different.github.io/app/' } }, popupSender);
    assert.equal(denied.code, 'UNSUPPORTED_ACTION');
    assert.equal(stored.autovipDashboardUrlV1, 'https://old.github.io/previous/');
    const opened = await direct({ action: 'OPEN_WEB_DASHBOARD' }, popupSender);
    assert.equal(opened.ok, true);
    const popup = await read(path.join(ext, 'src/popup/account-popup.html'));
    assert(!popup.includes('saveDashboardUrlBtn'));
    assert(!popup.includes('dashboardUrlInput'));
  });
  await test('Backups exclude secrets by default and restore chosen values', async () => {
    const context = vm.createContext({ ...globals });
    vm.runInContext(await read(path.join(web, 'shared/dashboard-backup.js')), context);
    const B = context.TqtDashboardBackup;
    const storage = fakeStorage({ tqtWebLicenseDailyStatusV1: '{"authorized":true}', truong_ai_commenter_templates_right_v2: '[{"name":"fixture"}]', truong_openai_api_key_v2: '"synthetic-key"', truong_fb_bridge_facebook_cookies_v1: '"synthetic-cookie"', unrelated: '"ignored"' });
    const backup = B.createBackup(storage);
    assert.equal(Object.keys(backup.items).length, 1);
    const full = B.createBackup(storage, true);
    assert.equal(Object.keys(full.items).length, 3);
    const items = B.parseBackup(JSON.stringify(backup));
    const target = fakeStorage();
    assert.equal(B.restoreBackup(target, items), 1);
    assert.equal(target.getItem('truong_ai_commenter_templates_right_v2'), storage.getItem('truong_ai_commenter_templates_right_v2'));
    assert.throws(() => B.parseBackup('{"format":"wrong"}'));
    assert.equal(await read(path.join(web, 'shared/dashboard-backup.js')), await read(path.join(ext, 'src/shared/dashboard-backup.js')));
  });
  await test('HTML assets resolve from GitHub project paths and extension pages; no published credential', async () => {
    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return (await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat();
    }
    const allFiles = await walk(root);
    for (const file of allFiles.filter(f => f.endsWith('.html'))) {
      const html = await read(file);
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
      assert.equal(new Set(ids).size, ids.length, `duplicate HTML IDs: ${file}`);
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const url = match[1];
        if (/^(https?:|data:|#)/.test(url)) continue;
        assert(!url.startsWith('/'), `absolute path breaks project hosting: ${url}`);
        await fs.access(path.resolve(path.dirname(file), url));
      }
    }
    for (const file of allFiles.filter(f => /\.(js|json|html)$/.test(f))) {
      const source = await read(file);
      assert(!/['"]sk-[A-Za-z0-9_-]{20,}['"]/.test(source), `Embedded secret in ${path.relative(root, file)}`);
      if (file.startsWith(web) && file.endsWith('.js')) assert(!/\bchrome\.(runtime|storage|cookies|tabs|scripting)/.test(source), `Extension API in web: ${file}`);
    }
    const manifest = JSON.parse(await read(path.join(ext, 'manifest.json')));
    assert.equal(manifest.version, '4.2.0');
    assert.equal(manifest.manifest_version, 3);
    await fs.access(path.join(web, '.nojekyll'));
    await assert.rejects(fs.access(path.join(ext, 'src/dashboard')));
  });
  const summary = `${report.join('\n')}\n\n${report.length} checks passed.\n\nEnvironment: Node ${process.version}, VM simulations of Chrome APIs and HTTP responses.\nNo live Facebook comments, logins, paid API requests, Chrome loading or browser rendering were performed.\n`;
  await fs.writeFile(path.join(web, 'setup/BRIDGE_TEST_REPORT.txt'), summary);
  console.log(`\n${report.length} checks passed.`);
} finally {
  for (const t of timers) clearTimeout(t);
  for (const t of intervals) clearInterval(t);
}
