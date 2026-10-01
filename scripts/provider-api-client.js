(() => {
  'use strict';
  window.fbProviderApi = Object.freeze({
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      const response = await window.fbBridgeApi.sendRawBridge('REQUEST_PROVIDER_API', {
        url: String(url), method: options.method || 'POST', body: options.body || '',
        authorization: headers.get('Authorization') || '',
        timeoutMs: String(url).startsWith('https://api.apify.com/') ? 295000 : 60000
      }, { signal: options.signal, timeoutMs: 310000 });
      const data = window.fbBridgeApi.bridgeResponseData(response);
      return new Response(data.body || '', {
        status: data.status, statusText: data.statusText || '',
        headers: { 'Content-Type': data.contentType || 'application/json' }
      });
    }
  });
})();
