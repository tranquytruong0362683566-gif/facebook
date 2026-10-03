(function () {
  'use strict';
  const referrer = document.referrer || new URLSearchParams(location.search).get('bridgeOrigin') || '';
  const embedded = window.parent !== window;
  const parentUrl = referrer ? new URL(referrer) : null;
  const parentOrigin = parentUrl ? parentUrl.protocol + '//' + parentUrl.host : '';
  const endpoint = embedded && (parentOrigin === location.origin || parentUrl?.protocol === 'chrome-extension:') ? window.parent : window;
  const targetOrigin = endpoint === window ? location.origin : parentOrigin;
  const CHANNEL = 'tqt-autovip-bridge-v1';
  const PROTOCOL_VERSION = 3;
  const pendingRequests = new Map();
  const readyWaiters = new Set();
  let bridgeConnected = false;
  let stopped = false;
  let extensionVersion = '';
  let bridgeStatusMessage = 'Chưa kết nối extension. Cài hoặc tải lại extension, rồi mở https://tranquytruong.top/.';

  function createRequestId() { return crypto.randomUUID(); }
  function post(kind, detail = {}) {
    endpoint.postMessage({ channel: CHANNEL, direction: 'web-to-extension',
      protocolVersion: PROTOCOL_VERSION, kind, ...detail }, targetOrigin);
  }
  function bridgeError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function getBridgeTimeoutMs(action) {
    if (/SCAN_GROUP|SCAN_LINK|SCAN_FACEBOOK_POSTS/i.test(action)) return 15 * 60 * 1000;
    if (action === 'SUITE_RPC') return 65 * 60 * 1000;
    if (action === 'REQUEST_PROVIDER_API') return 310000;
    if (/SHOPEE|CUSTOM_LINK|AFFILIATE/i.test(action)) return 3 * 60 * 1000;
    if (/COMMENT/i.test(action)) return 4 * 60 * 1000;
    if (/READ/i.test(action)) return 3 * 60 * 1000;
    return 60000;
  }
  function normalizeBridgeResponse(response, allowFailure = false) {
    if (!response || typeof response !== 'object') throw bridgeError('Extension trả về rỗng.', 'INVALID_RESPONSE');
    if (!allowFailure && (response.ok === false || response.success === false || response.error)) {
      throw bridgeError(response.error || response.message || 'Extension báo lỗi.', response.code || 'EXTENSION_ERROR');
    }
    return { ...response, data: response.data ?? response.payload ?? response.result ?? response };
  }
  function rejectAllPending(message) {
    for (const entry of pendingRequests.values()) {
      entry.cleanup();
      entry.reject(bridgeError(message, 'BRIDGE_DISCONNECTED'));
    }
    pendingRequests.clear();
  }
  function setBridgeConnectionState(connected, message = '') {
    const changed = bridgeConnected !== connected || bridgeStatusMessage !== message;
    bridgeConnected = connected;
    bridgeStatusMessage = message || (connected ? 'Đã kết nối extension.' : 'Extension đã ngắt kết nối.');
    if (connected) {
      for (const waiter of [...readyWaiters]) waiter.resolve();
    } else {
      rejectAllPending('Mất kết nối extension. Kiểm tra kết quả tác vụ trước khi chạy lại.');
    }
    if (changed) window.dispatchEvent(new CustomEvent('autovip:bridge-status', {
      detail: { connected: bridgeConnected, message: bridgeStatusMessage, extensionVersion }
    }));
  }
  function onMessage(event) {
    if (stopped || event.source !== endpoint || event.origin !== targetOrigin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'extension-to-web') return;
    if (data.protocolVersion !== PROTOCOL_VERSION) {
      setBridgeConnectionState(false, 'Web và extension khác phiên bản giao thức. Cập nhật cả hai phần.');
      return;
    }
    if (data.kind === 'status') {
      extensionVersion = String(data.extensionVersion || '');
      setBridgeConnectionState(data.connected === true, String(data.message || ''));
      return;
    }
    if (data.kind === 'event') { window.dispatchEvent(new CustomEvent('tqt:suite-event', {detail:data.event})); return; }
    if (data.kind !== 'response') return;
    const requestId = String(data.requestId || '');
    const entry = pendingRequests.get(requestId);
    if (!entry) return;
    pendingRequests.delete(requestId);
    entry.cleanup();
    try { entry.resolve(normalizeBridgeResponse(data.response, entry.allowFailure)); }
    catch (error) { entry.reject(error); }
  }
  function waitForBridgeReady(timeoutMs = 5000) {
    if (stopped) return Promise.reject(bridgeError('Trang điều khiển đã đóng.', 'BRIDGE_DISCONNECTED'));
    if (bridgeConnected) return Promise.resolve();
    post('hello');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiters.delete(waiter);
        reject(bridgeError(bridgeStatusMessage, 'BRIDGE_DISCONNECTED'));
      }, timeoutMs);
      const waiter = {
        resolve: () => { clearTimeout(timer); readyWaiters.delete(waiter); resolve(); },
        reject: () => { clearTimeout(timer); readyWaiters.delete(waiter);
          reject(bridgeError('Trang điều khiển đã đóng.', 'BRIDGE_DISCONNECTED')); }
      };
      readyWaiters.add(waiter);
    });
  }
  async function sendRawBridge(action, payload = {}, options = {}) {
    const name = String(action || '').trim();
    if (!name) throw new Error('Thiếu action gửi tới extension.');
    if (options.signal?.aborted) throw new DOMException('Yêu cầu đã được hủy.', 'AbortError');
    await waitForBridgeReady();
    const safeSuiteStop = name === 'SUITE_RPC' && (
      payload.kind === 'tool' && ['VIDEO_POST_ABORT', 'NATIVE_GROUP_POST_CANCEL', 'PAGE_VIDEO_LOCK_RELEASE', 'FBRS_CANCEL_QUEUE', 'TT_STOP_SCAN', 'TT_PAUSE_DOWNLOAD'].includes(payload.message?.type)
      || payload.kind === 'api' && payload.module === 'groupsApi' && ['abortActiveVideo', 'abortMultiGroup'].includes(payload.method)
    );
    if (!safeSuiteStop && !['PING_BRIDGE', 'PING', 'ping', 'GET_MACHINE_KEY', 'GET_DEVICE_REGISTRATION', 'CANCEL_PROVIDER_API', 'SUITE_CONFIGURE', 'SUITE_CANCEL'].includes(name)) {
      if (!window.TqtWebLicense) throw bridgeError('Web chưa tải được bộ kiểm tra KEY. Tải lại trang.', 'TQT_LICENSE_NOT_READY');
      await window.TqtWebLicense.requireAuthorized();
      if (!bridgeConnected) throw bridgeError('Extension đã ngắt kết nối.', 'BRIDGE_DISCONNECTED');
    }
    if (options.signal?.aborted) throw new DOMException('Yêu cầu đã được hủy.', 'AbortError');
    const requestId = createRequestId();
    const timeoutMs = options.timeoutMs || getBridgeTimeoutMs(name);
    return new Promise((resolve, reject) => {
      let timer;
      const cancelProvider = () => {
        if (name === 'REQUEST_PROVIDER_API' && bridgeConnected && !stopped) {
          post('request', { action: 'CANCEL_PROVIDER_API', requestId: createRequestId(),
            payload: { targetRequestId: requestId } });
        }
      };
      const abort = () => {
        if (!pendingRequests.delete(requestId)) return;
        cleanup();
        cancelProvider();
        reject(new DOMException('Yêu cầu đã được hủy.', 'AbortError'));
      };
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      timer = setTimeout(() => {
        if (!pendingRequests.delete(requestId)) return;
        cleanup();
        cancelProvider();
        reject(bridgeError('Extension xử lý quá lâu. Kiểm tra kết quả trước khi chạy lại.', 'BRIDGE_TIMEOUT'));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, cleanup, allowFailure: options.allowFailure });
      options.signal?.addEventListener('abort', abort, { once: true });
      try { post('request', { action: name, requestId, payload }); }
      catch (error) { pendingRequests.delete(requestId); cleanup(); reject(error); }
    });
  }
  async function sendBridge(actions, payload = {}) {
    const list = Array.isArray(actions) ? actions : [actions];
    let lastError;
    for (const action of list) {
      try { return await sendRawBridge(action, payload); }
      catch (error) {
        lastError = error;
        // Only try an alias when rejection happened before execution.
        if (error.code !== 'UNSUPPORTED_ACTION') throw error;
      }
    }
    throw lastError || new Error('Không có lệnh để gửi tới extension.');
  }
  function bridgeResponseData(response) { return response?.data ?? response?.payload ?? response?.result ?? response ?? {}; }
  function extractLinksFromResponse(response) {
    const data = bridgeResponseData(response);
    const raw = data?.links || data?.postLinks || data?.urls || data?.items || data?.posts || data;
    if (Array.isArray(raw)) return raw.map(item => typeof item === 'string' ? item : item?.url || item?.link || item?.href).filter(Boolean);
    if (typeof raw === 'string') return window.fbBridgeShared.parseLines(raw).filter(line => /^https?:\/\//i.test(line));
    return [];
  }
  function extractArticleFromResponse(response) {
    const data = bridgeResponseData(response);
    return window.fbBridgeShared.text(data?.article || data?.content || data?.text || data?.title || data?.postText || data?.message);
  }
  window.fbBridgeApi = {
    sendBridge, sendRawBridge, bridgeResponseData, extractLinksFromResponse, extractArticleFromResponse,
    bridgeAvailable: () => bridgeConnected,
    getBridgeStatus: () => ({ connected: bridgeConnected, message: bridgeStatusMessage, extensionVersion }),
    reconnect: () => post('hello')
  };
  window.addEventListener('message', onMessage);
  const helloTimer = setInterval(() => { if (!bridgeConnected && !stopped) post('hello'); }, 1500);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopped = true;
    clearInterval(helloTimer);
    rejectAllPending('Trang điều khiển đã đóng.');
    for (const waiter of [...readyWaiters]) waiter.reject();
    window.removeEventListener('message', onMessage);
  });
  window.addEventListener('pageshow', () => post('hello'));
  post('hello');
})();
