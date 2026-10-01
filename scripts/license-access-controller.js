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
  function lockDashboard() {
    document.documentElement.classList.add('license-pending');
    document.documentElement.classList.remove('license-authorized');
    document.documentElement.dataset.tqtLicenseAuthorized = 'false';
    gate.setAttribute('aria-hidden', 'false');
    dashboard.setAttribute('inert', '');
    dashboard.setAttribute('aria-hidden', 'true');
  }
  function unlockDashboard() {
    if (!window.fbBridgeApi.bridgeAvailable()) return;
    document.documentElement.classList.remove('license-pending');
    document.documentElement.classList.add('license-authorized');
    document.documentElement.dataset.tqtLicenseAuthorized = 'true';
    gate.setAttribute('aria-hidden', 'true');
    dashboard.removeAttribute('inert');
    dashboard.setAttribute('aria-hidden', 'false');
    window.dispatchEvent(new CustomEvent('tqt:license-authorized'));
  }
  function checkLicense(forceRefresh = false) {
    if (checkPromise) return checkPromise;
    retryButton.disabled = true;
    setStatus('Đang kiểm tra KEY bản quyền của thiết bị...', 'checking');
    checkPromise = (async () => {
      try {
        const response = await window.fbBridgeApi.sendRawBridge('GET_TQT_LICENSE_STATUS',
          { forceRefresh }, { allowFailure: true });
        const data = window.fbBridgeApi.bridgeResponseData(response);
        if (data.machineKey) keyInput.value = data.machineKey;
        if (data.authorized === true) {
          setStatus('KEY đã được ADMIN cấp quyền.', 'ok');
          unlockDashboard();
        } else {
          lockDashboard();
          setStatus(data.message || response.error || 'KEY chưa được ADMIN cấp quyền. Thêm KEY rồi bấm Kiểm tra lại.',
            data.code === 'TQT_LICENSE_NOT_FOUND' ? 'waiting' : 'error');
        }
      } catch (error) {
        lockDashboard();
        setStatus(`Không kiểm tra được KEY: ${error.message}`, 'error');
      } finally {
        retryButton.disabled = false;
        checkPromise = null;
      }
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
  window.addEventListener('autovip:bridge-status', event => {
    const connected = event.detail?.connected === true;
    if (!connected) {
      lockDashboard();
      setStatus(event.detail?.message || 'Chưa kết nối extension.', 'error');
    } else if (!previouslyConnected) checkLicense();
    previouslyConnected = connected;
  });
  checkLicense();
}());
