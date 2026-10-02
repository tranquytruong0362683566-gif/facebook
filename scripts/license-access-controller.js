(function () {
  'use strict';
  const gate = document.getElementById('licenseGate');
  const dashboard = document.getElementById('dashboardApp');
  const keyInput = document.getElementById('tqtMachineKeyInput');
  const status = document.getElementById('tqtLicenseStatus');
  const copyButton = document.getElementById('copyTqtMachineKeyBtn');
  const retryButton = document.getElementById('retryTqtLicenseBtn');
  let checkPromise = null;
  let previouslyConnected = false;

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state;
  }
  function lockDashboard(message = '') {
    const wasAuthorized = document.documentElement.dataset.tqtLicenseAuthorized === 'true';
    document.documentElement.classList.add('license-pending');
    document.documentElement.classList.remove('license-authorized');
    document.documentElement.dataset.tqtLicenseAuthorized = 'false';
    gate.setAttribute('aria-hidden', 'false');
    dashboard.setAttribute('inert', '');
    dashboard.setAttribute('aria-hidden', 'true');
    if (wasAuthorized) window.dispatchEvent(new CustomEvent('tqt:license-denied', { detail: { message } }));
  }
  function unlockDashboard() {
    if (!window.fbBridgeApi.bridgeAvailable()) return;
    const wasAuthorized = document.documentElement.dataset.tqtLicenseAuthorized === 'true';
    document.documentElement.classList.remove('license-pending');
    document.documentElement.classList.add('license-authorized');
    document.documentElement.dataset.tqtLicenseAuthorized = 'true';
    gate.setAttribute('aria-hidden', 'true');
    dashboard.removeAttribute('inert');
    dashboard.setAttribute('aria-hidden', 'false');
    if (!wasAuthorized) window.dispatchEvent(new CustomEvent('tqt:license-authorized'));
  }
  function renderLicense(data) {
    if (data.machineKey) keyInput.value = data.machineKey;
    if (data.authorized && window.fbBridgeApi.bridgeAvailable()) {
      setStatus(data.message || 'KEY đã được ADMIN cấp quyền.', 'ok');
      unlockDashboard();
    } else {
      const message = data.message || 'KEY chưa được ADMIN cấp quyền. Thêm KEY rồi bấm Kiểm tra lại.';
      lockDashboard(message);
      setStatus(message, ['TQT_LICENSE_NOT_FOUND', 'TQT_LICENSE_PENDING'].includes(data.code) ? 'waiting' : 'error');
    }
  }
  function checkLicense(forceRefresh = false) {
    if (checkPromise) return checkPromise;
    retryButton.disabled = true;
    setStatus('Web đang kiểm tra KEY bản quyền của thiết bị...', 'checking');
    checkPromise = (async () => {
      try { renderLicense(await window.TqtWebLicense.verify({ forceRefresh })); }
      catch (error) { renderLicense({ authorized: false, message: `Không kiểm tra được KEY: ${error.message}` }); }
      finally { retryButton.disabled = false; checkPromise = null; }
    })();
    return checkPromise;
  }
  copyButton.addEventListener('click', async () => {
    const value = keyInput.value.trim();
    if (!/^TQT-[A-F0-9]{27}$/.test(value)) return;
    try { await navigator.clipboard.writeText(value); }
    catch { keyInput.focus(); keyInput.select(); document.execCommand('copy'); }
    copyButton.textContent = 'Đã Copy!';
    setTimeout(() => { copyButton.textContent = 'Copy KEY'; }, 1400);
  });
  retryButton.addEventListener('click', () => checkLicense(true));
  window.addEventListener('tqt:license-status', event => renderLicense(event.detail || {}));
  window.addEventListener('autovip:bridge-status', event => {
    const connected = event.detail?.connected === true;
    if (!connected) renderLicense({ authorized: false, message: event.detail?.message || 'Chưa kết nối extension.' });
    else if (!previouslyConnected) checkLicense();
    previouslyConnected = connected;
  });
  window.addEventListener('focus', () => { if (window.fbBridgeApi.bridgeAvailable()) checkLicense(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.fbBridgeApi.bridgeAvailable()) checkLicense();
  });
  const timer = setInterval(() => { if (window.fbBridgeApi.bridgeAvailable()) checkLicense(); }, 30000);
  window.addEventListener('pagehide', event => { if (!event.persisted) clearInterval(timer); });
  lockDashboard();
  checkLicense();
}());
