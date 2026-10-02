(function () {
  'use strict';
  const CACHE_MS = 15000;
  const codes = {
    approved: 'TQT_LICENSE_AUTHORIZED', pending: 'TQT_LICENSE_PENDING',
    blocked: 'TQT_LICENSE_BLOCKED', expired: 'TQT_LICENSE_EXPIRED',
    registration_conflict: 'TQT_LICENSE_REGISTRATION_CONFLICT'
  };
  let identity = null;
  let cache = null;
  let checkPromise = null;
  let controller = null;
  let epoch = 0;
  let lastPublished = '';
  let api = null;

  function publish(data) {
    cache = data;
    const signature = JSON.stringify([data.machineKey, data.authorized, data.code, data.message, data.expiresAt]);
    if (lastPublished !== signature) {
      lastPublished = signature;
      window.dispatchEvent(new CustomEvent('tqt:license-status', { detail: { ...data } }));
    }
    return { ...data };
  }
  function disconnectedError() {
    const error = new Error('Kết nối extension đã thay đổi.');
    error.code = 'BRIDGE_DISCONNECTED';
    return error;
  }
  async function getIdentity(checkEpoch) {
    if (!identity) {
      const response = await window.fbBridgeApi.sendRawBridge('GET_DEVICE_REGISTRATION');
      if (checkEpoch !== epoch || !window.fbBridgeApi.bridgeAvailable()) throw disconnectedError();
      const value = window.fbBridgeApi.bridgeResponseData(response);
      if (!/^TQT-[A-F0-9]{27}$/.test(value?.machineKey || '') || !/^[A-F0-9]{64}$/.test(value?.deviceToken || '')) {
        throw new Error('Cập nhật extension 4.2.0 để đăng ký KEY.');
      }
      identity = { machineKey: value.machineKey, deviceToken: value.deviceToken };
    }
    return identity;
  }
  function verify({ forceRefresh = false } = {}) {
    if (checkPromise) return checkPromise;
    const checkEpoch = epoch;
    checkPromise = (async () => {
      try {
        const device = await getIdentity(checkEpoch);
        if (checkEpoch !== epoch || !window.fbBridgeApi.bridgeAvailable()) throw disconnectedError();
        const now = Date.now();
        if (!forceRefresh && cache?.machineKey === device.machineKey && cache.validUntil > now) return { ...cache };
        if (!api) api = window.TqtSupabaseApi.createClient(window.TqtLicenseConfig);
        controller = new AbortController();
        const current = controller;
        let result;
        try { result = await api.rpc('tqt_register_device', { p_machine_key: device.machineKey,
          p_device_token: device.deviceToken }, { signal: current.signal }); }
        finally { if (controller === current) controller = null; }
        if (checkEpoch !== epoch || !window.fbBridgeApi.bridgeAvailable()) throw disconnectedError();
        if (result?.machineKey !== device.machineKey || !Object.hasOwn(codes, result.status)
          || typeof result.authorized !== 'boolean' || result.authorized !== (result.status === 'approved')) {
          throw new Error('Dịch vụ cấp quyền trả về trạng thái không hợp lệ.');
        }
        const expiresAt = result.expiresAt || null;
        const expiry = expiresAt ? Date.parse(expiresAt) : Infinity;
        if (expiresAt && !Number.isFinite(expiry)) throw new Error('Hạn KEY từ dịch vụ không hợp lệ.');
        const expired = result.authorized && expiry <= Date.now();
        const data = { machineKey: device.machineKey, authorized: result.authorized && !expired,
          code: expired ? codes.expired : codes[result.status], expiresAt,
          checkedAt: Date.now(), validUntil: result.authorized && !expired
            ? Math.min(Date.now() + CACHE_MS, expiry) : Date.now() + CACHE_MS,
          message: expired ? 'KEY đã hết hạn sử dụng. Liên hệ ADMIN để gia hạn.' : result.message };
        return publish(data);
      } catch (error) {
        const connected = window.fbBridgeApi.bridgeAvailable() && checkEpoch === epoch;
        const code = !connected || error.code === 'BRIDGE_DISCONNECTED' ? 'BRIDGE_DISCONNECTED'
          : error.code === 'TQT_SETUP_REQUIRED' ? error.code : 'TQT_LICENSE_SOURCE_UNAVAILABLE';
        return publish({ machineKey: identity?.machineKey || '', authorized: false, code,
          checkedAt: Date.now(), validUntil: Date.now() + (connected ? 5000 : 0),
          message: code === 'BRIDGE_DISCONNECTED' ? 'Chưa kết nối extension. Mở tranquytruong.top cùng extension 4.2.0.'
            : code === 'TQT_SETUP_REQUIRED' ? 'Hệ thống cấp quyền chưa được cấu hình. Liên hệ ADMIN.'
              : `Không kiểm tra được quyền KEY: ${error.message}` });
      }
    })().finally(() => { checkPromise = null; });
    return checkPromise;
  }
  async function requireAuthorized() {
    const status = await verify();
    if (status.authorized) return status;
    const error = new Error(status.message); error.code = status.code; throw error;
  }
  window.TqtWebLicense = Object.freeze({ verify, requireAuthorized });
  window.addEventListener('autovip:bridge-status', event => {
    if (event.detail?.connected) return;
    epoch += 1; identity = null; cache = null; lastPublished = '';
    controller?.abort();
  });
})();
