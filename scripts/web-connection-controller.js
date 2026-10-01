(() => {
  'use strict';
  const address = document.getElementById('webDashboardAddress');
  const status = document.getElementById('webExtensionStatus');
  const gateStatus = document.getElementById('webBridgeStatus');
  const dataDialog = document.getElementById('webDataDialog');
  const backupStatus = document.getElementById('webBackupStatus');
  const dashboardUrl = window.TqtLicenseConfig.dashboardUrl;
  address.value = dashboardUrl;

  function renderConnection() {
    const state = window.fbBridgeApi.getBridgeStatus();
    status.textContent = state.connected ? `Extension ${state.extensionVersion} · Đã kết nối` : 'Extension · Chưa kết nối';
    status.dataset.connected = String(state.connected);
    const isOfficialPage = location.origin === new URL(dashboardUrl).origin
      && ['/', '/index.html'].includes(location.pathname);
    gateStatus.textContent = isOfficialPage ? state.message
      : 'Mở https://tranquytruong.top/ để kết nối extension. Trang xem trước chỉ hiển thị giao diện.';
  }
  window.addEventListener('autovip:bridge-status', renderConnection);
  document.getElementById('webReconnectBtn').addEventListener('click', () => window.fbBridgeApi.reconnect());
  document.getElementById('copyWebAddressBtn').addEventListener('click', async event => {
    try { await navigator.clipboard.writeText(address.value); }
    catch { address.select(); document.execCommand('copy'); }
    event.currentTarget.textContent = 'Đã sao chép';
    setTimeout(() => { document.getElementById('copyWebAddressBtn').textContent = 'Copy địa chỉ'; }, 1200);
  });
  document.querySelectorAll('[data-open-backup]').forEach(button => button.addEventListener('click', () => dataDialog.showModal()));
  document.getElementById('closeWebDataDialogBtn').addEventListener('click', () => dataDialog.close());
  document.getElementById('webExportDataBtn').addEventListener('click', () => {
    const count = window.TqtDashboardBackup.downloadBackup(localStorage,
      document.getElementById('includeBackupSecrets').checked);
    backupStatus.textContent = `Đã xuất ${count} mục dữ liệu.`;
  });
  document.getElementById('webImportDataBtn').addEventListener('click', async () => {
    if (window.fbBridgeShared?.isBridgeBusy() || window.fbBridgeShared?.isClosedLoopRunning()) {
      backupStatus.textContent = 'Dừng tiến trình đang chạy trước khi nhập dữ liệu.';
      return;
    }
    const file = document.getElementById('webBackupFileInput').files[0];
    if (!file) { backupStatus.textContent = 'Chọn file JSON đã xuất từ công cụ.'; return; }
    try {
      if (file.size > window.TqtDashboardBackup.MAX_BYTES) throw new Error('File dữ liệu vượt quá 20 MB.');
      const items = window.TqtDashboardBackup.parseBackup(await file.text());
      const count = Object.keys(items).length;
      if (!count) throw new Error('File không có dữ liệu để nhập.');
      if (!confirm(`Nhập ${count} mục dữ liệu và thay thế các mục cùng tên trên trình duyệt này?`)) return;
      window.TqtDashboardBackup.restoreBackup(localStorage, items);
      location.reload();
    } catch (error) { backupStatus.textContent = error.message; }
  });
  renderConnection();
})();
