(function () {
  'use strict';

  const S = window.fbBridgeShared;
  const API = window.fbBridgeApi;
  const APIFY = window.apifyGroupsApi;
  const B = S.B;
  const MANUAL_CONTENT = window.manualCommentContent;
  const AUTO_COMMENT_AFTER_GENERATE = true;
  const AI_NEXT_PAUSE_MS = 1000;
  let fatalStopMessage = '';
  let dailyLimitStopMessage = '';
  let facebookAccountRefreshPromise = null;
  let facebookLogoutPromise = null;
  let facebookCookieRotationPromise = null;
  let autoRestartScheduled = false;
  let facebookAccountStateInitialized = false;
  let currentClosedLoopScanMethod = 'manual';
  let lastRequestedScanMethod = 'manual';
  let activeApifyAbortController = null;
  let lastFacebookLoggedIn = false;
  let lastFacebookUid = '';
  let facebookNameRequestPromise = null;
  let facebookNameRequestUid = '';
  const facebookNamesByUid = new Map();
  const facebookNameLastAttempt = new Map();

  const CLOSED_LOOP_FATAL_CODES = new Set([
    'FACEBOOK_ACCOUNT_AND_COOKIE_MISSING',
    'FACEBOOK_FEATURE_RESTRICTED',
    'OBJECT_OBJECT_ERROR',
    'BRIDGE_DISCONNECTED',
    'BRIDGE_TIMEOUT',
    'TQT_LICENSE_NOT_FOUND',
    'TQT_LICENSE_SOURCE_UNAVAILABLE',
    'TQT_LICENSE_NOT_READY',
    'TQT_LICENSE_PENDING',
    'TQT_LICENSE_BLOCKED',
    'TQT_LICENSE_EXPIRED',
    'TQT_LICENSE_REGISTRATION_CONFLICT',
    'TQT_SETUP_REQUIRED'
  ]);

  const CAPTION_FAILURE_CODES = new Set([
    'CAPTION_MISSING',
    'CAPTION_READ_FAILED'
  ]);

  const BRIDGE_CONNECTIVITY_ERROR_CODES = new Set([
    'BRIDGE_DISCONNECTED',
    'BRIDGE_TIMEOUT'
  ]);

  function classifyApifyError(error) {
    if (typeof APIFY?.classifyError === 'function') return APIFY.classifyError(error);
    return {
      code: S.text(error?.code) || 'APIFY_TEMPORARY_ERROR',
      message: error?.message || 'Apify gặp lỗi tạm thời.'
    };
  }

  function normalizeScanMethod(value) {
    return value === 'apify' ? 'apify' : 'manual';
  }

  function runButtonForMethod(method) {
    return normalizeScanMethod(method) === 'apify' ? B.dashboardApiRunBtn : B.dashboardManualRunBtn;
  }

  function reportProcess(detail = {}) {
    if (typeof S.reportProcess === 'function') S.reportProcess(detail);
  }

  function getAiProviderLabel() {
    return S.text(window.chatGPTApiController?.getProviderLabel?.()) || 'AI API';
  }

  function updatePauseButton() {
    const button = B.scanGroupLinksBtn;
    if (!button) return;
    const paused = S.isClosedLoopRunning() && S.isClosedLoopPaused();
    const icon = button.querySelector('.home-action-icon');
    const label = button.querySelector('.home-action-icon + span');
    button.classList.toggle('is-paused', paused);
    button.setAttribute('aria-pressed', paused ? 'true' : 'false');
    if (icon) icon.textContent = paused ? '▶' : 'Ⅱ';
    if (label) label.textContent = paused ? 'Tiếp Tục Chạy Tự Động' : 'Tạm Dừng Chạy Tự Động';
  }

  async function waitWhileClosedLoopPaused() {
    const pausedAt = Date.now();
    let reported = false;
    while (S.isClosedLoopRunning() && S.isClosedLoopPaused()) {
      if (!reported) {
        reported = true;
        S.setBridgeStatus('Đã tạm dừng Chạy Tự Động. Nhấn Tiếp Tục Chạy Tự Động để hoạt động tiếp.', 'warn');
        reportProcess({
          actionKey: 'closed-loop-paused',
          title: 'Đã tạm dừng Chạy Tự Động',
          detail: 'Tiến trình giữ nguyên hàng đợi và sẽ tiếp tục từ vị trí hiện tại.',
          status: 'wait',
          stage: 'scan',
          source: 'Điều khiển trang chủ',
          target: '',
          targetLabel: 'TRẠNG THÁI HỆ THỐNG',
          countdown: null,
          historyMessage: 'Người dùng tạm dừng Chạy Tự Động',
          historyTag: 'PAUSE',
          historyLevel: 'warn'
        });
      }
      await S.delay(250);
    }
    if (reported && S.isClosedLoopRunning()) {
      S.setBridgeStatus('Đã tiếp tục Chạy Tự Động.', 'ok');
      reportProcess({
        actionKey: 'closed-loop-resumed',
        title: 'Tiếp tục Chạy Tự Động',
        detail: 'Tiến trình tiếp tục từ vị trí đã tạm dừng.',
        status: 'running',
        stage: 'scan',
        source: 'Điều khiển trang chủ',
        target: '',
        targetLabel: 'TRẠNG THÁI HỆ THỐNG',
        countdown: null,
        historyMessage: 'Người dùng tiếp tục Chạy Tự Động',
        historyTag: 'RUNNING',
        historyLevel: 'running'
      });
    }
    return reported ? Math.max(0, Date.now() - pausedAt) : 0;
  }

  function queueProcessMeta(index = 0, total = 0) {
    const current = Math.max(0, Number(index) || 0);
    const size = Math.max(0, Number(total) || 0);
    return {
      index: current,
      total: size,
      remaining: size ? Math.max(0, size - current) : 0
    };
  }

  function isObjectObjectError(error) {
    const pattern = /\[object Object\]/i;
    if (typeof error === 'string') return pattern.test(error);
    if (!error || typeof error !== 'object') return false;
    if (typeof error.message === 'string' && pattern.test(error.message)) return true;
    if (error.message && typeof error.message === 'object' && pattern.test(String(error.message))) return true;
    if (!(error instanceof Error) && !error.message && pattern.test(String(error))) return true;
    return false;
  }

  function closedLoopFatalMessage(error) {
    if (S.text(error?.code) === 'OBJECT_OBJECT_ERROR') {
      return S.text(error?.message) || 'Lỗi gửi bình luận Facebook: [object Object]. Đã dừng chạy tự động.';
    }
    return S.text(error?.message) || S.text(error) || 'Tiến trình tự động đã dừng.';
  }

  function isFatalClosedLoopError(error) {
    if (error?.stopClosedLoop === true) return true;
    return CLOSED_LOOP_FATAL_CODES.has(S.text(error?.code));
  }

  function markClosedLoopFatal(error) {
    const fatalError = error instanceof Error ? error : new Error(closedLoopFatalMessage(error));
    fatalError.stopClosedLoop = true;
    return fatalError;
  }

  function stopForDailyCommentLimitIfReached() {
    const state = S.renderDailyCommentLimitStatus();
    if (!state?.reached) return false;

    const message = `Đã đạt giới hạn ${state.limit} bình luận thành công trong ngày (${state.success}/${state.limit}). Tiến trình tự động đã dừng.`;
    const shouldReport = dailyLimitStopMessage !== message;
    dailyLimitStopMessage = message;
    S.setClosedLoopRunning(false);
    updatePauseButton();
    B.stopClosedLoopBtn?.classList.add('hidden');
    S.setBridgeStatus(message, 'ok');
    if (shouldReport) {
      reportProcess({
        actionKey: 'daily-comment-limit-reached',
        title: 'Đã đạt giới hạn bình luận trong ngày',
        detail: `${message} Bộ đếm sẽ tự đặt lại khi sang ngày mới.`,
        status: 'stop',
        stage: 'comment',
        source: 'Giới hạn bình luận theo ngày',
        target: '',
        targetLabel: 'GIỚI HẠN TRONG NGÀY',
        countdown: null,
        historyMessage: `Đã đạt giới hạn ngày ${state.success}/${state.limit} bình luận thành công`,
        historyTag: 'STOP',
        historyLevel: 'ok'
      });
    }
    return true;
  }

  function isBridgeConnectivityError(error) {
    const code = S.text(error?.code);
    if (BRIDGE_CONNECTIVITY_ERROR_CODES.has(code)) return true;
    return /chưa phát hiện extension|kết nối extension.*(?:ngắt|lỗi)|message port|receiving end|port closed/i
      .test(String(error?.message || error || ''));
  }

  function isCaptionFailureError(error) {
    return CAPTION_FAILURE_CODES.has(S.text(error?.code));
  }

  function captionFailureReason(error) {
    return S.text(error?.code) === 'CAPTION_MISSING'
      ? 'Không có caption'
      : 'Không đọc được caption';
  }

  function updateKnownFacebookAccount(loggedIn, uid) {
    const previousLoggedIn = lastFacebookLoggedIn;
    const wasInitialized = facebookAccountStateInitialized;
    const cleanUid = S.text(uid);
    lastFacebookLoggedIn = Boolean(loggedIn && cleanUid);
    lastFacebookUid = lastFacebookLoggedIn ? cleanUid : '';
    facebookAccountStateInitialized = true;
    return wasInitialized && previousLoggedIn && !lastFacebookLoggedIn;
  }

  function cleanFacebookName(value) {
    const name = S.text(value).replace(/\s+/g, ' ');
    if (!name || /^\d+$/.test(name) || name.length > 120) return '';
    return name;
  }

  function extractFacebookName(data) {
    if (!data || typeof data !== 'object') return '';
    return cleanFacebookName(
      data.name
      || data.displayName
      || data.facebookName
      || data.profileName
      || data.account?.name
      || data.profile?.name
    );
  }

  function setFacebookHello(loggedIn, uid, name = '', status = '') {
    if (!B.facebookNameDisplay) return;
    const cleanUid = S.text(uid);
    const cleanName = cleanFacebookName(name) || facebookNamesByUid.get(cleanUid) || '';

    if (!loggedIn || !cleanUid) {
      B.facebookNameDisplay.textContent = 'Chưa đăng nhập Facebook';
      return;
    }

    if (cleanName) {
      B.facebookNameDisplay.textContent = cleanName;
      return;
    }

    B.facebookNameDisplay.textContent = status || 'Đang nhận diện tên Facebook...';
  }

  function requestFacebookAccountName(uid, { forceRefresh = false } = {}) {
    const cleanUid = S.text(uid);
    if (!cleanUid) return Promise.resolve('');

    const cachedName = facebookNamesByUid.get(cleanUid) || '';
    if (cachedName && !forceRefresh) {
      setFacebookHello(true, cleanUid, cachedName);
      return Promise.resolve(cachedName);
    }

    if (facebookNameRequestPromise && facebookNameRequestUid === cleanUid) {
      return facebookNameRequestPromise;
    }

    const lastAttempt = facebookNameLastAttempt.get(cleanUid) || 0;
    if (!forceRefresh && Date.now() - lastAttempt < 60000) return Promise.resolve('');

    facebookNameLastAttempt.set(cleanUid, Date.now());
    facebookNameRequestUid = cleanUid;
    setFacebookHello(true, cleanUid, '', 'Đang nhận diện tên Facebook...');

    facebookNameRequestPromise = (async () => {
      try {
        const response = await API.sendBridge(
          ['GET_FACEBOOK_ACCOUNT_NAME', 'GET_FB_ACCOUNT_NAME', 'FACEBOOK_ACCOUNT_NAME'],
          { uid: cleanUid, forceRefresh }
        );
        const data = API.bridgeResponseData(response);
        const responseUid = S.text(data.uid || cleanUid);
        const name = extractFacebookName(data);

        if (name && responseUid === cleanUid) {
          facebookNamesByUid.set(cleanUid, name);
          if (lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
            setFacebookHello(true, cleanUid, name);
          }
          return name;
        }

        if (lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
          setFacebookHello(true, cleanUid, '', 'Chưa nhận diện được tên Facebook');
        }
        return '';
      } catch {
        if (lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
          setFacebookHello(true, cleanUid, '', 'Chưa nhận diện được tên Facebook');
        }
        return '';
      } finally {
        if (facebookNameRequestUid === cleanUid) {
          facebookNameRequestPromise = null;
          facebookNameRequestUid = '';
        }
      }
    })();

    return facebookNameRequestPromise;
  }

  function getFacebookCookieLines() {
    const storedValue = B.facebookCookiesInput
      ? B.facebookCookiesInput.value
      : S.load(S.STORE.facebookCookies, '');
    return String(storedValue || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  function takeNextFacebookCookie() {
    const lines = getFacebookCookieLines();
    const cookie = lines.shift() || '';
    const remainingValue = lines.join('\n');
    if (B.facebookCookiesInput) B.facebookCookiesInput.value = remainingValue;
    S.save(S.STORE.facebookCookies, remainingValue);
    return cookie;
  }

  async function waitForFacebookUid({ timeoutMs = 45000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await API.sendBridge(
        ['GET_FACEBOOK_ACCOUNT', 'GET_FB_UID', 'FACEBOOK_ACCOUNT_STATUS'],
        {}
      );
      const data = API.bridgeResponseData(response);
      const uid = S.text(data.uid || data.facebookUid || data.cUser);
      const loggedIn = data.loggedIn === true || Boolean(uid);
      const name = extractFacebookName(data);
      renderFacebookAccount({ loggedIn, uid, name });
      updateKnownFacebookAccount(loggedIn, uid);
      if (loggedIn && uid) {
        if (!name) requestFacebookAccountName(uid).catch(() => {});
        return { ...data, uid, loggedIn, name };
      }
      await S.delay(intervalMs);
    }
    throw new Error('Quá thời gian chờ Extension cập nhật UID sau khi Login Cookie.');
  }

  function scheduleAutoRun(uid) {
    if (autoRestartScheduled) return;
    autoRestartScheduled = true;

    (async () => {
      try {
        const startButton = runButtonForMethod(lastRequestedScanMethod);
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          if (!S.isBridgeBusy() && !S.isClosedLoopRunning() && !startButton?.disabled) break;
          await S.delay(500);
        }

        if (S.isBridgeBusy() || S.isClosedLoopRunning() || !startButton || startButton.disabled) {
          throw new Error('Không thể tự chạy lại vì tác vụ cũ chưa kết thúc.');
        }

        const account = await refreshFacebookAccount({ silent: true });
        if (!account?.loggedIn || !account?.uid) {
          throw new Error('UID mới không còn đăng nhập trước lúc chạy lại.');
        }

        S.setBridgeStatus(`Đã có UID ${uid || account.uid}. Đang tiếp tục Chạy Tự Động...`, 'ok');
        reportProcess({
          actionKey: 'automatic-restart',
          title: 'Tiếp tục chạy tự động bằng UID mới',
          detail: `UID ${uid || account.uid} đã sẵn sàng.`,
          status: 'running',
          stage: 'scan',
          source: 'Facebook Cookie',
          countdown: null,
          historyMessage: `UID ${uid || account.uid} sẵn sàng, tiếp tục chạy tự động`,
          historyTag: 'OK',
          historyLevel: 'ok'
        });
        startButton.click();
      } catch (error) {
        S.setBridgeStatus(`Không thể tự chạy lại: ${error.message || error}`, 'error');
      } finally {
        autoRestartScheduled = false;
      }
    })();
  }

  async function rotateFacebookCookieAfterLogout({ source = 'account-status', autoRestart = true } = {}) {
    if (facebookCookieRotationPromise) return facebookCookieRotationPromise;

    facebookCookieRotationPromise = (async () => {
      const cookie = takeNextFacebookCookie();
      if (!cookie) {
        S.setBridgeStatus('UID đã đăng xuất nhưng ô Cookie Facebook không còn dòng cookie nào để đăng nhập tiếp.', 'error');
        return null;
      }

      S.setBridgeStatus('UID đã đăng xuất. Đã lấy và xóa 1 dòng Cookie Facebook; đang gửi vào Login Cookie New của Extension...', 'warn');

      const response = await API.sendBridge(
        ['LOGIN_FACEBOOK_COOKIE', 'IMPORT_FACEBOOK_COOKIE', 'FB_LOGIN_COOKIE'],
        { cookie, cookieText: cookie, source }
      );
      const data = API.bridgeResponseData(response);
      const immediateUid = S.text(data.uid || data.facebookUid || data.cUser);
      const account = immediateUid
        ? { ...data, uid: immediateUid, loggedIn: true }
        : await waitForFacebookUid();

      const name = extractFacebookName(account);
      renderFacebookAccount({ loggedIn: true, uid: account.uid, name });
      updateKnownFacebookAccount(true, account.uid);
      if (!name) requestFacebookAccountName(account.uid).catch(() => {});
      const restartModeLabel = lastRequestedScanMethod === 'apify' ? 'bằng API' : 'thủ công';
      S.setBridgeStatus(
        autoRestart
          ? `Login Cookie thành công. Đã phát hiện UID ${account.uid}; đang chuẩn bị chạy ${restartModeLabel}...`
          : `Login Cookie thành công. Đã phát hiện UID ${account.uid}; tiếp tục vòng chạy hiện tại...`,
        'ok'
      );
      if (autoRestart) scheduleAutoRun(account.uid);
      return account;
    })().catch(error => {
      S.setBridgeStatus(`Đăng nhập cookie tự động thất bại: ${error.message || error}`, 'error');
      throw error;
    }).finally(() => {
      facebookCookieRotationPromise = null;
    });

    return facebookCookieRotationPromise;
  }

  function renderFacebookAccount({ loggedIn = false, uid = '', name = '', message = '', error = false } = {}) {
    const cleanUid = S.text(uid);
    setFacebookHello(loggedIn, cleanUid, name);
    if (B.facebookUidDisplay) {
      B.facebookUidDisplay.textContent = loggedIn && cleanUid
        ? cleanUid
        : (message || 'Chưa đăng nhập');
      B.facebookUidDisplay.title = loggedIn && cleanUid
        ? `UID Facebook đang đăng nhập: ${cleanUid}`
        : (message || 'Chưa phát hiện tài khoản Facebook đang đăng nhập.');
    }
    B.facebookAccountBar?.classList.toggle('logged-in', Boolean(loggedIn && cleanUid));
    B.facebookAccountBar?.classList.toggle('account-error', Boolean(error));
    if (B.facebookLogoutBtn) {
      B.facebookLogoutBtn.disabled = !loggedIn || !cleanUid || Boolean(facebookLogoutPromise);
    }
  }

  async function refreshFacebookAccount({ silent = false } = {}) {
    if (facebookAccountRefreshPromise) return facebookAccountRefreshPromise;

    facebookAccountRefreshPromise = (async () => {
      try {
        if (!silent) renderFacebookAccount({ message: 'Đang lấy UID từ Extension...' });
        const response = await API.sendBridge(
          ['GET_FACEBOOK_ACCOUNT', 'GET_FB_UID', 'FACEBOOK_ACCOUNT_STATUS'],
          {}
        );
        const data = API.bridgeResponseData(response);
        const uid = S.text(data.uid || data.facebookUid || data.cUser);
        const loggedIn = data.loggedIn === true || Boolean(uid);
        const name = extractFacebookName(data);
        renderFacebookAccount({ loggedIn, uid, name });
        const transitionedToLoggedOut = updateKnownFacebookAccount(loggedIn, uid);
        if (loggedIn && uid && !name) requestFacebookAccountName(uid).catch(() => {});
        if (
          transitionedToLoggedOut
          && !facebookLogoutPromise
          && !facebookCookieRotationPromise
          && !S.isClosedLoopRunning()
          && !S.isBridgeBusy()
        ) {
          rotateFacebookCookieAfterLogout({ source: 'extension-status-change' }).catch(() => {});
        }
        return { ...data, uid, loggedIn, name };
      } catch (error) {
        renderFacebookAccount({
          message: `Không lấy được UID từ Extension tự liên kết: ${error.message || error}`,
          error: true
        });
        if (!silent) S.setBridgeStatus(error.message || String(error), 'error');
        return null;
      } finally {
        facebookAccountRefreshPromise = null;
      }
    })();

    return facebookAccountRefreshPromise;
  }

  async function logoutFacebookAccount({ automatic = false, reason = '' } = {}) {
    if (facebookLogoutPromise) return facebookLogoutPromise;

    facebookLogoutPromise = (async () => {
      const oldText = B.facebookLogoutBtn?.textContent || 'Đăng xuất';
      if (B.facebookLogoutBtn) {
        B.facebookLogoutBtn.disabled = true;
        B.facebookLogoutBtn.textContent = automatic ? 'Đang tự đăng xuất...' : 'Đang đăng xuất...';
      }

      if (automatic) {
        S.setBridgeStatus(`${reason || 'Phát hiện lỗi giới hạn Facebook.'}
Đang tự động gọi nút Đăng xuất trên Extension...`, 'error');
      }

      try {
        const response = await API.sendBridge(
          ['LOGOUT_FACEBOOK', 'FB_LOGOUT', 'LOGOUT_FB_ACCOUNT'],
          { automatic, reason }
        );
        const data = API.bridgeResponseData(response);
        const previousUid = S.text(data.previousUid || data.uidBeforeLogout);
        const removedCookies = Number(data.removedCookies ?? data.removed ?? 0);

        renderFacebookAccount({
          loggedIn: false,
          uid: '',
          message: previousUid
            ? `Đã đăng xuất UID: ${previousUid}`
            : 'Đã đăng xuất tài khoản Facebook.'
        });
        updateKnownFacebookAccount(false, '');

        if (!automatic) {
          S.setBridgeStatus(`Đã đăng xuất Facebook và xóa ${removedCookies} cookie.`, 'ok');
        }

        try {
          await rotateFacebookCookieAfterLogout({
            source: automatic ? 'automatic-facebook-restriction' : 'web-logout-button'
          });
        } catch (_) {}
        return { ...data, previousUid, removedCookies };
      } catch (error) {
        await refreshFacebookAccount({ silent: true });
        if (!automatic) S.setBridgeStatus(`Đăng xuất Facebook thất bại: ${error.message || error}`, 'error');
        throw error;
      } finally {
        if (B.facebookLogoutBtn) B.facebookLogoutBtn.textContent = oldText;
        facebookLogoutPromise = null;
        if (B.facebookLogoutBtn) {
          B.facebookLogoutBtn.disabled = !B.facebookAccountBar?.classList.contains('logged-in');
        }
      }
    })();

    return facebookLogoutPromise;
  }

  async function ensureFacebookAccountBeforeCycle(cycleIndex = 1) {
    S.setBridgeStatus(`Vòng ${cycleIndex}: đang kiểm tra UID Facebook trước khi quét nhóm...`, 'warn');
    reportProcess({
      actionKey: `cycle-${cycleIndex}-account-check`,
      title: 'Kiểm tra tài khoản Facebook',
      detail: `Đang xác thực UID trước khi bắt đầu vòng ${cycleIndex}.`,
      status: 'running',
      stage: 'scan',
      cycle: cycleIndex,
      source: 'Extension',
      target: '',
      targetLabel: 'TÀI KHOẢN FACEBOOK',
      countdown: null,
      resetStats: true,
      historyMessage: `Vòng ${cycleIndex}: kiểm tra UID Facebook`,
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });

    const account = await refreshFacebookAccount({ silent: true });
    if (!account) {
      const error = new Error('Không kiểm tra được UID Facebook từ Extension. Chưa lấy cookie để tránh mất dòng cookie khi kết nối lỗi.');
      error.code = 'FACEBOOK_ACCOUNT_CHECK_FAILED';
      throw error;
    }

    if (account?.loggedIn && account?.uid) {
      S.setBridgeStatus(`Vòng ${cycleIndex}: đã phát hiện UID ${account.uid}. Bắt đầu quét nhóm...`, 'ok');
      reportProcess({
        actionKey: `cycle-${cycleIndex}-account-ready`,
        title: 'Xác thực UID Facebook thành công',
        detail: `UID ${account.uid} đã đăng nhập và sẵn sàng quét nhóm.`,
        status: 'ok',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Extension',
        target: account.uid,
        targetLabel: 'UID ĐANG SỬ DỤNG',
        historyMessage: `Xác thực UID ${account.uid} thành công`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
      return account;
    }

    if (!getFacebookCookieLines().length) {
      const error = new Error('Chưa phát hiện tài khoản Facebook đang đăng nhập trong Chrome.');
      error.code = 'FACEBOOK_ACCOUNT_AND_COOKIE_MISSING';
      throw error;
    }

    S.setBridgeStatus(`Vòng ${cycleIndex}: chưa có UID đăng nhập. Đang lấy dòng Cookie Facebook đầu tiên để tự động đăng nhập...`, 'warn');
    const loggedInAccount = await rotateFacebookCookieAfterLogout({
      source: `automatic-cycle-${cycleIndex}`,
      autoRestart: false
    });

    if (!loggedInAccount?.loggedIn || !loggedInAccount?.uid) {
      const error = new Error('Đăng nhập Cookie Facebook xong nhưng chưa phát hiện được UID.');
      error.code = 'FACEBOOK_UID_NOT_DETECTED';
      throw error;
    }

    return loggedInAccount;
  }

  async function waitAfterLink(linkIndex, totalLinks, nextLink = '') {
    const seconds = S.getLinkPauseSeconds();
    if (seconds <= 0 || !S.isClosedLoopRunning()) return;

    const historyKey = `wait-link-${linkIndex}-${totalLinks}-${Date.now()}`;
    const cleanNextLink = S.normalizeUrl(nextLink) || S.text(nextLink);
    let endAt = Date.now() + seconds * 1000;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      endAt += await waitWhileClosedLoopPaused();
      if (!S.isClosedLoopRunning()) break;
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`Đã chạy xong link ${linkIndex}/${totalLinks}. Đang nghỉ ${remainSeconds} giây rồi chạy link tiếp theo...`, 'warn');
      reportProcess({
        actionKey: `wait-link-${linkIndex}-${totalLinks}`,
        title: 'Nghỉ trước khi xử lý link tiếp theo',
        detail: `Đã hoàn tất link ${linkIndex}/${totalLinks}. Bộ đếm chỉ cập nhật tại dòng hiện tại.`,
        status: 'wait',
        stage: 'comment',
        ...queueProcessMeta(linkIndex, totalLinks),
        source: 'Hàng đợi',
        countdown: remainSeconds,
        countdownLabel: 'Chuyển sang link tiếp theo sau',
        historyMessage: `Đã xong link ${linkIndex}/${totalLinks} · chờ ${remainSeconds} giây trước link tiếp theo${cleanNextLink ? `: ${cleanNextLink}` : ''}`,
        historyTag: 'WAIT',
        historyLevel: 'warn',
        historyKey,
        historyMode: 'update'
      });
      await S.delay(Math.min(1000, Math.max(200, remainMs)));
    }

    if (S.isClosedLoopRunning()) {
      reportProcess({
        actionKey: `wait-link-${linkIndex}-${totalLinks}`,
        title: 'Bắt đầu xử lý link tiếp theo',
        detail: `Đã chờ đủ ${seconds} giây sau link ${linkIndex}/${totalLinks}.`,
        status: 'running',
        stage: 'scan',
        ...queueProcessMeta(linkIndex, totalLinks),
        source: 'Hàng đợi',
        target: cleanNextLink,
        targetLabel: 'LINK TIẾP THEO',
        countdown: 0,
        countdownLabel: 'Chuyển sang link tiếp theo sau',
        historyMessage: `Đã xong link ${linkIndex}/${totalLinks} · còn 0 giây · chuyển sang${cleanNextLink ? ` ${cleanNextLink}` : ' link tiếp theo'}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
    }
  }

  async function waitAfterAiNext(linkIndex, totalLinks, nextLink = '') {
    if (!S.isClosedLoopRunning()) return;

    const cleanNextLink = S.normalizeUrl(nextLink) || S.text(nextLink);
    const historyKey = `wait-ai-next-${linkIndex}-${totalLinks}-${Date.now()}`;
    let endAt = Date.now() + AI_NEXT_PAUSE_MS;

    S.setBridgeStatus(
      `AI trả về (next) cho link ${linkIndex}/${totalLinks}. Đang chờ 1 giây trước khi lọc bài tiếp theo...`,
      'warn'
    );
    reportProcess({
      actionKey: `wait-ai-next-${linkIndex}-${totalLinks}`,
      title: 'Chờ trước khi lọc bài tiếp theo',
      detail: 'API đã trả về next; hệ thống giữ đúng thứ tự và chờ đủ 1 giây.',
      status: 'wait',
      stage: 'ai',
      ...queueProcessMeta(linkIndex, totalLinks),
      source: getAiProviderLabel(),
      target: cleanNextLink,
      targetLabel: 'LINK SẼ LỌC TIẾP',
      countdown: 1,
      countdownLabel: 'Lọc bài tiếp theo sau',
      historyMessage: `AI trả về NEXT cho link ${linkIndex}/${totalLinks} · chờ 1 giây${cleanNextLink ? ` trước ${cleanNextLink}` : ''}`,
      historyTag: 'WAIT',
      historyLevel: 'warn',
      historyKey,
      historyMode: 'update'
    });

    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      endAt += await waitWhileClosedLoopPaused();
      if (!S.isClosedLoopRunning()) return;
      const remainMs = Math.max(0, endAt - Date.now());
      await S.delay(Math.min(250, Math.max(25, remainMs)));
    }

    if (S.isClosedLoopRunning()) {
      reportProcess({
        actionKey: `wait-ai-next-${linkIndex}-${totalLinks}`,
        title: 'Bắt đầu lọc bài tiếp theo',
        detail: 'Đã chờ đủ 1 giây sau kết quả next.',
        status: 'running',
        stage: 'ai',
        ...queueProcessMeta(linkIndex, totalLinks),
        source: getAiProviderLabel(),
        target: cleanNextLink,
        targetLabel: 'LINK ĐANG CHUYỂN TỚI',
        countdown: 0,
        countdownLabel: 'Lọc bài tiếp theo sau',
        historyMessage: `Đã chờ đủ 1 giây sau NEXT${cleanNextLink ? ` · bắt đầu ${cleanNextLink}` : ''}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
    }
  }

  function isNextCommentResult(value) {
    return /^\(?\s*next\s*\)?$/i.test(String(value || '').trim());
  }

  function isDeletedFacebookPostResult(response) {
    const data = API.bridgeResponseData(response);
    return data?.postDeleted === true
      || data?.code === 'FACEBOOK_POST_DELETED'
      || response?.code === 'FACEBOOK_POST_DELETED';
  }

  function scanModeLabel(mode) {
    const labels = {
      group_latest: 'Bài viết mới',
      group_top: 'Bài viết Top'
    };
    return labels[mode] || labels.group_latest;
  }

  function scannerPostRecords(response) {
    const data = API.bridgeResponseData(response);
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    return posts.map(post => ({
      url: S.normalizeUrl(post?.url || post?.link || post?.post_url || ''),
      caption: S.text(post?.caption || post?.content || post?.post_text || post?.title || ''),
      commentCount: S.normalizePostCommentCount(
        post?.commentCount ??
        post?.comment_count ??
        post?.commentsCount ??
        post?.comments_count ??
        post?.numberOfComments ??
        null
      ),
      title: S.text(post?.title || '')
    })).filter(record => record.url);
  }

  async function scanGroupLinksByExtension() {
    const groups = S.parseLines(B.fbGroupIdInput?.value);
    if (!groups.length) {
      S.setBridgeStatus('Hãy nhập UID hoặc link nhóm Facebook trước.', 'warn');
      B.fbGroupIdInput?.focus();
      const error = new Error('Chưa nhập UID hoặc link nhóm Facebook.');
      error.code = 'FACEBOOK_GROUPS_EMPTY';
      throw error;
    }

    const groupLimit = S.getGroupLimit();
    const scanMode = S.getScanSourceMode();
    const commentCountBypassThreshold = S.getCommentCountBypassThreshold();
    const modeLabel = scanModeLabel(scanMode);
    S.setBridgeStatus(
      `Cơ chế 1.2.5 đang quét ngầm link và caption ${modeLabel}, tối đa ${groupLimit} bài mỗi nhóm...`,
      'warn'
    );
    reportProcess({
      actionKey: 'facebook-scanner-start',
      title: 'Cơ chế 1.2.5 đang quét nhóm',
      detail: `${groups.length} nhóm · nguồn ${modeLabel} · tối đa ${groupLimit} link và caption mỗi nhóm.`,
      status: 'running',
      stage: 'scan',
      index: 0,
      total: groups.length,
      remaining: groups.length,
      source: 'Facebook Group Link Commenter 1.2.5',
      target: groups[0] || '',
      targetLabel: 'NHÓM ĐANG QUÉT',
      countdown: null,
      historyMessage: `Bắt đầu quét link và caption của ${groups.length} nhóm Facebook`,
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });

    const response = await API.sendBridge(
      ['SCAN_FACEBOOK_POSTS', 'SCAN_GROUP_PERMALINKS', 'SCAN_GROUP_LINKS', 'SCAN_GROUP_IN_NEW_TAB', 'scanGroupLinks', 'SCAN_GROUP', 'scan_links', 'SCAN_LINKS'],
      {
        groups,
        groupIds: groups,
        scanMode,
        sourceMode: scanMode,
        feedMode: scanMode,
        limit: groupLimit,
        limitPerGroup: groupLimit,
        perGroupLimit: groupLimit,
        commentCountBypassThreshold,
        requireCommentCount: commentCountBypassThreshold > 0
      }
    );

    const filtered = S.filterLinksAgainstHistory(API.extractLinksFromResponse(response));
    const links = filtered.links;
    const accepted = new Set(links.map(S.normalizeUrl));
    const postRecords = scannerPostRecords(response)
      .filter(record => accepted.has(S.normalizeUrl(record.url)));
    const savedCaptionCount = S.setPostCaptions(postRecords);
    const savedCommentCount = S.setPostCommentCounts(postRecords);
    S.setPostLinks(links);
    const queuedLinks = S.getPostLinks();
    const historyText = filtered.duplicateHistoryCount
      ? ` Đã xóa ${filtered.duplicateHistoryCount} link trùng lịch sử (${filtered.duplicateCommented.length} đã bình luận, ${filtered.duplicateRemoved.length} đã loại bỏ, ${filtered.duplicateErrors.length} link lỗi).`
      : '';

    if (links.length) {
      S.setBridgeStatus(
        `Cơ chế 1.2.5 đã lấy ${links.length} link ${modeLabel} không trùng, ghép ${savedCaptionCount}/${links.length} nội dung và ${savedCommentCount}/${links.length} số bình luận theo đúng link.${historyText} Hàng đợi hiện có ${queuedLinks.length} link.`,
        'ok'
      );
      reportProcess({
        actionKey: 'facebook-scanner-complete',
        title: 'Quét ngầm 1.2.5 hoàn tất',
        detail: `Nạp ${links.length} link mới; ghép được ${savedCaptionCount}/${links.length} nội dung và ${savedCommentCount}/${links.length} số bình luận.`,
        status: 'ok',
        stage: 'scan',
        index: links.length,
        total: links.length,
        remaining: 0,
        source: 'Facebook Group Link Commenter 1.2.5',
        target: '',
        targetLabel: 'KẾT QUẢ QUÉT',
        historyMessage: `Quét ngầm 1.2.5 hoàn tất, nạp ${links.length} link mới`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
    } else {
      S.setBridgeStatus(`Cơ chế 1.2.5 đã quét xong nhưng không có link ${modeLabel} mới sau khi đối chiếu lịch sử.${historyText}`, 'warn');
      reportProcess({
        actionKey: 'facebook-scanner-empty',
        title: 'Quét ngầm 1.2.5 không có link mới',
        detail: `Không còn link ${modeLabel} sau khi đối chiếu lịch sử.`,
        status: 'wait',
        stage: 'scan',
        index: 0,
        total: 0,
        remaining: 0,
        source: 'Facebook Group Link Commenter 1.2.5',
        target: '',
        targetLabel: 'KẾT QUẢ QUÉT',
        historyMessage: 'Quét ngầm 1.2.5 hoàn tất nhưng không có link mới',
        historyTag: 'IDLE',
        historyLevel: 'warn'
      });
    }

    return links;
  }

  async function scanGroupLinksByApify() {
    if (!APIFY?.fetchPostUrlsWithKeyFallback) {
      const error = new Error('Chưa nạp được module Apify API.');
      error.code = 'APIFY_MODULE_MISSING';
      throw error;
    }

    const groups = S.parseLines(B.fbGroupIdInput?.value);
    if (!groups.length) {
      B.fbGroupIdInput?.focus();
      const error = new Error('Chưa nhập UID hoặc link nhóm Facebook.');
      error.code = 'APIFY_GROUPS_EMPTY';
      throw error;
    }

    const unsupportedGroups = groups.filter(group => {
      const normalized = APIFY.normalizeGroupUrl(group);
      return !/^https:\/\/www\.facebook\.com\/groups\/\d{6,30}$/i.test(normalized);
    });
    if (unsupportedGroups.length) {
      const error = new Error('Để chế độ API có thể tự chuyển sang thủ công khi lỗi, hãy nhập UID nhóm dạng số hoặc link nhóm có UID dạng số.');
      error.code = 'APIFY_GROUPS_EMPTY';
      throw error;
    }

    const tokens = S.getApifyTokens();
    if (!tokens.length) {
      const error = new Error('Chưa có Apify API key trong Cài đặt API. Hãy nhập thủ công mỗi key một dòng.');
      error.code = 'APIFY_KEYS_EMPTY';
      throw error;
    }

    const actorId = S.getApifyActorId();
    const activeTokenIndex = S.getApifyActiveTokenIndex(tokens);
    const groupLimit = S.getGroupLimit();
    const scanMode = S.getScanSourceMode();
    const normalizedGroups = [...new Set(groups.map(group => APIFY.normalizeGroupUrl(group)).filter(Boolean))];
    if (!normalizedGroups.length) {
      const error = new Error('Không có UID hoặc link nhóm Facebook hợp lệ cho Apify.');
      error.code = 'APIFY_GROUPS_EMPTY';
      throw error;
    }

    S.setBridgeStatus(`Đang gọi ${APIFY.getActorLabel(actorId)} cho ${normalizedGroups.length} nhóm bằng Apify key ${activeTokenIndex + 1}/${tokens.length}...`, 'warn');
    reportProcess({
      actionKey: 'apify-scanner-start',
      title: 'Apify API đang lấy bài viết',
      detail: `${normalizedGroups.length} nhóm · ${groupLimit} bài mỗi nhóm · 2 Actor · ${tokens.length} Apify key dự phòng.`,
      status: 'running',
      stage: 'scan',
      index: 0,
      total: normalizedGroups.length,
      remaining: normalizedGroups.length,
      source: 'Apify API',
      target: normalizedGroups[0] || '',
      targetLabel: 'NHÓM ĐANG QUÉT',
      countdown: null,
      historyMessage: `Bắt đầu lấy bài của ${normalizedGroups.length} nhóm bằng Apify`,
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });

    const controller = new AbortController();
    activeApifyAbortController = controller;
    let result;
    try {
      result = await APIFY.fetchPostUrlsWithKeyFallback({
        actorId,
        tokens,
        activeTokenIndex,
        groups: normalizedGroups,
        limit: groupLimit,
        scanMode,
        signal: controller.signal,
        onTokenAttempt: ({ tokenIndex, attempt, total, previousError }) => {
          const retryText = previousError ? 'Key trước bị lỗi; ' : '';
          const message = `${retryText}đang thử Apify key ${tokenIndex + 1}/${tokens.length} (lượt key ${attempt}/${total})...`;
          S.setBridgeStatus(message, 'warn');
          S.setApifyFailoverStatus(message);
        },
        onActorAttempt: ({ actorLabel, attempt, total, tokenIndex, previousError }) => {
          const retryText = previousError ? 'Actor trước bị lỗi; ' : '';
          const message = `${retryText}đang gọi ${actorLabel} bằng key ${tokenIndex + 1}/${tokens.length} (Actor ${attempt}/${total})...`;
          S.setBridgeStatus(message, 'warn');
          S.setApifyFailoverStatus(message);
        }
      });
    } finally {
      if (activeApifyAbortController === controller) activeApifyAbortController = null;
    }

    if (Number.isInteger(result?.activeTokenIndex)) {
      S.setApifyActiveTokenIndex(result.activeTokenIndex, tokens);
      S.updateApifyFailoverStatus(tokens);
    }
    if (result?.switchedActor && result.actorId) S.setApifyActorId(result.actorId);

    if (result?.noLinks === true || !Array.isArray(result?.links) || !result.links.length) {
      const error = new Error('Cả hai Apify Actor đều chạy nhưng không trả về link bài viết hợp lệ.');
      error.code = 'APIFY_NO_LINKS';
      error.noLinks = true;
      throw error;
    }

    const filtered = S.filterLinksAgainstHistory(result.links);
    const links = filtered.links;
    const accepted = new Set(links.map(S.normalizeUrl));
    const postRecords = (Array.isArray(result.posts) ? result.posts : [])
      .map(post => ({
        url: S.normalizeUrl(post?.url || post?.link || post?.post_url || ''),
        caption: S.text(post?.caption || ''),
        commentCount: S.normalizePostCommentCount(
          post?.commentCount ??
          post?.comment_count ??
          post?.commentsCount ??
          post?.comments_count ??
          post?.numberOfComments ??
          null
        )
      }))
      .filter(record => record.url && accepted.has(record.url));
    const savedCaptionCount = S.setPostCaptions(postRecords);
    const savedCommentCount = S.setPostCommentCounts(postRecords);
    S.setPostLinks(links);

    const historyText = filtered.duplicateHistoryCount
      ? ` Đã bỏ ${filtered.duplicateHistoryCount} link trùng lịch sử.`
      : '';
    if (links.length) {
      const keyText = Number.isInteger(result.activeTokenIndex)
        ? ` bằng key ${result.activeTokenIndex + 1}/${tokens.length}`
        : '';
      const actorText = result.actorId ? ` qua ${APIFY.getActorLabel(result.actorId)}` : '';
      S.setBridgeStatus(`Apify đã lấy ${links.length} link mới${actorText}${keyText}, ghép ${savedCaptionCount}/${links.length} caption và ${savedCommentCount}/${links.length} số bình luận.${historyText}`, 'ok');
      reportProcess({
        actionKey: 'apify-scanner-complete',
        title: 'Apify API quét xong',
        detail: `Nạp ${links.length} link mới bằng ${APIFY.getActorLabel(result.actorId)}; ghép được ${savedCaptionCount}/${links.length} caption và ${savedCommentCount}/${links.length} số bình luận.`,
        status: 'ok',
        stage: 'scan',
        index: links.length,
        total: links.length,
        remaining: 0,
        source: 'Apify API',
        target: '',
        targetLabel: 'KẾT QUẢ QUÉT',
        countdown: null,
        historyMessage: `Apify hoàn tất, nạp ${links.length} link mới`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
    } else {
      S.setBridgeStatus(`Apify chạy thành công nhưng không còn link mới sau khi đối chiếu lịch sử.${historyText}`, 'warn');
      reportProcess({
        actionKey: 'apify-scanner-empty',
        title: 'Apify không có link mới',
        detail: 'Tất cả link trả về đã có trong lịch sử xử lý.',
        status: 'wait',
        stage: 'scan',
        index: 0,
        total: 0,
        remaining: 0,
        source: 'Apify API',
        target: '',
        targetLabel: 'KẾT QUẢ QUÉT',
        countdown: null,
        historyMessage: 'Apify hoàn tất nhưng không có link mới',
        historyTag: 'IDLE',
        historyLevel: 'warn'
      });
    }

    return links;
  }

  async function scanGroupLinks({ method = currentClosedLoopScanMethod } = {}) {
    const selectedMethod = normalizeScanMethod(method);
    if (selectedMethod !== 'apify') return await scanGroupLinksByExtension();

    try {
      return await scanGroupLinksByApify();
    } catch (apifyError) {
      if (apifyError?.code === 'APIFY_ABORTED') throw apifyError;
      const classification = classifyApifyError(apifyError);
      currentClosedLoopScanMethod = 'manual';
      lastRequestedScanMethod = 'manual';
      S.setBridgeStatus(`Apify lỗi (${classification.code}). Đã tự chuyển sang chạy thủ công...`, 'warn');
      reportProcess({
        actionKey: 'apify-fallback-manual',
        title: 'Apify lỗi, chuyển sang chạy thủ công',
        detail: `${classification.message} Các vòng tiếp theo sẽ dùng bộ quét thủ công.`,
        status: 'running',
        stage: 'scan',
        source: 'Apify API → Quét thủ công',
        target: '',
        targetLabel: 'CHẾ ĐỘ DỰ PHÒNG',
        countdown: null,
        historyMessage: `Apify lỗi (${classification.code}); tự chuyển sang chạy thủ công`,
        historyTag: 'FALLBACK',
        historyLevel: 'warn'
      });

      try {
        return await scanGroupLinksByExtension();
      } catch (manualError) {
        const error = new Error(`Apify thất bại (${classification.message}) và quét thủ công cũng thất bại: ${manualError?.message || manualError}`);
        error.code = 'APIFY_AND_MANUAL_SCAN_FAILED';
        error.apifyError = apifyError;
        error.manualError = manualError;
        throw error;
      }
    }
  }


  function setArticleInputContent(article) {
    const content = S.text(article);
    if (!content) return '';
    if (B.articleInput) {
      B.articleInput.value = content;
      B.articleInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return content;
  }

  async function readFirstFacebookPost(targetLink = '') {
    const link = targetLink || S.getPostLinks()[0];
    if (!link) {
      S.setBridgeStatus('Chưa có link bài viết Facebook để đọc.', 'warn');
      B.fbPostLinkInput?.focus();
      return '';
    }

    S.setBridgeStatus('Cơ chế 1.2.5 đang đọc caption bài viết ngầm...', 'warn');
    reportProcess({
      actionKey: 'facebook-extension-read-current-link',
      title: 'Cơ chế 1.2.5 đang đọc bài viết',
      detail: 'Nội dung ghép theo link đang rỗng; đọc lại bằng request Facebook nền.',
      status: 'running',
      stage: 'scan',
      source: 'Facebook Group Link Commenter 1.2.5',
      target: link,
      targetLabel: 'LINK ĐANG ĐỌC',
      countdown: null,
      historyMessage: 'Nội dung rỗng, chuyển sang cơ chế 1.2.5 đọc ngầm',
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });
    const response = await API.sendBridge(
      ['READ_FB_POST_CONTENT', 'READ_FB_POST_TITLE', 'READ_FB_POST', 'READ_FACEBOOK_POST', 'readFbPost', 'readFacebookPost', 'READ_POST'],
      {
        url: link,
        link,
        maxChars: Number(B.fbMaxChars?.value || 20000),
        actor: { mode: 'user', pageId: '' }
      }
    );


    const article = API.extractArticleFromResponse(response);
    if (!article) throw new Error('Extension chưa trả về nội dung bài viết Facebook.');
    setArticleInputContent(article);

    S.setBridgeStatus('Đã lấy caption bằng cơ chế 1.2.5 và điền vào ô nội dung gốc.', 'ok');
    reportProcess({
      actionKey: 'facebook-extension-read-current-link-complete',
      title: 'Cơ chế 1.2.5 đã đọc xong bài viết',
      detail: `${article.length} ký tự đã được nạp vào nội dung gốc.`,
      status: 'ok',
      stage: 'ai',
      source: 'Facebook Group Link Commenter 1.2.5',
      target: link,
      targetLabel: 'LINK ĐANG XỬ LÝ',
      countdown: null,
      historyMessage: `Extension đã nạp ${article.length} ký tự nội dung`,
      historyTag: 'OK',
      historyLevel: 'ok'
    });
    return article;
  }

  async function loadArticleForLink(link, { allowExtensionFallback = true } = {}) {
    const caption = S.getPostCaption(link);
    if (caption) {
      const article = setArticleInputContent(caption);
      S.setBridgeStatus('Đã nạp tiêu đề/nội dung được ghép sẵn theo link bài viết.', 'ok');
      reportProcess({
        actionKey: 'load-scanned-caption',
        title: 'Đã nạp nội dung theo link',
        detail: `${article.length} ký tự · không cần mở lại bài viết.`,
        status: 'ok',
        stage: 'ai',
        source: 'Kết quả quét Facebook 1.2.5',
        target: link,
        targetLabel: 'LINK ĐANG XỬ LÝ',
        countdown: null,
        historyMessage: 'Nạp nội dung đã ghép theo link cho AI',
        historyTag: 'OK',
        historyLevel: 'ok'
      });
      return { article, source: 'cached_caption' };
    }

    const error = new Error('Link bài viết không có caption trong kết quả quét.');
    error.code = 'CAPTION_MISSING';
    throw error;
  }

  function setManualCommentStatus(message, state = '') {
    if (!B.manualCommentStatus) return;
    B.manualCommentStatus.textContent = String(message || '');
    if (state) B.manualCommentStatus.dataset.state = state;
    else delete B.manualCommentStatus.dataset.state;
  }

  function getCommentComposerMode() {
    const storedMode = S.load(S.STORE.commentComposerMode, 'ai');
    return storedMode === 'manual' ? 'manual' : 'ai';
  }

  function getManualCommentInputValue() {
    if (B.manualCommentInput) return String(B.manualCommentInput.value || '');
    return String(S.load(S.STORE.manualCommentText, '') || '');
  }

  function parseManualCommentInput() {
    if (!MANUAL_CONTENT?.parse) {
      return {
        source: getManualCommentInputValue().trim(),
        variants: [],
        random: false,
        error: 'Chưa nạp được bộ xử lý nội dung bình luận thủ công.'
      };
    }
    return MANUAL_CONTENT.parse(getManualCommentInputValue());
  }

  function renderManualCommentConfiguration() {
    const rawLength = B.manualCommentInput?.value.length || 0;
    const parsed = parseManualCommentInput();
    if (B.manualCommentCounter) {
      const variantText = parsed.error
        ? ''
        : ` · ${parsed.variants.length} nội dung${parsed.random ? ' ngẫu nhiên' : ''}`;
      B.manualCommentCounter.textContent = `${rawLength}/8000${variantText}`;
    }

    if (parsed.error) {
      setManualCommentStatus(parsed.error, 'warning');
      return parsed;
    }

    setManualCommentStatus(
      parsed.random
        ? `Đã lưu ${parsed.variants.length} nội dung; mỗi link sẽ chọn ngẫu nhiên một nội dung.`
        : 'Đã lưu nội dung cố định; hệ thống sẽ tự dùng nội dung này cho mỗi link.',
      'success'
    );
    return parsed;
  }

  function requireManualCommentConfiguration() {
    const parsed = parseManualCommentInput();
    const reservedNext = parsed.variants?.some(value => isNextCommentResult(value));
    if (!parsed.error && !reservedNext) return parsed;

    const error = new Error(
      reservedNext
        ? 'Nội dung thủ công không được chỉ là “next” hoặc “(next)” vì đây là từ khóa bỏ qua bài.'
        : parsed.error
    );
    error.code = reservedNext ? 'MANUAL_COMMENT_RESERVED_VALUE' : 'MANUAL_COMMENT_CONFIGURATION_INVALID';
    error.failureStage = 'comment';
    error.stopClosedLoop = true;
    setManualCommentStatus(error.message, 'error');
    throw error;
  }

  function getCommentComposerContext() {
    const mode = getCommentComposerMode();
    return mode === 'manual'
      ? { mode, manual: requireManualCommentConfiguration() }
      : { mode: 'ai', manual: null };
  }

  function pickManualComment(configuration) {
    if (!MANUAL_CONTENT?.pick) {
      const error = new Error('Chưa nạp được bộ chọn nội dung bình luận thủ công.');
      error.code = 'MANUAL_COMMENT_PICKER_UNAVAILABLE';
      error.failureStage = 'comment';
      error.stopClosedLoop = true;
      throw error;
    }
    return MANUAL_CONTENT.pick(configuration);
  }

  async function commentToFacebook(link, comment, options = {}) {
    const image = options.image && typeof options.image === 'object' && options.image.dataUrl
      ? options.image
      : null;
    if (!comment && !image) throw new Error('Chưa có nội dung hoặc ảnh bình luận.');
    if (comment && isNextCommentResult(comment)) {
      S.setBridgeStatus('AI trả về (next), không gửi bình luận cho bài này.', 'warn');
      return { ok: true, skipped: true, reason: 'next' };
    }
    S.setBridgeStatus(
      image
        ? 'Đang mở trình soạn bình luận Facebook để gửi nội dung kèm ảnh...'
        : 'Đang gửi bình luận bằng mutation Facebook của cơ chế 1.2.5...',
      'warn'
    );

    const targetLink = link || S.getPostLinks()[0] || '';
    const cleanTargetLink = S.normalizeUrl(targetLink) || S.text(targetLink);
    const cleanComment = S.text(comment).replace(/\s+/g, ' ');
    const commentSummary = cleanComment || `[Ảnh: ${image?.name || 'đính kèm'}]`;
    const commentSource = image
      ? 'Trình soạn bình luận Facebook'
      : options.source === 'manual-automatic'
        ? 'Nội dung thủ công · Gửi tự động'
        : 'Facebook Group Link Commenter 1.2.5';
    const commentHistoryKey = `facebook-comment-${Date.now()}`;
    reportProcess({
      actionKey: 'facebook-comment-submit',
      title: 'Đang gửi bình luận lên Facebook',
      detail: image
        ? 'Extension mở bài viết Facebook, gắn ảnh đã chọn và gửi bằng trình soạn bình luận trên trang.'
        : 'Extension gửi mutation bình luận trực tiếp và kiểm tra phản hồi GraphQL của Facebook.',
      status: 'running',
      stage: 'comment',
      source: commentSource,
      target: targetLink,
      targetLabel: 'LINK ĐANG BÌNH LUẬN',
      countdown: null,
      historyMessage: `Đang bình luận vào ${cleanTargetLink || 'link Facebook hiện tại'} · Nội dung: “${commentSummary}”${image ? ' · Có ảnh đính kèm' : ''}`,
      historyTag: 'RUNNING',
      historyLevel: 'running',
      historyKey: commentHistoryKey,
      historyMode: 'update'
    });
    let response;
    try {
      response = await API.sendBridge(
        ['COMMENT_FACEBOOK_POST', 'COMMENT_FB_POST', 'COMMENT_IN_FB_TAB', 'commentFbPost', 'commentFacebookPost', 'COMMENT_POST', 'COMMENT_CURRENT_TAB'],
        {
          url: targetLink,
          link: targetLink,
          comment,
          text: comment,
          commentText: comment,
          image: image ? {
            name: image.name,
            type: image.type,
            size: image.size,
            dataUrl: image.dataUrl
          } : null,
          actor: { mode: 'current', pageId: '' }
        }
      );
      const submittedData = API.bridgeResponseData(response);
      if (
        isObjectObjectError(submittedData?.error)
        || isObjectObjectError(submittedData?.message)
        || isObjectObjectError(response?.message)
      ) {
        throw new Error('[object Object]');
      }
    } catch (error) {
      let commentError = error;
      if (S.isClosedLoopRunning() && isObjectObjectError(error)) {
        commentError = markClosedLoopFatal(new Error(
          'Lỗi gửi bình luận Facebook: [object Object]. Đã dừng chạy tự động.'
        ));
        commentError.code = 'OBJECT_OBJECT_ERROR';
        commentError.failureStage = 'comment';
        commentError.cause = error;
      }
      reportProcess({
        actionKey: 'facebook-comment-error',
        title: 'Gửi bình luận Facebook thất bại',
        detail: commentError.message || String(commentError),
        status: 'error',
        stage: 'comment',
        source: commentSource,
        target: cleanTargetLink,
        targetLabel: 'LINK GẶP LỖI',
        countdown: null,
        statDelta: { errors: 1 },
        historyMessage: `Gửi bình luận thất bại tại ${cleanTargetLink || 'link Facebook hiện tại'} · Nội dung: “${commentSummary}” · Lỗi: ${commentError.message || commentError}`,
        historyTag: 'ERROR',
        historyLevel: 'error',
        historyKey: commentHistoryKey,
        historyMode: 'update'
      });
      if (commentError && typeof commentError === 'object') commentError.autovipCommentHistoryReported = true;
      throw commentError;
    }

    const responseData = API.bridgeResponseData(response);
    if (isDeletedFacebookPostResult(response)) {
      S.saveRemovedLink(targetLink);
      S.setBridgeStatus('bài viết đã bị xóa', 'warn');
      reportProcess({
        actionKey: 'facebook-post-deleted',
        title: 'Bài viết đã bị xóa',
        detail: 'Link được chuyển sang danh sách loại bỏ và tiến trình chuyển bài tiếp theo.',
        status: 'next',
        stage: 'comment',
        source: commentSource,
        target: targetLink,
        targetLabel: 'LINK ĐÃ LOẠI BỎ',
        countdown: null,
        statDelta: { skipped: 1 },
        historyMessage: `Không thể bình luận vì bài đã bị xóa: ${cleanTargetLink} · Nội dung dự kiến: “${commentSummary}”`,
        historyTag: 'NEXT',
        historyLevel: 'warn',
        historyKey: commentHistoryKey,
        historyMode: 'update'
      });
      return response;
    }

    if (responseData?.restrictionDetected || responseData?.fatalStop || responseData?.code === 'FACEBOOK_FEATURE_RESTRICTED') {
      const restrictionMessage = responseData.message || 'Facebook đang tạm giới hạn tính năng đăng bài/bình luận. Hệ thống đã dừng.';
      S.setClosedLoopRunning(false);
      B.stopClosedLoopBtn?.classList.add('hidden');

      fatalStopMessage = restrictionMessage;
      S.setBridgeStatus(fatalStopMessage, 'error');
      reportProcess({
        actionKey: 'facebook-comment-restricted',
        title: 'Facebook giới hạn tính năng bình luận',
        detail: fatalStopMessage,
        status: 'error',
        stage: 'comment',
        source: commentSource,
        target: targetLink,
        targetLabel: 'LINK GẶP LỖI',
        countdown: null,
        statDelta: { errors: 1 },
        historyMessage: `Facebook giới hạn bình luận tại ${cleanTargetLink} · Nội dung: “${commentSummary}”`,
        historyTag: 'ERROR',
        historyLevel: 'error',
        historyKey: commentHistoryKey,
        historyMode: 'update'
      });
      const stopError = new Error(fatalStopMessage);
      stopError.stopClosedLoop = true;
      stopError.code = 'FACEBOOK_FEATURE_RESTRICTED';
      throw stopError;
    }

    S.setBridgeStatus('Đã gửi bình luận xong.', 'ok');
    reportProcess({
      actionKey: 'facebook-comment-success',
      title: 'Bình luận Facebook thành công',
      detail: image
        ? 'Facebook đã nhận bình luận kèm ảnh; link được lưu vào lịch sử thành công.'
        : 'Facebook đã xác nhận tạo bình luận; link được lưu vào lịch sử thành công.',
      status: 'ok',
      stage: 'comment',
      source: commentSource,
      target: targetLink,
      targetLabel: 'LINK ĐÃ BÌNH LUẬN',
      countdown: null,
      statDelta: { success: 1 },
      historyMessage: `Đã bình luận thành công vào ${cleanTargetLink || 'link Facebook hiện tại'} · Nội dung: “${commentSummary}”${image ? ' · Có ảnh đính kèm' : ''}`,
      historyTag: 'OK',
      historyLevel: 'ok',
      historyKey: commentHistoryKey,
      historyMode: 'update'
    });
    return response;
  }

  async function commentCurrentTab() {
    const comment = S.text(B.output?.textContent);
    if (!comment || /Bình luận sẽ xuất hiện/i.test(comment)) {
      S.setBridgeStatus('Chưa có bình luận để gửi.', 'warn');
      return;
    }
    if (isNextCommentResult(comment)) {
      S.setBridgeStatus('Kết quả là (next), không gửi bình luận.', 'warn');
      return;
    }
    const link = S.getPostLinks()[0] || '';
    const response = await commentToFacebook(link, comment);
    if (isDeletedFacebookPostResult(response)) return response;
    if (link) S.saveCommentedLink(link);
    return response;
  }

  function wireManualCommentForm() {
    if (B.manualCommentInput) {
      B.manualCommentInput.value = String(S.load(S.STORE.manualCommentText, '') || '');
      const saveComment = () => {
        S.save(S.STORE.manualCommentText, B.manualCommentInput.value);
        renderManualCommentConfiguration();
      };
      B.manualCommentInput.addEventListener('input', saveComment);
      B.manualCommentInput.addEventListener('change', saveComment);
    }
    renderManualCommentConfiguration();

    window.addEventListener('autovip:composer-tab', event => {
      if (event.detail?.tab !== 'manual') return;
      renderManualCommentConfiguration();
      window.requestAnimationFrame(() => {
        if (B.composerManualPanel?.classList.contains('is-workspace-active')) {
          B.manualCommentInput?.focus({ preventScroll: true });
        }
      });
    });
  }

  async function autoWorkflow({ manageLoopState = true, allowExtensionFallback = true } = {}) {
    const links = S.getPostLinks();
    if (!links.length) {
      S.setBridgeStatus('Chưa có link bài viết. Hãy quét nhóm hoặc dán link trước.', 'warn');
      return;
    }
    const composerContext = getCommentComposerContext();

    if (manageLoopState) {
      dailyLimitStopMessage = '';
      if (stopForDailyCommentLimitIfReached()) return;
      await ensureFacebookAccountBeforeCycle(1);
      fatalStopMessage = '';
      S.setClosedLoopRunning(true);
      S.setClosedLoopPaused(false);
      updatePauseButton();
      B.stopClosedLoopBtn?.classList.remove('hidden');
    }

    const queue = [...links];
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const link = queue[index];
        await waitWhileClosedLoopPaused();
        if (!S.isClosedLoopRunning()) break;
        if (stopForDailyCommentLimitIfReached()) break;

        try {
          S.setBridgeStatus(`Đang xử lý link ${index + 1}/${queue.length}...`, 'warn');
          reportProcess({
            actionKey: `queue-link-${index + 1}`,
            title: `Bắt đầu xử lý link ${index + 1}/${queue.length}`,
            detail: composerContext.mode === 'manual'
              ? 'Đang nạp bài viết và chuẩn bị nội dung thủ công để hệ thống tự gửi.'
              : 'Đang nạp nội dung bài viết trước khi gửi sang AI xử lý.',
            status: 'running',
            stage: 'scan',
            ...queueProcessMeta(index + 1, queue.length),
            source: S.getPostCaption(link) ? 'Nội dung đã ghép theo link' : 'Link thiếu caption',
            target: link,
            targetLabel: 'LINK ĐANG XỬ LÝ',
            countdown: null,
            historyMessage: `Bắt đầu xử lý link ${index + 1}/${queue.length}`,
            historyTag: 'RUNNING',
            historyLevel: 'running'
          });
          const filterSellingPostsEnabled = S.getFilterSellingPostsEnabled();
          const commentCountBypassThreshold = S.getCommentCountBypassThreshold();
          const postCommentCount = S.getPostCommentCount(link);
          const bypassSellingFilterByCommentCount = commentCountBypassThreshold > 0
            && postCommentCount !== null
            && postCommentCount >= commentCountBypassThreshold;

          if (
            !filterSellingPostsEnabled
            && commentCountBypassThreshold > 0
            && !bypassSellingFilterByCommentCount
          ) {
            const countDescription = postCommentCount === null
              ? 'không xác định được số bình luận'
              : `chỉ có ${postCommentCount} bình luận`;
            S.setBridgeStatus(
              `Link ${index + 1}/${queue.length} ${countDescription}; chưa đạt ngưỡng ${commentCountBypassThreshold}, đã bỏ qua bài.`,
              'warn'
            );
            reportProcess({
              actionKey: `comment-count-next-${index + 1}`,
              title: 'Bài không đạt ngưỡng bình luận',
              detail: `Lọc bài bán hàng đang tắt; bài ${countDescription} nên không đạt ngưỡng ${commentCountBypassThreshold}.`,
              status: 'next',
              stage: 'scan',
              ...queueProcessMeta(index + 1, queue.length),
              source: 'Lọc theo số bình luận',
              target: link,
              targetLabel: 'LINK ĐÃ BỎ QUA',
              countdown: null,
              statDelta: { skipped: 1 },
              historyMessage: `Link ${index + 1}/${queue.length} ${countDescription}; không đạt ngưỡng ${commentCountBypassThreshold}`,
              historyTag: 'NEXT',
              historyLevel: 'warn'
            });
            S.saveRemovedLink(link);
            S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
            continue;
          }

          S.setPostLinks([link, ...S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link))]);
          const { article } = await loadArticleForLink(link, { allowExtensionFallback });
          await waitWhileClosedLoopPaused();
          if (!S.isClosedLoopRunning()) break;

          const controller = window.chatGPTApiController || {};
          const skipSellingPostFilter = !filterSellingPostsEnabled || bypassSellingFilterByCommentCount;
          let comment = '';

          if (composerContext.mode === 'manual') {
            if (!skipSellingPostFilter) {
              if (typeof controller.classifyArticleIntent !== 'function') {
                const error = new Error('Chưa nạp được chức năng AI lọc bài bán hàng.');
                error.code = 'AI_FILTER_UNAVAILABLE';
                error.failureStage = 'ai';
                error.stopClosedLoop = true;
                throw error;
              }
              if (typeof controller.hasApiKey === 'function' && !controller.hasApiKey()) {
                const error = new Error(`Chưa có ${getAiProviderLabel()} API key để lọc bài bán hàng. Hãy nhập API key hoặc tắt bộ lọc trước khi chạy.`);
                error.code = 'AI_API_KEY_MISSING';
                error.failureStage = 'ai';
                error.stopClosedLoop = true;
                throw error;
              }

              S.setBridgeStatus(`AI đang lọc link ${index + 1}/${queue.length}; nội dung thủ công vẫn được giữ nguyên...`, 'warn');
              reportProcess({
                actionKey: `manual-filter-link-${index + 1}`,
                title: 'AI đang lọc bài trước khi gửi nội dung thủ công',
                detail: 'AI chỉ phân loại bài viết. Sau khi bài được duyệt, extension tự chọn nội dung đã lưu và tự gửi.',
                status: 'running',
                stage: 'ai',
                ...queueProcessMeta(index + 1, queue.length),
                source: `${getAiProviderLabel()} · Chỉ lọc bài`,
                target: link,
                targetLabel: 'LINK ĐANG LỌC',
                countdown: null,
                historyMessage: `AI bắt đầu lọc link ${index + 1}/${queue.length} trước khi dùng nội dung thủ công`,
                historyTag: 'RUNNING',
                historyLevel: 'running'
              });
              let intent;
              try {
                intent = await controller.classifyArticleIntent(article, {
                  waitForValidResult: true,
                  shouldContinue: () => S.isClosedLoopRunning(),
                  onInvalidResult: ({ attempt }) => {
                    S.setBridgeStatus(
                      `API chưa trả về đúng next hoặc comment ở lượt ${attempt}. Đang giữ nguyên link ${index + 1}/${queue.length} và thử lại...`,
                      'warn'
                    );
                  }
                });
              } catch (classificationFailure) {
                const error = classificationFailure instanceof Error
                  ? classificationFailure
                  : new Error(String(classificationFailure || 'AI chưa phân loại được bài viết.'));
                error.code = error.code || 'AI_ARTICLE_INTENT_UNRESOLVED';
                error.failureStage = 'ai';
                error.stopClosedLoop = true;
                throw error;
              }
              if (intent === 'next') comment = '(next)';
            }

            if (!isNextCommentResult(comment)) {
              comment = pickManualComment(composerContext.manual);
              const selectionLabel = composerContext.manual.random
                ? `Đã chọn ngẫu nhiên 1/${composerContext.manual.variants.length} nội dung`
                : 'Đã lấy nội dung cố định';
              setManualCommentStatus(`${selectionLabel} cho link ${index + 1}/${queue.length}; đang gửi tự động...`, 'working');
              S.setBridgeStatus(`${selectionLabel}; đang tự gửi bình luận cho link ${index + 1}/${queue.length}...`, 'warn');
              reportProcess({
                actionKey: `manual-content-link-${index + 1}`,
                title: 'Đã chuẩn bị nội dung thủ công để gửi tự động',
                detail: composerContext.manual.random
                  ? `Chọn ngẫu nhiên một trong ${composerContext.manual.variants.length} nội dung đã lưu.`
                  : 'Dùng nội dung cố định đã lưu, không gọi AI viết lại.',
                status: 'running',
                stage: 'comment',
                ...queueProcessMeta(index + 1, queue.length),
                source: 'Soạn Bình Luận · Nhập thủ công',
                target: link,
                targetLabel: 'LINK ĐANG BÌNH LUẬN',
                countdown: null,
                historyMessage: `${selectionLabel} cho link ${index + 1}/${queue.length}; chuyển sang bước gửi tự động`,
                historyTag: 'MANUAL',
                historyLevel: 'running'
              });
            }
          } else {
            if (!controller.generateComment) throw new Error('Chưa nạp được hàm gọi AI API.');
            if (!controller.ensureProductLinksForAutoRun) {
              const error = new Error('Chưa nạp được hàm kiểm tra Link Shopee hoặc link sản phẩm.');
              error.code = 'PRODUCT_LINK_CHECK_UNAVAILABLE';
              throw error;
            }
            await controller.ensureProductLinksForAutoRun();
            reportProcess({
              actionKey: `ai-link-${index + 1}`,
              title: skipSellingPostFilter ? 'AI đang chọn mẫu và tạo bình luận' : 'AI đang lọc bài, chọn mẫu và tạo bình luận',
              detail: bypassSellingFilterByCommentCount
                ? `Bài có ${postCommentCount} bình luận, đạt ngưỡng ${commentCountBypassThreshold}; bỏ qua AI lọc bài bán hàng, sau đó vẫn chọn mẫu và tạo bình luận.`
                : !filterSellingPostsEnabled
                  ? 'Lọc bài bán hàng và lọc theo số bình luận đều đang tắt; hệ thống tạo bình luận ngay sau bước chọn mẫu.'
                  : `Bài có ${postCommentCount === null ? 'số bình luận chưa xác định' : `${postCommentCount} bình luận`}; AI thực hiện lần lượt 3 bước: lọc bài bán hàng, chọn mẫu sản phẩm và tạo bình luận.`,
              status: 'running',
              stage: 'ai',
              ...queueProcessMeta(index + 1, queue.length),
              source: getAiProviderLabel(),
              target: link,
              targetLabel: 'LINK ĐANG PHÂN TÍCH',
              countdown: null,
              historyMessage: bypassSellingFilterByCommentCount
                ? `Link ${index + 1}/${queue.length} đạt ngưỡng ${commentCountBypassThreshold}; AI bắt đầu chọn mẫu và tạo bình luận`
                : !filterSellingPostsEnabled
                  ? `Link ${index + 1}/${queue.length}: cả hai bộ lọc đang tắt; AI bắt đầu chọn mẫu và tạo bình luận`
                  : `AI bắt đầu quy trình 3 bước cho link ${index + 1}/${queue.length}`,
              historyTag: 'RUNNING',
              historyLevel: 'running'
            });
            comment = await controller.generateComment({
              automation: true,
              filterSellingPostsEnabled,
              skipCaptionFilter: bypassSellingFilterByCommentCount,
              postCommentCount,
              commentCountBypassThreshold,
              shouldContinue: () => S.isClosedLoopRunning(),
              onArticleIntentInvalid: ({ attempt }) => {
                S.setBridgeStatus(
                  `API chưa trả về đúng next hoặc comment ở lượt ${attempt}. Đang giữ nguyên link ${index + 1}/${queue.length} và thử lại...`,
                  'warn'
                );
              }
            });
          }
          await waitWhileClosedLoopPaused();
          if (!S.isClosedLoopRunning()) break;

          if (isNextCommentResult(comment) || controller.isNextResult?.(comment)) {
            const filterLabel = composerContext.mode === 'manual' ? 'AI lọc bài' : 'AI';
            S.setBridgeStatus(`${filterLabel} xác định link ${index + 1}/${queue.length} là bài người bán/cho thuê, đã bỏ qua và chuyển bài tiếp theo.`, 'warn');
            if (composerContext.mode === 'manual') {
              setManualCommentStatus('AI đã loại bài hiện tại; nội dung thủ công chưa được gửi và tiến trình đang chuyển link kế tiếp.', 'warning');
            }
            reportProcess({
              actionKey: `ai-next-${index + 1}`,
              title: 'AI loại bài không phù hợp',
              detail: `Link ${index + 1}/${queue.length} trả về (next) và được chuyển vào danh sách loại bỏ.`,
              status: 'next',
              stage: 'ai',
              ...queueProcessMeta(index + 1, queue.length),
              source: getAiProviderLabel(),
              target: link,
              targetLabel: 'LINK ĐÃ BỎ QUA',
              countdown: null,
              statDelta: { skipped: 1 },
              historyMessage: `${filterLabel} trả về NEXT cho link ${index + 1}/${queue.length}`,
              historyTag: 'NEXT',
              historyLevel: 'warn'
            });
            S.saveRemovedLink(link);
            S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
            if (index < queue.length - 1) {
              await waitAfterAiNext(index + 1, queue.length, queue[index + 1]);
            }
            continue;
          }

          if (AUTO_COMMENT_AFTER_GENERATE && comment) {
            if (stopForDailyCommentLimitIfReached()) break;
            const commentResponse = await commentToFacebook(link, comment, {
              source: composerContext.mode === 'manual' ? 'manual-automatic' : 'ai'
            });
            if (isDeletedFacebookPostResult(commentResponse)) {
              // Bài đã bị xóa: link đã được chuyển sang danh sách loại bỏ.
              // Chuyển link kế tiếp ngay, không chạy waitAfterLink.
              continue;
            }
            if (composerContext.mode === 'ai') {
              await controller.removeProductLinksUsedInComment?.(comment);
            } else {
              setManualCommentStatus(
                composerContext.manual.random
                  ? `Đã gửi tự động bằng một trong ${composerContext.manual.variants.length} nội dung ngẫu nhiên.`
                  : 'Đã gửi tự động bằng nội dung thủ công cố định.',
                'success'
              );
            }
            S.saveCommentedLink(link);
            S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
            if (stopForDailyCommentLimitIfReached()) break;
          }
        } catch (error) {
          const apifyAborted = error?.code === 'APIFY_ABORTED';
          if (
            apifyAborted
            || isFatalClosedLoopError(error)
            || error?.code === 'PRODUCT_LINKS_EXHAUSTED'
          ) {
            if (!apifyAborted) {
              fatalStopMessage = closedLoopFatalMessage(error);
              S.setBridgeStatus(fatalStopMessage, 'error');
              reportProcess({
                actionKey: `queue-fatal-error-${index + 1}`,
                title: 'Đã dừng chạy tự động do lỗi nghiêm trọng',
                detail: fatalStopMessage,
                status: 'error',
                stage: error?.failureStage === 'comment' ? 'comment' : 'ai',
                ...queueProcessMeta(index + 1, queue.length),
                source: 'Tiến trình tự động',
                target: link,
                targetLabel: 'LINK GẶP LỖI',
                countdown: null,
                statDelta: { errors: 1 },
                historyMessage: `${fatalStopMessage} Giữ nguyên link hiện tại và hàng đợi còn lại.`,
                historyTag: 'STOP',
                historyLevel: 'error'
              });
            }
            S.setClosedLoopRunning(false);
            B.stopClosedLoopBtn?.classList.add('hidden');
            break;
          }

          if (isCaptionFailureError(error)) {
            const reason = captionFailureReason(error);
            S.saveErrorLink(link, reason);
            S.setBridgeStatus(`${reason} ở link ${index + 1}/${queue.length}. Đã chuyển link vào ô Link lỗi và tiếp tục link kế tiếp.`, 'error');
            reportProcess({
              actionKey: `caption-link-error-${index + 1}`,
              title: reason,
              detail: `${error.message || error} Link đã được xóa khỏi hàng đợi hiện tại.`,
              status: 'error',
              stage: 'scan',
              ...queueProcessMeta(index + 1, queue.length),
              source: S.text(error?.code) === 'CAPTION_MISSING' ? 'Link thiếu caption' : 'Facebook Group Link Commenter 1.2.5',
              target: link,
              targetLabel: 'LINK LỖI',
              countdown: null,
              statDelta: { errors: 1 },
              historyMessage: `${reason}: ${link} · đã chuyển vào Link lỗi`,
              historyTag: 'ERROR',
              historyLevel: 'error'
            });
            continue;
          }

          S.setBridgeStatus(`Lỗi ở link hiện tại, đã chuyển link kế tiếp:\n${error.message || error}`, 'error');
          reportProcess({
            actionKey: `queue-link-error-${index + 1}`,
            title: error?.failureStage === 'ai'
              ? `${getAiProviderLabel()} gặp lỗi ở link ${index + 1}/${queue.length}`
              : `Lỗi khi xử lý link ${index + 1}/${queue.length}`,
            detail: error.message || String(error),
            status: 'error',
            stage: error?.failureStage === 'ai' ? 'ai' : 'comment',
            ...queueProcessMeta(index + 1, queue.length),
            source: 'Tiến trình tự động',
            target: link,
            targetLabel: 'LINK GẶP LỖI',
            countdown: null,
            statDelta: error?.autovipCommentHistoryReported ? null : { errors: 1 },
            historyMessage: error?.autovipCommentHistoryReported ? '' : `Link ${index + 1}/${queue.length} gặp lỗi, chuyển link tiếp theo`,
            historyTag: 'ERROR',
            historyLevel: 'error'
          });
          S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
        }

        if (stopForDailyCommentLimitIfReached()) break;
        if (index < queue.length - 1) await waitAfterLink(index + 1, queue.length, queue[index + 1]);
      }
    } finally {
      if (manageLoopState) {
        S.setClosedLoopRunning(false);
        updatePauseButton();
        B.stopClosedLoopBtn?.classList.add('hidden');
      }
    }

    if (!dailyLimitStopMessage && !S.getPostLinks().length) {
      S.setBridgeStatus('Đã xử lý hết link trong ô Link bài viết Facebook.', 'ok');
      reportProcess({
        actionKey: 'queue-complete',
        title: 'Hoàn tất toàn bộ hàng đợi',
        detail: `Đã xử lý xong ${queue.length} link của lượt hiện tại.`,
        status: 'ok',
        stage: 'comment',
        index: queue.length,
        total: queue.length,
        remaining: 0,
        source: 'Hàng đợi',
        target: '',
        targetLabel: 'HÀNG ĐỢI',
        countdown: null,
        historyMessage: `Hoàn tất hàng đợi ${queue.length} link`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
    }
  }

  async function waitBeforeNextGroupScan(cycleIndex, reason = '') {
    const seconds = S.getLoopPauseSeconds();
    const totalMs = seconds * 1000;
    const prefix = S.text(reason) || `Vòng ${cycleIndex} đã xong.`;
    const historyKey = `wait-cycle-${cycleIndex}-${Date.now()}`;
    if (totalMs <= 0) {
      S.setBridgeStatus(`${prefix} Nghỉ 0 giây, quét tiếp ngay...`, 'warn');
      reportProcess({
        actionKey: `wait-cycle-${cycleIndex}`,
        title: 'Chuyển sang vòng tiếp theo',
        detail: prefix,
        status: 'wait',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI VÒNG',
        countdown: 0,
        countdownLabel: 'Quét vòng tiếp theo sau',
        historyMessage: `${prefix} Còn 0 giây · bắt đầu vòng ${cycleIndex + 1}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
      await S.delay(500);
      return;
    }

    let endAt = Date.now() + totalMs;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      endAt += await waitWhileClosedLoopPaused();
      if (!S.isClosedLoopRunning()) break;
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`${prefix} Đang nghỉ ${remainSeconds} giây rồi tự quét vòng tiếp theo...`, 'warn');
      reportProcess({
        actionKey: `wait-cycle-${cycleIndex}`,
        title: 'Nghỉ trước vòng quét tiếp theo',
        detail: prefix,
        status: 'wait',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI VÒNG',
        countdown: remainSeconds,
        countdownLabel: 'Quét vòng tiếp theo sau',
        historyMessage: `${prefix} Chờ ${remainSeconds} giây trước vòng ${cycleIndex + 1}`,
        historyTag: 'WAIT',
        historyLevel: 'warn',
        historyKey,
        historyMode: 'update'
      });
      await S.delay(Math.min(1000, remainMs));
    }

    if (S.isClosedLoopRunning()) {
      reportProcess({
        actionKey: `wait-cycle-${cycleIndex}`,
        title: `Bắt đầu vòng tự động ${cycleIndex + 1}`,
        detail: prefix,
        status: 'running',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI VÒNG',
        countdown: 0,
        countdownLabel: 'Quét vòng tiếp theo sau',
        historyMessage: `${prefix} Còn 0 giây · bắt đầu vòng ${cycleIndex + 1}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
    }
  }

  function resolveClosedLoopScanPlan(scanMethod = currentClosedLoopScanMethod) {
    if (normalizeScanMethod(scanMethod) === 'apify') {
      return {
        mode: 'apify',
        source: 'Apify API',
        allowExtensionFallback: false,
        detail: 'Lấy link và caption bằng Apify API; nếu API lỗi sẽ tự chuyển sang bộ quét thủ công.'
      };
    }
    return {
      mode: 'facebook_v125',
      source: 'Quét thủ công 1.2.5',
      allowExtensionFallback: false,
      detail: 'Quét ngầm link/caption và gửi bình luận bằng cơ chế 1.2.5, không mở tab Facebook.'
    };
  }

  async function runClosedGroupLoop({ scanStrategy = 'manual' } = {}) {
    if (S.isClosedLoopRunning()) return;
    getCommentComposerContext();

    currentClosedLoopScanMethod = normalizeScanMethod(scanStrategy);
    lastRequestedScanMethod = currentClosedLoopScanMethod;
    fatalStopMessage = '';
    dailyLimitStopMessage = '';
    if (stopForDailyCommentLimitIfReached()) return;
    S.setClosedLoopRunning(true);
    S.setClosedLoopPaused(false);
    updatePauseButton();
    B.stopClosedLoopBtn?.classList.remove('hidden');
    let cycleIndex = 1;

    try {
      while (S.isClosedLoopRunning()) {
        await waitWhileClosedLoopPaused();
        if (!S.isClosedLoopRunning()) break;
        if (stopForDailyCommentLimitIfReached()) break;
        let waitReason = `Vòng ${cycleIndex} đã hoàn tất.`;
        try {
          const scanPlan = resolveClosedLoopScanPlan(currentClosedLoopScanMethod);
          reportProcess({
            actionKey: `cycle-${cycleIndex}-start`,
            title: `Khởi chạy vòng tự động ${cycleIndex}`,
            detail: scanPlan.detail,
            status: 'running',
            stage: 'scan',
            cycle: cycleIndex,
            index: 0,
            total: 0,
            remaining: 0,
            source: scanPlan.source,
            target: '',
            targetLabel: 'TRẠNG THÁI VÒNG',
            countdown: null,
            resetStats: true,
            historyMessage: `Bắt đầu vòng tự động ${cycleIndex}`,
            historyTag: 'RUNNING',
            historyLevel: 'running'
          });
          await ensureFacebookAccountBeforeCycle(cycleIndex);
          await waitWhileClosedLoopPaused();
          if (!S.isClosedLoopRunning()) break;
          S.setBridgeStatus(
            `Vòng ${cycleIndex}: ${scanPlan.source} đang lấy link và caption trước khi tự bình luận...`,
            'warn'
          );
          await scanGroupLinks({ method: currentClosedLoopScanMethod });
          await waitWhileClosedLoopPaused();
          if (!S.isClosedLoopRunning()) break;

          const completedScanPlan = resolveClosedLoopScanPlan(currentClosedLoopScanMethod);

          const queuedLinks = S.getPostLinks();
          if (!queuedLinks.length) {
            S.setPostLinks([]);
            waitReason = `Vòng ${cycleIndex} (${completedScanPlan.source}) không có link mới; đây là trạng thái bình thường.`;
          } else {
            S.setBridgeStatus(
              `Vòng ${cycleIndex}: đã lọc xong link bằng ${completedScanPlan.source}. Đang nạp nội dung của link đầu tiên để tự bình luận...`,
              'warn'
            );
            await autoWorkflow({
              manageLoopState: false,
              allowExtensionFallback: completedScanPlan.allowExtensionFallback
            });
            waitReason = `Vòng ${cycleIndex} (${completedScanPlan.source}) đã xử lý xong hàng đợi.`;
          }
        } catch (error) {
          if (error?.code === 'APIFY_ABORTED') {
            S.setClosedLoopRunning(false);
            break;
          }
          if (isFatalClosedLoopError(error)) {
            fatalStopMessage = closedLoopFatalMessage(error);
            S.setClosedLoopRunning(false);
            S.setBridgeStatus(fatalStopMessage, 'error');
            break;
          }

          S.setPostCaptions([]);
          S.setPostCommentCounts([]);
          S.setPostLinks([]);
          waitReason = `Vòng ${cycleIndex} gặp lỗi tạm thời: ${error.message || error}. Tiến trình vẫn tiếp tục.`;
          S.setBridgeStatus(waitReason, 'warn');
          reportProcess({
            actionKey: `cycle-${cycleIndex}-temporary-error`,
            title: `Vòng ${cycleIndex} gặp lỗi tạm thời`,
            detail: error.message || String(error),
            status: 'error',
            stage: 'scan',
            cycle: cycleIndex,
            source: 'Vòng tự động',
            target: '',
            targetLabel: 'LỖI TẠM THỜI',
            countdown: null,
            statDelta: { errors: 1 },
            historyMessage: `Vòng ${cycleIndex} gặp lỗi tạm thời, vẫn tiếp tục`,
            historyTag: 'ERROR',
            historyLevel: 'error'
          });
        }

        if (!S.isClosedLoopRunning()) break;
        await waitBeforeNextGroupScan(cycleIndex, waitReason);
        cycleIndex += 1;
      }
    } finally {
      S.setClosedLoopRunning(false);
      updatePauseButton();
      B.stopClosedLoopBtn?.classList.add('hidden');
      if (fatalStopMessage) S.setBridgeStatus(fatalStopMessage, 'error');
      else if (dailyLimitStopMessage) S.setBridgeStatus(dailyLimitStopMessage, 'ok');
      else S.setBridgeStatus('Vòng lặp đã dừng.', 'warn');
      reportProcess({
        actionKey: 'closed-loop-stopped',
        title: fatalStopMessage
          ? 'Vòng tự động đã dừng do lỗi'
          : dailyLimitStopMessage
            ? 'Vòng tự động đã dừng do đạt giới hạn ngày'
            : 'Vòng tự động đã dừng',
        detail: fatalStopMessage || dailyLimitStopMessage || 'Tiến trình đã nhận lệnh dừng và kết thúc an toàn.',
        status: fatalStopMessage ? 'error' : 'stop',
        stage: 'scan',
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI HỆ THỐNG',
        countdown: null,
        historyMessage: fatalStopMessage
          ? 'Vòng tự động dừng do lỗi nghiêm trọng'
          : dailyLimitStopMessage
            ? 'Vòng tự động dừng do đã đạt giới hạn bình luận trong ngày'
            : 'Vòng tự động đã dừng',
        historyTag: fatalStopMessage ? 'ERROR' : 'STOP',
        historyLevel: fatalStopMessage ? 'error' : dailyLimitStopMessage ? 'ok' : 'warn'
      });
    }
  }

  async function runBridgeTask(task) {
    if (S.isBridgeBusy()) {
      S.setBridgeStatus('Đang có tác vụ chạy, vui lòng đợi tác vụ hiện tại hoàn tất.', 'warn');
      return;
    }
    S.setBridgeBusy(true);
    [B.dashboardApiRunBtn, B.dashboardManualRunBtn, B.facebookScanBtn, B.autoWorkflowBtn, B.commentCurrentTabBtn]
      .forEach(btn => { if (btn) btn.disabled = true; });
    try {
      return await task();
    } finally {
      S.setBridgeBusy(false);
      [B.dashboardApiRunBtn, B.dashboardManualRunBtn, B.facebookScanBtn, B.autoWorkflowBtn, B.commentCurrentTabBtn]
        .forEach(btn => { if (btn) btn.disabled = false; });
    }
  }

  function wireSecretToggle(input, toggle, label) {
    if (!input || !toggle) return;
    toggle.addEventListener('click', () => {
      const isTextarea = input.tagName === 'TEXTAREA';
      const wasHidden = isTextarea
        ? input.classList.contains('masked-api-keys')
        : input.type === 'password';
      if (isTextarea) input.classList.toggle('masked-api-keys', !wasHidden);
      else input.type = wasHidden ? 'text' : 'password';
      toggle.textContent = wasHidden ? 'Ẩn' : 'Hiện';
      toggle.setAttribute('aria-label', wasHidden ? `Ẩn ${label}` : `Hiện ${label}`);
      toggle.title = wasHidden ? `Ẩn ${label}` : `Hiện ${label}`;
    });
  }

  function wireBridge() {
    S.addInputSave(B.facebookCookiesInput, S.STORE.facebookCookies);
    S.wireCommentCountBypassInput();
    S.wireFilterSellingPostsToggle();
    S.addInputSave(B.fbGroupIdInput, S.STORE.groupIds);
    S.addInputSave(B.groupLimitInput, S.STORE.groupLimit);
    S.addInputSave(B.scanSourceModeSelect, S.STORE.scanSourceMode);
    S.wireApifyActorIdInput();
    S.wireApifyTokensInput();
    wireSecretToggle(B.apifyApiTokenInput, B.apifyApiTokenToggle, 'Apify API key');
    S.addInputSave(B.loopPauseSecondsInput, S.STORE.loopPauseSeconds);
    if (B.loopPauseSecondsInput && !B.loopPauseSecondsInput.value) {
      const oldMinutes = S.load(S.STORE.oldLoopPauseMinutes, null);
      if (oldMinutes !== null && oldMinutes !== '') B.loopPauseSecondsInput.value = String(Math.round(S.clampNumber(oldMinutes, 5, 0, 1440)) * 60);
    }
    S.addInputSave(B.linkPauseSecondsInput, S.STORE.linkPauseSeconds);
    S.addInputSave(B.dailyCommentLimitInput, S.STORE.dailyCommentLimit);
    B.dailyCommentLimitInput?.addEventListener('input', S.renderDailyCommentLimitStatus);
    B.dailyCommentLimitInput?.addEventListener('change', S.renderDailyCommentLimitStatus);
    S.wirePostLinksInput();
    wireManualCommentForm();
    S.getScanSourceMode();
    S.getApifyActorId();
    S.getApifyTokens();
    S.getGroupLimit();
    S.getLoopPauseSeconds();
    S.getLinkPauseSeconds();
    S.renderDailyCommentLimitStatus();
    S.renderCommentedLinks();
    S.renderRemovedLinks();
    S.renderErrorLinks();

    B.facebookLogoutBtn?.addEventListener('click', () => {
      logoutFacebookAccount().catch(() => {});
    });
    const refreshWhenReady = () => {
      if (API.bridgeAvailable() && document.documentElement.dataset.tqtLicenseAuthorized === 'true') {
        refreshFacebookAccount({ silent: true });
      }
    };
    window.addEventListener('focus', refreshWhenReady);
    window.addEventListener('tqt:license-authorized', refreshWhenReady);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshWhenReady(); });
    window.setTimeout(refreshWhenReady, 150);
    window.setInterval(() => { if (!document.hidden) refreshWhenReady(); }, 2000);
    window.addEventListener('tqt:license-denied', event => {
      if (!S.isClosedLoopRunning()) return;
      activeApifyAbortController?.abort();
      S.setClosedLoopRunning(false);
      S.setClosedLoopPaused(false);
      fatalStopMessage = event.detail?.message || 'KEY chưa được cấp quyền. Kiểm tra lại KEY trước khi chạy.';
      updatePauseButton();
      S.setBridgeStatus(fatalStopMessage, 'error');
    });
    window.addEventListener('autovip:bridge-status', event => {
      if (event.detail?.connected || !S.isClosedLoopRunning()) return;
      activeApifyAbortController?.abort();
      S.setClosedLoopRunning(false);
      S.setClosedLoopPaused(false);
      fatalStopMessage = 'Mất kết nối extension. Kiểm tra kết quả bình luận hiện tại trước khi chạy lại.';
      updatePauseButton();
      S.setBridgeStatus(fatalStopMessage, 'error');
    });

    B.facebookScanBtn?.addEventListener('click', () => runBridgeTask(
      () => runClosedGroupLoop({ scanStrategy: 'manual' })
    ).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.dashboardApiRunBtn?.addEventListener('click', () => runBridgeTask(
      () => runClosedGroupLoop({ scanStrategy: 'apify' })
    ).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.dashboardManualRunBtn?.addEventListener('click', () => runBridgeTask(
      () => runClosedGroupLoop({ scanStrategy: 'manual' })
    ).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.scanGroupLinksBtn?.addEventListener('click', () => {
      if (!S.isClosedLoopRunning()) {
        S.setBridgeStatus('Chạy Tự Động chưa hoạt động nên chưa thể tạm dừng.', 'warn');
        return;
      }
      const nextPausedState = !S.isClosedLoopPaused();
      S.setClosedLoopPaused(nextPausedState);
      updatePauseButton();
      S.setBridgeStatus(
        nextPausedState
          ? 'Đang hoàn tất bước hiện tại rồi tạm dừng Chạy Tự Động...'
          : 'Đã nhận lệnh tiếp tục Chạy Tự Động.',
        nextPausedState ? 'warn' : 'ok'
      );
    });
    B.autoWorkflowBtn?.addEventListener('click', () => runBridgeTask(() => autoWorkflow()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.commentCurrentTabBtn?.addEventListener('click', () => runBridgeTask(() => commentCurrentTab()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.stopClosedLoopBtn?.addEventListener('click', () => {
      activeApifyAbortController?.abort();
      S.setClosedLoopRunning(false);
      updatePauseButton();
      B.stopClosedLoopBtn.classList.add('hidden');
      S.setBridgeStatus('Đã dừng vòng lặp.', 'warn');
    });
    updatePauseButton();
    B.clearCommentedLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ danh sách link đã bình luận thành công?')) return;
      S.save(S.STORE.commented, []);
      S.renderCommentedLinks();
      S.setBridgeStatus('Đã xoá danh sách link đã bình luận thành công.', 'ok');
    });
    B.clearRemovedLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ danh sách link đã loại bỏ?')) return;
      S.save(S.STORE.removed, []);
      S.renderRemovedLinks();
      S.setBridgeStatus('Đã xoá danh sách link đã loại bỏ.', 'ok');
    });
    B.clearErrorLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ danh sách link lỗi caption?')) return;
      S.save(S.STORE.captionErrors, []);
      S.renderErrorLinks();
      S.setBridgeStatus('Đã xoá danh sách link lỗi caption.', 'ok');
    });
  }

  window.addEventListener('DOMContentLoaded', wireBridge);
  window.fbBridgeController = {
    scanGroupLinks,
    scanGroupLinksByApify,
    scanGroupLinksByExtension,
    resolveClosedLoopScanPlan,
    runClosedGroupLoop,
    readFirstFacebookPost,
    loadArticleForLink,
    autoWorkflow,
    commentCurrentTab,
    getCommentComposerMode,
    parseManualCommentInput,
    pickManualComment,
    refreshFacebookAccount,
    logoutFacebookAccount,
    ensureFacebookAccountBeforeCycle
  };
}());
