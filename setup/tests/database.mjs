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

export async function createFixture() {
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
  await db.exec(await fs.readFile(path.join(setup, '01-database.sql'), 'utf8'));
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
    await test('New registration defaults to pending; repeat visits create one row and no stored plaintext token', async () => {
      assert.equal((await register()).rows[0].data.status, 'pending');
      await register();
      const rows = (await list()).rows[0].data;
      assert.equal(rows.total, 1); assert.equal(rows.rows[0].status, 'pending');
      assert(!('credential_hash' in rows.rows[0]));
      const stored = (await db.query('select credential_hash from public.tqt_device_licenses')).rows[0].credential_hash;
      assert.notEqual(stored, DEVICE_TOKEN); assert.match(stored, /^[a-f0-9]{64}$/);
    });
    await test('A different installation token cannot claim or use an existing KEY', async () => {
      const result = (await register(KEY, 'B'.repeat(64))).rows[0].data;
      assert.equal(result.authorized, false); assert.equal(result.status, 'registration_conflict');
      assert.equal((await list()).rows[0].data.total, 1);
    });
    await test('ADMIN can approve and block; stale edits fail without overwriting newer changes', async () => {
      const approved = (await update('approved', 0)).rows[0].data;
      assert.equal(approved.revision, 1);
      assert.equal((await register()).rows[0].data.authorized, true);
      await assert.rejects(update('blocked', 0), /TQT_REVISION_CONFLICT/);
      assert.equal((await register()).rows[0].data.authorized, true);
      await update('blocked', 1);
      assert.equal((await register()).rows[0].data.status, 'blocked');
    });
    await test('Server time enforces expiry and administrator filters use effective status', async () => {
      await update('approved', 2, '2000-01-01T00:00:00Z');
      const status = (await register()).rows[0].data;
      assert.equal(status.status, 'expired'); assert.equal(status.authorized, false);
      const filtered = (await call('authenticated', ADMIN_ID,
        'select public.tqt_admin_list_licenses($1,$2,$3,$4) as data', ['Khách','expired',0,50])).rows[0].data;
      assert.equal(filtered.total, 1);
    });
    await test('Resetting a registration revokes permission until ADMIN approves the replacement', async () => {
      await call('authenticated', ADMIN_ID, 'select public.tqt_admin_reset_registration($1,$2)', [KEY,3]);
      const next = (await register(KEY, 'B'.repeat(64))).rows[0].data;
      assert.equal(next.status, 'pending'); assert.equal(next.authorized, false);
      assert.equal((await register()).rows[0].data.status, 'registration_conflict');
    });
    await test('Malformed inputs and excessive query limits fail; audit entries exclude credential hashes', async () => {
      await assert.rejects(register('invalid'), /không hợp lệ/);
      await assert.rejects(register(KEY, ''), /không hợp lệ/);
      await assert.rejects(call('authenticated', ADMIN_ID, 'select public.tqt_admin_list_licenses($1,$2,$3,$4)', ['', 'all',0,1000]), /không hợp lệ/);
      const audit = (await db.query('select * from tqt_private.license_audit')).rows;
      assert.equal(audit.length, 4);
      assert(audit.every(row => !('credential_hash' in row.previous_values) && !('credential_hash' in row.next_values)));
    });
    await fs.writeFile(path.join(setup, 'DATABASE_TEST_REPORT.txt'), `${report.join('\n')}\n\n${report.length} PostgreSQL checks passed.\nEmbedded PostgreSQL via PGlite; auth.users/auth.uid are test fixtures, not a live Supabase project.\n`);
  } finally { await db.close(); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDatabaseTests();
