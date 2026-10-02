(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const pageSize = 50;
  const labels = { pending: 'Chờ duyệt', approved: 'Được cấp quyền', blocked: 'Đã khóa', expired: 'Hết hạn' };
  let api;
  let offset = 0;
  let total = 0;
  let currentRows = [];
  let editing = null;
  let authorized = false;
  let loadController = null;
  let loadEpoch = 0;
  let authEpoch = 0;
  let saving = false;

  function message(id, text = '', state = '') { $(id).textContent = text; $(id).dataset.state = state; }
  function dateText(value) { return value ? new Date(value).toLocaleString('vi-VN') : 'Không giới hạn'; }
  function showLogin(text = '') {
    authEpoch += 1;
    authorized = false;
    editing = null;
    loadEpoch += 1;
    loadController?.abort();
    $('editDialog').close();
    $('adminPanel').hidden = true;
    $('loginPanel').hidden = false;
    $('licenseRows').replaceChildren();
    currentRows = [];
    message('loginStatus', text, text ? 'error' : '');
  }
  async function requireAdmin() {
    if (!await api.rpc('tqt_is_license_admin', {}, { admin: true })) {
      api.clearSession();
      throw new Error('Tài khoản này chưa được cấp quyền ADMIN.');
    }
  }
  async function showAdmin() {
    const epoch = authEpoch;
    await requireAdmin();
    if (epoch !== authEpoch) return;
    authorized = true;
    $('loginPanel').hidden = true;
    $('adminPanel').hidden = false;
    $('adminIdentity').textContent = api.user()?.email || 'ADMIN';
    offset = 0;
    await loadRows();
  }

  function renderRows(rows) {
    $('licenseRows').replaceChildren();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const keyCell = document.createElement('td');
      const key = document.createElement('span'); key.className = 'table-key'; key.textContent = row.machine_key;
      const firstSeen = document.createElement('span'); firstSeen.className = 'table-key-note'; firstSeen.textContent = `Đăng ký ${dateText(row.first_seen_at)}`;
      keyCell.append(key, firstSeen); tr.append(keyCell);
      const customer = document.createElement('td'); customer.textContent = row.customer_name || 'Chưa ghi tên'; tr.append(customer);
      const stateCell = document.createElement('td'); const badge = document.createElement('span');
      const status = row.effective_status || row.status;
      badge.className = `badge badge-${Object.hasOwn(labels, status) ? status : 'pending'}`;
      badge.textContent = labels[status] || 'Chờ duyệt'; stateCell.append(badge); tr.append(stateCell);
      for (const value of [row.expires_at, row.last_seen_at]) { const td = document.createElement('td'); td.textContent = dateText(value); tr.append(td); }
      const actions = document.createElement('td'); const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary'; button.textContent = 'Quản lý';
      button.setAttribute('aria-label', `Quản lý ${row.machine_key}`);
      button.addEventListener('click', () => openEditor(row)); actions.append(button); tr.append(actions);
      $('licenseRows').append(tr);
    }
    $('emptyState').hidden = rows.length !== 0;
    $('recordCount').textContent = String(total);
    $('pageInfo').textContent = `Trang ${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
    $('previousPageBtn').disabled = offset === 0;
    $('nextPageBtn').disabled = offset + pageSize >= total;
  }

  async function loadRows() {
    if (!authorized) return;
    const epoch = ++loadEpoch;
    loadController?.abort();
    const controller = new AbortController(); loadController = controller;
    $('refreshBtn').disabled = true;
    try {
      const data = await api.rpc('tqt_admin_list_licenses', {
        p_search: $('searchInput').value.trim(), p_status: $('statusFilter').value,
        p_offset: offset, p_limit: pageSize
      }, { admin: true, signal: controller.signal });
      if (epoch !== loadEpoch || !authorized) return;
      if (!Array.isArray(data?.rows) || !Number.isInteger(data.total) || data.total < 0) throw new Error('Danh sách KEY không hợp lệ.');
      total = data.total;
      currentRows = data.rows;
      if (offset > 0 && offset >= total) { offset = 0; return loadRows(); }
      renderRows(currentRows);
      message('adminStatus', `Cập nhật lúc ${new Date().toLocaleTimeString('vi-VN')}`, 'ok');
    } catch (error) {
      if (controller.signal.aborted || epoch !== loadEpoch) return;
      if (error.status === 401 || error.status === 403 || error.code === '42501') {
        api.clearSession(); showLogin(error.message); return;
      }
      message('adminStatus', error.message, 'error');
    } finally { if (epoch === loadEpoch) $('refreshBtn').disabled = false; }
  }

  function openEditor(row) {
    editing = { ...row };
    $('editKey').textContent = row.machine_key;
    $('customerNameInput').value = row.customer_name || '';
    $('licenseStatusInput').value = row.status;
    $('noteInput').value = row.note || '';
    const date = row.expires_at ? new Date(row.expires_at) : null;
    $('expiresAtInput').value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    message('editStatus'); $('editDialog').showModal();
  }
  function disableEditor(disabled) {
    for (const id of ['approveBtn','blockBtn','saveLicenseBtn','resetRegistrationBtn','closeEditBtn']) $(id).disabled = disabled;
  }
  async function saveLicense(overrideStatus = null, resetRegistration = false) {
    if (!authorized || !editing || saving) return;
    if (!$('editForm').reportValidity()) return;
    const epoch = authEpoch;
    const row = { ...editing };
    saving = true; disableEditor(true); message('editStatus', 'Đang lưu...');
    try {
      let params;
      if (resetRegistration) params = { p_machine_key: row.machine_key, p_expected_revision: row.revision };
      else {
        const expiration = $('expiresAtInput').value;
        const date = expiration ? new Date(expiration) : null;
        if (date && !Number.isFinite(date.getTime())) throw new Error('Hạn sử dụng không hợp lệ.');
        if (overrideStatus === 'approved' && date && date.getTime() <= Date.now()) {
          throw new Error('Chọn hạn dùng trong tương lai hoặc để trống trước khi cấp quyền.');
        }
        params = { p_machine_key: row.machine_key, p_expected_revision: row.revision,
          p_status: overrideStatus || $('licenseStatusInput').value,
          p_customer_name: $('customerNameInput').value.trim(), p_note: $('noteInput').value,
          p_expires_at: date ? date.toISOString() : null };
      }
      await api.rpc(resetRegistration ? 'tqt_admin_reset_registration' : 'tqt_admin_update_license', params, { admin: true });
      if (epoch !== authEpoch || !authorized) return;
      $('editDialog').close(); editing = null;
      await loadRows();
    } catch (error) {
      if (epoch !== authEpoch || !authorized) return;
      if (error.status === 401 || error.status === 403 || error.code === '42501') { api.clearSession(); showLogin(error.message); }
      else message('editStatus', error.message, 'error');
    } finally { saving = false; disableEditor(false); }
  }

  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!api || $('signInBtn').disabled) return;
    $('signInBtn').disabled = true; message('loginStatus', 'Đang đăng nhập...');
    try {
      await api.signIn($('adminEmail').value, $('adminPassword').value);
      $('adminPassword').value = '';
      await showAdmin();
    } catch (error) { api.clearSession(); showLogin(error.message); }
    finally { $('adminPassword').value = ''; $('signInBtn').disabled = false; }
  });
  $('signOutBtn').addEventListener('click', async () => {
    showLogin();
    try { await api.signOut(); } catch { message('loginStatus', 'Đã đóng phiên trên trình duyệt. Dịch vụ chưa xác nhận đăng xuất.', 'error'); }
  });
  $('filterForm').addEventListener('submit', event => { event.preventDefault(); offset = 0; loadRows(); });
  $('statusFilter').addEventListener('change', () => { offset = 0; loadRows(); });
  $('refreshBtn').addEventListener('click', loadRows);
  $('previousPageBtn').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); loadRows(); });
  $('nextPageBtn').addEventListener('click', () => { if (offset + pageSize < total) { offset += pageSize; loadRows(); } });
  $('closeEditBtn').addEventListener('click', () => { if (!saving) { $('editDialog').close(); editing = null; } });
  $('editDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); else editing = null; });
  $('editForm').addEventListener('submit', event => { event.preventDefault(); saveLicense(); });
  $('approveBtn').addEventListener('click', () => saveLicense('approved'));
  $('blockBtn').addEventListener('click', () => saveLicense('blocked'));
  $('resetRegistrationBtn').addEventListener('click', () => {
    if (confirm('Hủy quyền hiện tại và cho phép KEY đăng ký lại extension? KEY sẽ trở về Chờ duyệt.')) saveLicense(null, true);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && authorized) loadRows(); });
  const poll = setInterval(() => { if (authorized && !document.hidden && !editing && !saving) loadRows(); }, 30000);
  window.addEventListener('pagehide', event => { if (!event.persisted) { clearInterval(poll); loadController?.abort(); } });
  try {
    api = window.TqtSupabaseApi.createClient(window.TqtLicenseConfig, sessionStorage);
    if (api.user()) showAdmin().catch(error => { api.clearSession(); showLogin(error.message); });
  } catch (error) { $('signInBtn').disabled = true; message('loginStatus', error.message, 'error'); }
})();
