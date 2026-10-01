(function () {
  'use strict';
  const STORAGE_KEY = 'tqtWebLicenseDailyStatusV1';
  const FAILURE_TTL_MS = 5 * 60 * 1000;
  const TIMEOUT_MS = 15000;
  const MAX_LIST_BYTES = 2 * 1024 * 1024;
  let machineKey = '';
  let statusCache = null;
  let checkPromise = null;
  let activeController = null;
  let connectionEpoch = 0;
  let lastPublished = '';

  function calendarDay(timestamp = Date.now()) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function sourceUrl() {
    const url = new URL(window.TqtLicenseConfig.keysSourceUrl, location.href);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Địa chỉ danh sách KEY phải dùng HTTPS.');
    url.hash = '';
    return url.href;
  }

  function readSavedStatus() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
  }

  function saveStatus(status) {
    // If browser storage is unavailable or full, verification still works in memory.
    try {
      if (['TQT_LICENSE_AUTHORIZED', 'TQT_LICENSE_NOT_FOUND'].includes(status.code)) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(status));
      } else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  function validDailyStatus(value, key, url, day) {
    if (!value || value.machineKey !== key || value.sourceUrl !== url || value.checkedDay !== day) return false;
    if (!Number.isFinite(value.checkedAt) || value.checkedAt > Date.now() + 60000) return false;
    return typeof value.authorized === 'boolean'
      && value.code === (value.authorized ? 'TQT_LICENSE_AUTHORIZED' : 'TQT_LICENSE_NOT_FOUND');
  }

  function publish(status) {
    statusCache = status;
    const signature = JSON.stringify([status.authorized, status.machineKey, status.code, status.message, status.checkedAt]);
    if (signature !== lastPublished) {
      lastPublished = signature;
      window.dispatchEvent(new CustomEvent('tqt:license-status', { detail: { ...status } }));
    }
    return { ...status };
  }

  function failure(error) {
    const disconnected = !window.fbBridgeApi.bridgeAvailable() || error?.code === 'BRIDGE_DISCONNECTED';
    return {
      authorized: false, machineKey, checkedAt: Date.now(),
      code: disconnected ? 'BRIDGE_DISCONNECTED' : 'TQT_LICENSE_SOURCE_UNAVAILABLE',
      message: disconnected ? 'Chưa kết nối extension. Cài extension rồi mở tranquytruong.top.'
        : `Không kiểm tra được danh sách KEY: ${error?.message || error}`
    };
  }

  async function getMachineKey(epoch) {
    if (!machineKey) {
      const response = await window.fbBridgeApi.sendRawBridge('GET_MACHINE_KEY');
      if (epoch !== connectionEpoch || !window.fbBridgeApi.bridgeAvailable()) {
        const error = new Error('Kết nối extension đã thay đổi.');
        error.code = 'BRIDGE_DISCONNECTED';
        throw error;
      }
      const value = String(window.fbBridgeApi.bridgeResponseData(response).machineKey || '').trim().toUpperCase();
      if (!/^TQT-[A-F0-9]{27}$/.test(value)) throw new Error('Extension trả về KEY thiết bị không hợp lệ.');
      machineKey = value;
    }
    return machineKey;
  }

  async function fetchAllowedKeys(url, controller) {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('v', String(Date.now()));
    const response = await fetch(requestUrl.href, {
      cache: 'no-store', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length') || 0) > MAX_LIST_BYTES) throw new Error('Danh sách KEY vượt quá 2 MB.');
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_LIST_BYTES) throw new Error('Danh sách KEY vượt quá 2 MB.');
    const payload = JSON.parse(raw);
    const items = Array.isArray(payload) ? payload : payload?.allowedKeys;
    if (!Array.isArray(items)) throw new Error('File KEY phải là mảng hoặc có trường allowedKeys.');
    return new Set(items
      .filter(item => typeof item === 'string' || (item && item.active !== false))
      .map(item => String(typeof item === 'string' ? item : item.key || '').trim().toUpperCase())
      .filter(key => /^TQT-[A-F0-9]{27}$/.test(key)));
  }

  function verify({ forceRefresh = false } = {}) {
    if (checkPromise) return checkPromise;
    const epoch = connectionEpoch;
    checkPromise = (async () => {
      try {
        const key = await getMachineKey(epoch);
        if (epoch !== connectionEpoch || !window.fbBridgeApi.bridgeAvailable()) {
          const error = new Error('Kết nối extension đã thay đổi.');
          error.code = 'BRIDGE_DISCONNECTED';
          throw error;
        }
        const url = sourceUrl();
        const now = Date.now();
        if (!forceRefresh) {
          if (statusCache?.code === 'TQT_LICENSE_SOURCE_UNAVAILABLE'
            && statusCache.machineKey === key && now - statusCache.checkedAt < FAILURE_TTL_MS) return { ...statusCache };
          const daily = [statusCache, readSavedStatus()].find(value => validDailyStatus(value, key, url, calendarDay(now)));
          if (daily) return publish(daily);
        }
        activeController = new AbortController();
        const controller = activeController;
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let allowed;
        try { allowed = await fetchAllowedKeys(url, controller); }
        finally { clearTimeout(timer); if (activeController === controller) activeController = null; }
        if (epoch !== connectionEpoch || !window.fbBridgeApi.bridgeAvailable()) {
          const error = new Error('Kết nối extension đã thay đổi.');
          error.code = 'BRIDGE_DISCONNECTED';
          throw error;
        }
        const authorized = allowed.has(key);
        const checkedAt = Date.now();
        const status = {
          authorized, machineKey: key, checkedAt, checkedDay: calendarDay(checkedAt), sourceUrl: url,
          code: authorized ? 'TQT_LICENSE_AUTHORIZED' : 'TQT_LICENSE_NOT_FOUND',
          message: authorized ? 'KEY đã được ADMIN cấp quyền.' : 'KEY chưa được ADMIN cấp quyền. Thêm KEY rồi bấm Kiểm tra lại.'
        };
        saveStatus(status);
        return publish(status);
      } catch (error) {
        const status = failure(error);
        saveStatus(status);
        return publish(status);
      }
    })().finally(() => { checkPromise = null; });
    return checkPromise;
  }

  async function requireAuthorized() {
    const status = await verify();
    if (status.authorized) return status;
    const error = new Error(status.message);
    error.code = status.code;
    throw error;
  }

  window.TqtWebLicense = Object.freeze({ verify, requireAuthorized });
  window.addEventListener('autovip:bridge-status', event => {
    if (event.detail?.connected) return;
    connectionEpoch += 1;
    machineKey = '';
    statusCache = null;
    lastPublished = '';
    activeController?.abort();
  });
})();
