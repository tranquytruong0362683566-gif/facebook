import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixture, ADMIN_ID, USER_ID, KEY, DEVICE_TOKEN } from './database.mjs';

const require = createRequire(process.env.TQT_TEST_NODE_MODULES ? `${process.env.TQT_TEST_NODE_MODULES}/tqt-tests.cjs` : import.meta.url);
const playwrightRequire = process.env.TQT_PLAYWRIGHT_NODE_MODULES
  ? createRequire(`${process.env.TQT_PLAYWRIGHT_NODE_MODULES}/tqt-tests.cjs`) : require;
const { chromium } = playwrightRequire('playwright');
const setup = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.dirname(setup);
let db, call;
const report = [];
const test = async (name, fn) => { await fn(); report.push(`PASS: ${name}`); console.log(report.at(-1)); };
const keyB = `TQT-${'B'.repeat(27)}`, keyC = `TQT-${'C'.repeat(27)}`;

const server = http.createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if (pathname === '/config/license-config.js') {
      response.writeHead(200, {'Content-Type':'text/javascript'});
      response.end("window.TqtLicenseConfig={dashboardUrl:'https://tranquytruong.top/',supabaseUrl:'https://tqt-fixture.supabase.co',supabasePublishableKey:'sb_publishable_SYNTHETIC_TEST'};"); return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = path.resolve(web, `.${pathname}`);
    if (!target.startsWith(`${web}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.sql':'text/plain'};
    response.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream'});
    response.end(await fs.readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  let launch = { headless:true };
  if (process.env.TQT_CHROMIUM_EXECUTABLE) {
    launch = { headless:true, executablePath:process.env.TQT_CHROMIUM_EXECUTABLE, args:['--no-sandbox','--no-zygote','--disable-gpu','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] };
  } else if (process.env.TQT_USE_PACKAGED_CHROMIUM === '1') {
    const module = require('@sparticuz/chromium'); const packaged = module.default || module;
    launch = { headless:true, args:packaged.args.filter(arg=>arg!=='--disable-web-security' && arg!=='--allow-running-insecure-content'), executablePath:await packaged.executablePath() };
  }
  browser = await chromium.launch(launch);
  const context = await browser.newContext({viewport:{width:1360,height:900},timezoneId:'Asia/Bangkok'});
  const errors=[];
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  // Start Chromium before PostgreSQL's WebAssembly heap is allocated.
  ({db,call}=await createFixture());
  for (const key of [KEY, keyB, keyC]) await call('anon','', 'select public.tqt_register_device($1,$2)', [key, DEVICE_TOKEN]);
  await db.query('update public.tqt_device_licenses set customer_name=$1 where machine_key=$2', ['<img src=x onerror=alert(1)>', keyB]);
  await db.query("update public.tqt_device_licenses set status='approved', expires_at='2000-01-01' where machine_key=$1", [keyC]);
  await context.route('https://tqt-fixture.supabase.co/**',async route=>{
    const req=route.request(), url=new URL(req.url());
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'apikey,authorization,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
    if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    const params=req.postDataJSON()||{};
    const token=req.headers().authorization?.replace('Bearer ','');
    const actor=token==='fixture-admin-access'?ADMIN_ID:token==='fixture-user-access'?USER_ID:'';
    try{
      let data;
      if(url.pathname==='/auth/v1/token'){
        if(url.searchParams.get('grant_type')==='refresh_token'){
          const admin=params.refresh_token==='fixture-admin-refresh';
          data={access_token:admin?'fixture-admin-access':'fixture-user-access',refresh_token:params.refresh_token,expires_in:3600,user:{id:admin?ADMIN_ID:USER_ID,email:admin?'admin@example.test':'user@example.test'}};
        }else{
          if(params.password!=='synthetic-password-only'){
            await route.fulfill({status:400,headers,json:{error_code:'invalid_credentials',message:'Email hoặc mật khẩu không đúng.'}});return;
          }
          const admin=params.email==='admin@example.test';
          data={access_token:admin?'fixture-admin-access':'fixture-user-access',refresh_token:admin?'fixture-admin-refresh':'fixture-user-refresh',expires_in:3600,user:{id:admin?ADMIN_ID:USER_ID,email:params.email}};
        }
      }else if(url.pathname==='/auth/v1/logout'){data=null;}
      else{
        const queries={
          tqt_is_license_admin:['select public.tqt_is_license_admin() as data',[]],
          tqt_admin_list_licenses:['select public.tqt_admin_list_licenses($1,$2,$3,$4) as data',[params.p_search,params.p_status,params.p_offset,params.p_limit]],
          tqt_admin_update_license:['select public.tqt_admin_update_license($1,$2,$3,$4,$5,$6) as data',[params.p_machine_key,params.p_status,params.p_customer_name,params.p_note,params.p_expires_at,params.p_expected_revision]],
          tqt_admin_reset_registration:['select public.tqt_admin_reset_registration($1,$2) as data',[params.p_machine_key,params.p_expected_revision]],
          tqt_register_device:['select public.tqt_register_device($1,$2) as data',[params.p_machine_key,params.p_device_token]]
        };
        const query=queries[url.pathname.split('/').at(-1)];
        if(!query)throw new Error('Unsupported test API');
        data=(await call(actor?'authenticated':'anon',actor,...query)).rows[0].data;
      }
      await route.fulfill({status:200,headers,json:data});
    }catch(error){await route.fulfill({status:error.code==='42501'?403:400,headers,json:{code:error.code,message:error.message}});}
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=async email=>{
    await page.locator('#adminEmail').fill(email); await page.locator('#adminPassword').fill('synthetic-password-only');
    await page.locator('#signInBtn').click();
  };
  await test('Login page renders on desktop and mobile without horizontal overflow',async()=>{
    await page.goto(`${base}/admin/`); await page.locator('#loginTitle').waitFor();
    await fs.mkdir(path.join(setup,'previews'),{recursive:true});
    await page.screenshot({path:path.join(setup,'previews/admin-login-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(setup,'previews/admin-login-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1360,height:900});
  });
  await test('Incorrect password and authenticated non-ADMIN accounts cannot enter management',async()=>{
    await page.locator('#adminEmail').fill('admin@example.test');await page.locator('#adminPassword').fill('wrong-password');await page.locator('#signInBtn').click();
    await page.waitForFunction(()=>document.getElementById('loginStatus').dataset.state==='error');
    assert(await page.locator('#adminPanel').isHidden());
    await login('user@example.test');
    await page.waitForFunction(()=>document.getElementById('loginStatus').textContent.includes('chưa được cấp quyền ADMIN'));
    assert(await page.locator('#adminPanel').isHidden());
  });
  await test('ADMIN login checks the server role; session restores and table content does not execute HTML',async()=>{
    await login('admin@example.test');await page.locator('#adminPanel').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('#licenseRows tr').length===3);
    assert.equal(await page.locator('#licenseRows img').count(),0);
    assert((await page.locator('#licenseRows').innerText()).includes('<img src=x onerror=alert(1)>'));
    assert.equal(await page.locator('#adminPassword').inputValue(),'');
    assert(!(await page.evaluate(()=>JSON.stringify(sessionStorage))).includes('synthetic-password-only'));
    await page.reload();await page.locator('#adminPanel').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('#licenseRows tr').length===3);
  });
  const openKey=async key=>page.locator('#licenseRows tr').filter({hasText:key}).getByRole('button',{name:`Quản lý ${key}`}).click();
  await test('Approving a KEY saves customer, notes and local expiry through the protected database RPC',async()=>{
    await openKey(KEY);await page.locator('#customerNameInput').fill('Máy thử A');await page.locator('#noteInput').fill('Đã duyệt thử nghiệm');
    const future=await page.evaluate(()=>{const d=new Date(Date.now()+30*86400000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);});
    await page.locator('#expiresAtInput').fill(future);await page.locator('#approveBtn').click();
    await page.locator('#editDialog').waitFor({state:'hidden'});
    const data=(await call('anon','', 'select public.tqt_register_device($1,$2) as data',[KEY,DEVICE_TOKEN])).rows[0].data;
    assert.equal(data.authorized,true);assert(data.expiresAt);
    assert.equal((await db.query('select customer_name from public.tqt_device_licenses where machine_key=$1',[KEY])).rows[0].customer_name,'Máy thử A');
  });
  await test('Blocking and status/search filters reflect actual server permissions',async()=>{
    await page.locator('#refreshBtn').click();await page.waitForFunction(()=>!document.getElementById('refreshBtn').disabled);
    await openKey(KEY);await page.locator('#blockBtn').click();await page.locator('#editDialog').waitFor({state:'hidden'});
    assert.equal((await call('anon','', 'select public.tqt_register_device($1,$2) as data',[KEY,DEVICE_TOKEN])).rows[0].data.authorized,false);
    await page.locator('#searchInput').fill('Máy thử A');await page.locator('#filterForm').getByRole('button',{name:'Tìm kiếm'}).click();
    await page.waitForFunction(()=>document.getElementById('recordCount').textContent==='1');
    await page.locator('#searchInput').fill('');await page.locator('#statusFilter').selectOption('expired');
    await page.waitForFunction(()=>document.getElementById('licenseRows').textContent.includes('TQT-'+ 'C'.repeat(27)));
    assert.equal(await page.locator('#licenseRows tr').count(),1);
    await page.locator('#statusFilter').selectOption('all');await page.waitForFunction(()=>document.querySelectorAll('#licenseRows tr').length===3);
  });
  await test('Conflicting edits are rejected instead of silently overwriting another ADMIN session',async()=>{
    await openKey(KEY);
    await db.query('update public.tqt_device_licenses set revision=revision+1 where machine_key=$1',[KEY]);
    await page.locator('#saveLicenseBtn').click();
    await page.waitForFunction(()=>document.getElementById('editStatus').textContent.includes('phiên khác'));
    await page.locator('#closeEditBtn').click();
    await db.query('update public.tqt_device_licenses set customer_name=$1 where machine_key=$2',['Máy thử B',keyB]);
    await page.locator('#refreshBtn').click();await page.waitForFunction(()=>document.getElementById('licenseRows').textContent.includes('Máy thử B'));
    await page.screenshot({path:path.join(setup,'previews/admin-devices-desktop.png'),fullPage:true});
  });
  await test('Logout clears the visible data and session; no browser runtime errors occurred',async()=>{
    await page.locator('#signOutBtn').click();await page.locator('#loginPanel').waitFor({state:'visible'});
    assert.equal(await page.locator('#licenseRows tr').count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.length),0);
    assert.deepEqual(errors,[]);
  });
  await fs.writeFile(path.join(setup,'BROWSER_TEST_REPORT.txt'),`${report.join('\n')}\n\n${report.length} browser checks passed.\nReal headless Chromium with actual application files and PostgreSQL RPC functions. Supabase Auth HTTP responses and JWT identity mapping are simulated. No live Supabase/GitHub deployment or Facebook actions were performed.\n`);
}finally{
  await browser?.close();server.close();await db?.close();
}
