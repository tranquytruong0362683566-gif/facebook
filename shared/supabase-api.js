(function () {
  'use strict';

  function apiError(message, code = 'API_ERROR', status = 0) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  function validateConfig(config) {
    if (!config?.supabaseUrl || !config?.supabasePublishableKey) {
      throw apiError('Chưa cấu hình Supabase. Xem file HUONG-DAN-ADMIN.md trong bộ mã nguồn.', 'TQT_SETUP_REQUIRED');
    }
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw apiError('Supabase URL phải có dạng https://ma-project.supabase.co.', 'TQT_SETUP_REQUIRED');
    }
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.supabasePublishableKey)) {
      throw apiError('Dùng Publishable key của Supabase trong cấu hình web.', 'TQT_SETUP_REQUIRED');
    }
    return { url: url.origin, key: config.supabasePublishableKey };
  }

  function createClient(config, storage = null) {
    const settings = validateConfig(config);
    const sessionKey = `tqt-admin-session-v1:${settings.url}`;
    let session = null;
    let refreshPromise = null;
    let generation = 0;
    try { session = JSON.parse(storage?.getItem(sessionKey) || 'null'); } catch {}

    function clearSession() {
      generation += 1;
      session = null;
      try { storage?.removeItem(sessionKey); } catch {}
    }

    function saveSession(data) {
      if (!data?.access_token || !data?.refresh_token || !data.user?.id) {
        throw apiError('Dịch vụ đăng nhập trả về phiên không hợp lệ.', 'INVALID_SESSION');
      }
      session = { access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: Date.now() + Math.max(1, Number(data.expires_in) || 3600) * 1000,
        user: { id: data.user.id, email: String(data.user.email || '') } };
      try { storage?.setItem(sessionKey, JSON.stringify(session)); } catch {}
      return session.user;
    }

    async function request(route, body, { token = '', signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) throw new DOMException('Yêu cầu đã hủy.', 'AbortError');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const headers = { apikey: settings.key, 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${settings.url}${route}`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
          credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'
        });
        const raw = await response.text();
        if (new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024) throw apiError('Phản hồi vượt quá giới hạn 2 MB.');
        let data;
        try { data = raw ? JSON.parse(raw) : null; } catch { throw apiError('Dịch vụ trả về dữ liệu không hợp lệ.'); }
        if (!response.ok) {
          const code = data?.code || data?.error_code || 'API_ERROR';
          let message = data?.message || data?.msg || data?.error_description || 'Yêu cầu không thành công.';
          if (response.status === 401) message = 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.';
          if (code === '42501' || response.status === 403) message = 'Tài khoản này không có quyền quản trị.';
          if (code === 'P0001' && String(message).includes('TQT_REVISION_CONFLICT')) message = 'KEY đã được sửa ở phiên khác. Tải lại danh sách rồi mở lại KEY.';
          throw apiError(message, code, response.status);
        }
        return data;
      } catch (error) {
        if (error.name === 'AbortError' && !signal?.aborted) throw apiError('Hết thời gian chờ. Tải lại danh sách để kiểm tra kết quả trước khi thử lại.', 'API_TIMEOUT');
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }

    async function refreshSession() {
      if (!session?.refresh_token) throw apiError('Vui lòng đăng nhập ADMIN.', 'AUTH_REQUIRED', 401);
      if (refreshPromise) return refreshPromise;
      const epoch = generation;
      const token = session.refresh_token;
      refreshPromise = (async () => {
        try {
          const data = await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: token });
          if (epoch !== generation) throw apiError('Phiên đăng nhập đã đóng.', 'AUTH_REQUIRED', 401);
          saveSession(data);
        } catch (error) {
          if (epoch === generation && (error.status === 400 || error.status === 401 || error.status === 403)) clearSession();
          throw error;
        }
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
    }

    async function signIn(email, password) {
      clearSession();
      const epoch = generation;
      const data = await request('/auth/v1/token?grant_type=password', { email: String(email).trim(), password });
      if (epoch !== generation) throw apiError('Yêu cầu đăng nhập đã đóng.', 'AUTH_REQUIRED');
      return saveSession(data);
    }

    async function signOut() {
      const token = session?.access_token;
      clearSession();
      if (token) await request('/auth/v1/logout?scope=local', {}, { token });
    }

    async function rpc(name, params = {}, { admin = false, signal } = {}) {
      if (!/^[a-z][a-z0-9_]+$/.test(name)) throw new Error('Tên API không hợp lệ.');
      if (!admin) return request(`/rest/v1/rpc/${name}`, params, { signal });
      if (!session?.access_token) throw apiError('Vui lòng đăng nhập ADMIN.', 'AUTH_REQUIRED', 401);
      if (!Number.isFinite(session.expires_at) || session.expires_at < Date.now() + 60000) await refreshSession();
      const epoch = generation;
      try { return await request(`/rest/v1/rpc/${name}`, params, { token: session.access_token, signal }); }
      catch (error) {
        // A 401 is rejected before RPC execution. Only this failure may be retried.
        if (error.status !== 401 || epoch !== generation) throw error;
        await refreshSession();
        return request(`/rest/v1/rpc/${name}`, params, { token: session.access_token, signal });
      }
    }

    return Object.freeze({ signIn, signOut, rpc, clearSession, user: () => session?.user || null });
  }

  window.TqtSupabaseApi = Object.freeze({ createClient, validateConfig });
})();
