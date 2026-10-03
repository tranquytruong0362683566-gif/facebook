import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(process.env.TQT_TEST_NODE_MODULES
  ? `${process.env.TQT_TEST_NODE_MODULES}/tqt-tests.cjs` : import.meta.url);
const { PGlite } = require('@electric-sql/pglite');
const setup = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
export const KEY = `TQT-${'A'.repeat(27)}`;
export const DEVICE_TOKEN = 'A'.repeat(64);

export async function createFixture({ legacySchema = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values
      ('${ADMIN_ID}', 'admin@example.test', now(), false),
      ('${USER_ID}', 'user@example.test', now(), false);
  `);
  await db.exec(await fs.readFile(path.join(setup, legacySchema ? 'tests/fixtures/database-v4.2.0.sql' : '01-database.sql'), 'utf8'));
  await db.exec((await fs.readFile(path.join(setup, '02-create-admin.sql'), 'utf8')).replace('THAY_EMAIL_ADMIN_CUA_BAN', 'admin@example.test'));
  async function call(role, userId, sql, params = []) {
    return db.transaction(async tx => {
      await tx.exec(`set local role ${role};`);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId || '']);
      return tx.query(sql, params);
    });
  }
  return { db, call };
}

export async function runDatabaseTests() {
  const { db, call } = await createFixture();
  const report = [];
  const test = async (name, fn) => { await fn(); report.push(`PASS: ${name}`); console.log(report.at(-1)); };
  const register = (key = KEY, token = DEVICE_TOKEN) => call('anon', '',
    'select public.tqt_register_device($1,$2) as data', [key, token]);
  const registerKeyOnly = (key = KEY) => call('anon', '',
    'select public.tqt_register_device($1) as data', [key]);
  const checkEveryInstallation = async status => {
    for (const token of [DEVICE_TOKEN, 'B'.repeat(64), null, 'legacy-token']) {
      const result = (await register(KEY, token)).rows[0].data;
      assert.equal(result.status, status);
      assert.equal(result.authorized, status === 'approved');
    }
    assert.equal((await registerKeyOnly()).rows[0].data.status, status);
  };
  const list = () => call('authenticated', ADMIN_ID, 'select public.tqt_admin_list_licenses() as data');
  const update = (status, revision, expiry = null) => call('authenticated', ADMIN_ID,
    'select public.tqt_admin_update_license($1,$2,$3,$4,$5,$6) as data',
    [KEY, status, 'Khách thử nghiệm', '<img src=x onerror=alert(1)>', expiry, revision]);
  try {
    await test('Schema and ADMIN bootstrap execute on actual PostgreSQL', async () => {
      assert.equal((await call('authenticated', ADMIN_ID, 'select public.tqt_is_license_admin() as allowed')).rows[0].allowed, true);
      assert.equal((await call('authenticated', USER_ID, 'select public.tqt_is_license_admin() as allowed')).rows[0].allowed, false);
      const flags = await db.query("select relrowsecurity from pg_class where relname in ('tqt_device_licenses','license_admins','license_audit')");
      assert.equal(flags.rows.length, 3); assert(flags.rows.every(row => row.relrowsecurity));
    });
    await test('Anonymous and non-ADMIN users cannot read tables, list devices or approve keys', async () => {
      await assert.rejects(call('anon', '', 'select * from public.tqt_device_licenses'), /permission denied/);
      await assert.rejects(call('authenticated', USER_ID, 'select * from public.tqt_device_licenses'), /permission denied/);
      await assert.rejects(call('anon', '', 'select public.tqt_admin_list_licenses()'), /permission denied/);
      await assert.rejects(call('authenticated', USER_ID, 'select public.tqt_admin_list_licenses()'), /ADMIN/);
      await assert.rejects(call('authenticated', USER_ID, 'select public.tqt_admin_update_license($1,$2,$3,$4,$5,$6)', [KEY,'approved','','',null,0]), /ADMIN/);
      await assert.rejects(call('authenticated', USER_ID, 'select * from tqt_private.license_admins'), /permission denied/);
    });
    await test('New KEY-only registration defaults to pending; repeat visits create one row without claiming an installation', async () => {
      assert.equal((await registerKeyOnly()).rows[0].data.status, 'pending');
      await register();
      const rows = (await list()).rows[0].data;
      assert.equal(rows.total, 1); assert.equal(rows.rows[0].status, 'pending');
      assert(!('credential_hash' in rows.rows[0]));
      const stored = (await db.query('select credential_hash from public.tqt_device_licenses')).rows[0].credential_hash;
      assert.equal(stored, null);
    });
    await test('Different legacy installation tokens share the pending status of one KEY', async () => {
      await checkEveryInstallation('pending');
      assert.equal((await list()).rows[0].data.total, 1);
    });
    await test('ADMIN can approve and block; stale edits fail without overwriting newer changes', async () => {
      const approved = (await update('approved', 0)).rows[0].data;
      assert.equal(approved.revision, 1);
      await checkEveryInstallation('approved');
      await assert.rejects(update('blocked', 0), /TQT_REVISION_CONFLICT/);
      assert.equal((await register()).rows[0].data.authorized, true);
      await update('blocked', 1);
      await checkEveryInstallation('blocked');
    });
    await test('Server time enforces expiry and administrator filters use effective status', async () => {
      await update('approved', 2, '2000-01-01T00:00:00Z');
      const status = (await register()).rows[0].data;
      assert.equal(status.status, 'expired'); assert.equal(status.authorized, false);
      await checkEveryInstallation('expired');
      const filtered = (await call('authenticated', ADMIN_ID,
        'select public.tqt_admin_list_licenses($1,$2,$3,$4) as data', ['Khách','expired',0,50])).rows[0].data;
      assert.equal(filtered.total, 1);
    });
    await test('Legacy ADMIN reset API remains protected and changes the shared KEY to pending', async () => {
      await assert.rejects(call('authenticated', USER_ID, 'select public.tqt_admin_reset_registration($1,$2)', [KEY,3]), /ADMIN/);
      await call('authenticated', ADMIN_ID, 'select public.tqt_admin_reset_registration($1,$2)', [KEY,3]);
      const next = (await register(KEY, 'B'.repeat(64))).rows[0].data;
      assert.equal(next.status, 'pending'); assert.equal(next.authorized, false);
      await checkEveryInstallation('pending');
    });
    await test('Malformed inputs and excessive query limits fail; audit entries exclude credential hashes', async () => {
      await assert.rejects(register('invalid'), /không hợp lệ/);
      await assert.rejects(registerKeyOnly(null), /không hợp lệ/);
      await assert.rejects(call('authenticated', ADMIN_ID, 'select public.tqt_admin_list_licenses($1,$2,$3,$4)', ['', 'all',0,1000]), /không hợp lệ/);
      const audit = (await db.query('select * from tqt_private.license_audit')).rows;
      assert.equal(audit.length, 4);
      assert(audit.every(row => !('credential_hash' in row.previous_values) && !('credential_hash' in row.next_values)));
    });
  } finally { await db.close(); }
  const legacy = await createFixture({ legacySchema: true });
  const migration = await fs.readFile(path.join(setup, '03-share-approved-key.sql'), 'utf8');
  const keyB = `TQT-${'B'.repeat(27)}`, keyC = `TQT-${'C'.repeat(27)}`;
  const legacyRegister = (key, token = DEVICE_TOKEN) => legacy.call('anon', '',
    'select public.tqt_register_device($1,$2) as data', [key, token]);
  const snapshot = async () => (await legacy.db.query('select * from public.tqt_device_licenses order by machine_key')).rows;
  let before;
  try {
    for (const [key, status, expiry] of [[KEY,'approved','2099-01-01'], [keyB,'blocked',null], [keyC,'approved','2000-01-01']]) {
      await legacyRegister(key);
      await legacy.call('authenticated', ADMIN_ID,
        'select public.tqt_admin_update_license($1,$2,$3,$4,$5,$6)',
        [key,status,'Khách hiện có','Ghi chú giữ lại',expiry,0]);
    }
    assert.equal((await legacyRegister(KEY, 'B'.repeat(64))).rows[0].data.status, 'registration_conflict');
    before = await snapshot();
    await test('Upgrade from actual 4.2.0 schema preserves every license field, ADMIN membership and audit history', async () => {
      await legacy.db.exec(migration);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await legacy.call('authenticated', ADMIN_ID, 'select public.tqt_is_license_admin() as allowed')).rows[0].allowed, true);
      assert.equal((await legacy.db.query('select count(*)::int as total from tqt_private.license_audit')).rows[0].total, 3);
    });
    await test('Migrated approved KEY accepts old web tokens and new KEY-only calls without changing its existing hash', async () => {
      for (const token of [DEVICE_TOKEN, 'B'.repeat(64), null]) {
        const result = (await legacyRegister(KEY, token)).rows[0].data;
        assert.equal(result.authorized, true); assert.equal(result.status, 'approved');
      }
      assert.equal((await legacy.call('anon', '', 'select public.tqt_register_device($1) as data', [KEY])).rows[0].data.authorized, true);
      assert.deepEqual(await snapshot(), before);
    });
    await test('Upgrade keeps blocked/expired KEYs denied; unknown KEY stays pending and non-ADMIN cannot approve', async () => {
      for (const [key,status] of [[keyB,'blocked'],[keyC,'expired']]) {
        for (const token of [DEVICE_TOKEN,'B'.repeat(64)]) {
          const result = (await legacyRegister(key,token)).rows[0].data;
          assert.equal(result.status,status); assert.equal(result.authorized,false);
        }
      }
      const newKey=`TQT-${'D'.repeat(27)}`;
      assert.equal((await legacyRegister(newKey)).rows[0].data.status,'pending');
      await assert.rejects(legacy.call('authenticated', USER_ID,
        'select public.tqt_admin_update_license($1,$2,$3,$4,$5,$6)', [newKey,'approved','','',null,0]), /ADMIN/);
      await assert.rejects(legacy.call('anon','', 'select * from public.tqt_device_licenses'), /permission denied/);
    });
    await test('Shared-KEY migration can be rerun without resetting data or creating an ambiguous RPC overload', async () => {
      const current = await snapshot();
      await legacy.db.exec(migration);
      assert.deepEqual(await snapshot(),current);
      const functions = (await legacy.db.query("select pronargs, pronargdefaults from pg_proc where oid='public.tqt_register_device(text,text)'::regprocedure")).rows;
      assert.equal(functions[0].pronargs,2); assert.equal(functions[0].pronargdefaults,1);
      assert.equal((await legacy.db.query("select count(*)::int as total from pg_proc where proname='tqt_register_device'")).rows[0].total,1);
    });
  } finally { await legacy.db.close(); }
  await fs.writeFile(path.join(setup, 'DATABASE_TEST_REPORT.txt'), `${report.join('\n')}\n\n${report.length} PostgreSQL checks passed.\nTest date: ${new Date().toISOString().slice(0,10)}.\nEmbedded PostgreSQL via PGlite; auth.users/auth.uid are test fixtures, not a live Supabase project.\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDatabaseTests();
