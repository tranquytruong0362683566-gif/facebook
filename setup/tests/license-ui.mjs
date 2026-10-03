import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const setup = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = process.env.TQT_EXTENSION_ROOT || path.resolve(setup, '../../extension/auto binh luan');
const require = createRequire(process.env.TQT_PLAYWRIGHT_NODE_MODULES
  ? `${process.env.TQT_PLAYWRIGHT_NODE_MODULES}/tqt-ui.cjs` : import.meta.url);
const { chromium } = require('playwright');
const report = [];
const test = async (name, fn) => { await fn(); report.push(`PASS: ${name}`); console.log(report.at(-1)); };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.resolve(extension, `.${pathname}`);
    if (!target.startsWith(`${extension}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
    response.writeHead(200, { 'Content-Type': type[path.extname(target)] || 'application/octet-stream' });
    response.end(await fs.readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TQT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.TQT_CHROMIUM_EXECUTABLE,
      args: ['--no-sandbox', '--no-zygote', '--single-process', '--in-process-gpu', '--disable-dev-shm-usage'] } : {}) });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    window.__fixtureLicense = { authorized: false, machineKey: `TQT-${'A'.repeat(27)}`,
      status: 'pending', expiresAt: null, code: 'TQT_LICENSE_PENDING', message: 'KEY đang chờ ADMIN duyệt trên tranquytruong.top.' };
    window.__fixtureChecks = 0;
    window.__fixtureRevocations = 0;
    window.addEventListener('tqt:license-revoked', () => window.__fixtureRevocations++);
    const status = () => {
      const value = { ...window.__fixtureLicense };
      if (value.authorized && value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) {
        Object.assign(value, { authorized: false, status: 'expired', code: 'TQT_LICENSE_EXPIRED', message: 'KEY đã hết hạn sử dụng.' });
      }
      return value;
    };
    window.chrome = { runtime: {
      getManifest: () => ({ version: '3.1.0' }),
      sendMessage: (_message, callback) => {
        window.__fixtureChecks++;
        queueMicrotask(() => callback({ ok: true, data: status() }));
      },
      connect: () => {
        const listeners = [];
        return { onMessage: { addListener: fn => listeners.push(fn) }, onDisconnect: { addListener() {} },
          disconnect() {}, postMessage: message => queueMicrotask(() => {
            const value = status();
            const reply = value.authorized
              ? { requestId: message.requestId, ok: true, success: true, code: 'FACEBOOK_ACCOUNT_NOT_FOUND',
                  data: { loggedIn: false, uid: '', cookieCount: 0 } }
              : { requestId: message.requestId, ok: false, success: false, code: value.code, message: value.message, data: value };
            listeners.forEach(fn => fn(reply));
          }) };
      }
    } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/dashboard/dashboard.html`);
  await test('The actual dashboard hides controls and displays the retained device KEY while waiting for approval', async () => {
    await page.waitForFunction(() => document.getElementById('tqtLicenseStatus').dataset.state === 'waiting');
    assert.equal(await page.locator('#tqtMachineKeyInput').inputValue(), `TQT-${'A'.repeat(27)}`);
    assert(await page.locator('#dashboardApp').evaluate(element => element.inert));
    assert(await page.locator('#licenseGate').isVisible());
    assert.equal(await page.locator('#licenseGate a').getAttribute('href'), 'https://tranquytruong.top/');
  });
  await test('Periodic approval checks unlock the full dashboard without reload', async () => {
    await page.evaluate(() => Object.assign(window.__fixtureLicense,
      { authorized: true, status: 'approved', code: 'TQT_LICENSE_AUTHORIZED', message: 'KEY đã được ADMIN cấp quyền.' }));
    await page.clock.runFor(30001);
    await page.waitForFunction(() => document.documentElement.dataset.tqtLicenseAuthorized === 'true');
    assert(await page.locator('#licenseGate').isHidden());
    assert.equal(await page.locator('#dashboardApp').evaluate(element => element.inert), false);
  });
  await test('Revocation closes the dashboard and stops the active automation state', async () => {
    await page.evaluate(() => {
      window.fbBridgeShared.setClosedLoopRunning(true);
      Object.assign(window.__fixtureLicense,
        { authorized: false, status: 'blocked', code: 'TQT_LICENSE_BLOCKED', message: 'KEY đã bị ADMIN khóa.' });
      return window.TqtLicenseAccess.check(true);
    });
    assert(await page.locator('#licenseGate').isVisible());
    assert.equal(await page.evaluate(() => window.fbBridgeShared.isClosedLoopRunning()), false);
    assert.equal(await page.evaluate(() => window.__fixtureRevocations), 1);
  });
  await test('The dashboard locks at the expiry boundary and a later network failure never restores old authorization', async () => {
    await page.evaluate(() => {
      Object.assign(window.__fixtureLicense, { authorized: true, status: 'approved',
        code: 'TQT_LICENSE_AUTHORIZED', expiresAt: new Date(Date.now() + 1000).toISOString() });
      return window.TqtLicenseAccess.check(true);
    });
    await page.clock.runFor(1001);
    await page.waitForFunction(() => document.documentElement.dataset.tqtLicenseAuthorized === 'false');
    assert(await page.locator('#tqtLicenseStatus').textContent().then(text => text.includes('hết hạn')));
    await page.evaluate(() => {
      Object.assign(window.__fixtureLicense, { authorized: false, status: 'unavailable',
        code: 'TQT_LICENSE_SOURCE_UNAVAILABLE', message: 'Không kết nối được web quản lý KEY.' });
      return window.TqtLicenseAccess.check(true);
    });
    assert(await page.locator('#dashboardApp').evaluate(element => element.inert));
    assert.equal(await page.locator('#tqtLicenseStatus').getAttribute('data-state'), 'error');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(setup, 'previews/extension-key-gate-desktop.png'), fullPage: true });
  });
  await fs.writeFile(path.join(setup, 'LICENSE_UI_TEST_REPORT.txt'), `${report.join('\n')}\n\n${report.length} dashboard UI checks passed.\nReal headless Chromium loads all dashboard application files. Chrome message responses and license states are simulated; no Facebook action or live deployment was performed.\n`);
} finally { await browser?.close(); server.close(); }
