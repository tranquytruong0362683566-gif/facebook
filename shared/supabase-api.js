(function () {
  'use strict';

  function createClient(config, storage = window.sessionStorage) {
    const base = new URL(config?.supabaseUrl || '');
    const apiKey = String(config?.supabasePublishableKey || '');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || base.pathname !== '/' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(apiKey)) {
      throw new Error('Kiểm tra supabaseUrl và publishable key trong config/license-config.js.');
    }
    const storageKey = `tqtAdminSessionV1:${base.hostname}`;
    let session = null;
    let sessionEpoch = 0;
    let refreshPromise = null;
    function clearSession() {
      sessionEpoch += 1;
      session = null;
      storage.removeItem(storageKey);
    }
    function saveSession(data, epoch) {
      if (epoch !== sessionEpoch) throw new Error('Phiên đăng nhập đã thay đổi. Vui lòng đăng nhập lại.');
      if (typeof data?.access_token !== 'string' || !data.access_token
        || typeof data?.refresh_token !== 'string' || !data.refresh_token
        || typeof data?.user?.id !== 'string') throw new Error('Dịch vụ trả về phiên đăng nhập không hợp lệ.');
      const expiresAt = Number(data.expires_at || Math.floor(Date.now() / 1000) + Number(data.expires_in));
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('Thời hạn đăng nhập không hợp lệ.');
      const next = { access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: expiresAt, user: data.user };
      storage.setItem(storageKey, JSON.stringify(next));
      session = next;
    }
    try {
      const saved = JSON.parse(storage.getItem(storageKey) || 'null');
      if (saved) saveSession(saved, sessionEpoch);
    } catch { clearSession(); }

    async function request(path, params, { token = '', signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 12000);
      try {
        const headers = { apikey: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base.origin}${path}`, {
          method: 'POST', headers, body: JSON.stringify(params), signal: controller.signal,
          credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; }
        catch { throw new Error('Dịch vụ quản lý trả về nội dung không hợp lệ.'); }
        if (!response.ok) {
          const code = data?.code || data?.error_code || '';
          const raw = data?.message || data?.msg || data?.error_description || `HTTP ${response.status}`;
          const message = raw === 'TQT_REVISION_CONFLICT'
            ? 'KEY đã được cập nhật ở phiên khác. Đóng cửa sổ này, tải lại danh sách và thử lại.'
            : code === 'invalid_credentials' ? 'Email hoặc mật khẩu không đúng.' : raw;
          const error = new Error(message);
          error.code = code;
          error.status = response.status;
          throw error;
        }
        return data;
      } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) {
          throw new Error('Kết nối quá thời gian. Kiểm tra mạng và thử lại.');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }

    async function accessToken(forceRefresh = false) {
      if (!session) {
        const error = new Error('Vui lòng đăng nhập ADMIN.'); error.status = 401; throw error;
      }
      if (!forceRefresh && session.expires_at * 1000 > Date.now() + 30000) return session.access_token;
      if (!refreshPromise) {
        const epoch = sessionEpoch;
        const token = session.refresh_token;
        const operation = (async () => {
          try {
            const data = await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: token });
            saveSession(data, epoch);
            return session.access_token;
          } catch (error) {
            if (epoch === sessionEpoch && (error.status === 400 || error.status === 401 || error.status === 403)) clearSession();
            throw error;
          }
        })();
        refreshPromise = operation;
        operation.finally(() => { if (refreshPromise === operation) refreshPromise = null; }).catch(() => {});
      }
      return refreshPromise;
    }

    async function rpc(name, params = {}, options = {}) {
      if (!/^tqt_[a-z_]+$/.test(name)) throw new Error('Tên lệnh quản lý không hợp lệ.');
      const token = options.admin ? await accessToken() : '';
      try { return await request(`/rest/v1/rpc/${name}`, params, { token, signal: options.signal }); }
      catch (error) {
        if (!options.admin || error.status !== 401 || options.signal?.aborted) throw error;
        // HTTP 401 rejects the original operation before it reaches PostgreSQL.
        const refreshed = await accessToken(true);
        return request(`/rest/v1/rpc/${name}`, params, { token: refreshed, signal: options.signal });
      }
    }

    async function signIn(email, password) {
      clearSession();
      const epoch = sessionEpoch;
      const data = await request('/auth/v1/token?grant_type=password', { email: email.trim(), password });
      saveSession(data, epoch);
      return session.user;
    }
    async function signOut() {
      const token = session?.access_token;
      clearSession();
      if (token) await request('/auth/v1/logout', {}, { token });
    }
    return Object.freeze({ rpc, signIn, signOut, clearSession,
      user: () => session?.user ? { ...session.user } : null });
  }

  window.TqtSupabaseApi = Object.freeze({ createClient });
}());
