(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);

  const B = {
    facebookAccountBar: $('#facebookAccountBar'),
    facebookNameDisplay: $('#facebookNameDisplay'),
    facebookUidDisplay: $('#facebookUidDisplay'),
    facebookLogoutBtn: $('#facebookLogoutBtn'),
    facebookCookiesInput: $('#facebookCookiesInput'),
    fbGroupIdInput: $('#fbGroupIdInput'),
    groupLimitInput: $('#groupLimitInput'),
    scanSourceModeSelect: $('#scanSourceModeSelect'),
    commentCountBypassInput: $('#commentCountBypassInput'),
    commentCountBypassState: $('#commentCountBypassState'),
    filterSellingPostsCheckbox: $('#filterSellingPostsCheckbox'),
    filterSellingPostsState: $('#filterSellingPostsState'),
    loopPauseSecondsInput: $('#loopPauseSecondsInput'),
    linkPauseSecondsInput: $('#linkPauseSecondsInput'),
    dailyCommentLimitInput: $('#dailyCommentLimitInput'),
    dailyCommentLimitStatus: $('#dailyCommentLimitStatus'),
    apifyActorIdInput: $('#apifyActorIdInput'),
    apifyApiTokenInput: $('#apifyApiTokenInput'),
    apifyApiTokenToggle: $('#apifyApiTokenToggle'),
    apifyApiFailoverStatus: $('#apifyApiFailoverStatus'),
    fbPostLinkInput: $('#fbPostLinkInput'),
    fbPostLinkCounter: $('#fbPostLinkCounter'),
    dashboardApiRunBtn: $('#dashboardApiRunBtn'),
    dashboardManualRunBtn: $('#dashboardManualRunBtn'),
    scanGroupLinksBtn: $('#scanGroupLinksBtn'),
    facebookScanBtn: $('#apifyScanBtn'),
    stopClosedLoopBtn: $('#stopClosedLoopBtn'),
    autoWorkflowBtn: $('#autoWorkflowBtn'),
    commentCurrentTabBtn: $('#commentCurrentTabBtn'),
    composerAiTab: $('#composerAiTab'),
    composerManualTab: $('#composerManualTab'),
    composerAiPanel: $('#composerAiPanel'),
    composerManualPanel: $('#composerManualPanel'),
    composerOutput: $('#composerOutput'),
    manualCommentInput: $('#manualCommentInput'),
    manualCommentCounter: $('#manualCommentCounter'),
    manualCommentStatus: $('#manualCommentStatus'),
    bridgeStatus: $('#bridgeStatus'),
    articleInput: $('#articleInput'),
    output: $('#output'),
    fbMaxChars: $('#fbMaxChars'),
    clearCommentedLinksBtn: $('#clearCommentedLinksBtn'),
    commentedLinksBox: $('#commentedLinksBox'),
    commentedCountStat: $('#commentedCountStat'),
    commentedReviewList: $('#commentedReviewList'),
    commentedReviewCount: $('#commentedReviewCount'),
    footerCommentedCount: $('#footerCommentedCount'),
    clearRemovedLinksBtn: $('#clearRemovedLinksBtn'),
    removedLinksBox: $('#removedLinksBox'),
    removedCountStat: $('#removedCountStat'),
    removedReviewList: $('#removedReviewList'),
    removedReviewCount: $('#removedReviewCount'),
    footerRemovedCount: $('#footerRemovedCount'),
    clearErrorLinksBtn: $('#clearErrorLinksBtn'),
    errorLinksBox: $('#errorLinksBox'),
    errorCountStat: $('#errorCountStat'),
    errorReviewList: $('#errorReviewList'),
    errorReviewCount: $('#errorReviewCount'),
    footerErrorCount: $('#footerErrorCount')
  };

  const STORE = {
    facebookCookies: 'truong_fb_bridge_facebook_cookies_v1',
    groupIds: 'truong_fb_bridge_group_ids_v1',
    groupLimit: 'truong_fb_bridge_group_limit_v1',
    scanSourceMode: 'truong_fb_bridge_scan_source_mode_v1',
    commentCountBypassThreshold: 'truong_fb_bridge_comment_count_bypass_threshold_v1',
    filterSellingPostsEnabled: 'truong_fb_bridge_filter_selling_posts_enabled_v2',
    loopPauseSeconds: 'truong_fb_bridge_loop_pause_seconds_v1',
    oldLoopPauseMinutes: 'truong_fb_bridge_loop_pause_minutes_v1',
    linkPauseSeconds: 'truong_fb_bridge_link_pause_seconds_v1',
    dailyCommentLimit: 'truong_fb_bridge_daily_comment_limit_v1',
    apifyActorId: 'truong_fb_bridge_apify_actor_id_v1',
    apifyToken: 'truong_fb_bridge_apify_token_v1',
    apifyTokens: 'truong_fb_bridge_apify_tokens_v1',
    apifyActiveTokenIndex: 'truong_fb_bridge_apify_active_token_index_v1',
    apifyLocalOnlyMigration: 'truong_fb_bridge_apify_local_only_migration_v1',
    dailyProcessStats: 'truong_fb_dashboard_daily_process_stats_v1',
    commentComposerMode: 'truong_fb_comment_composer_mode_v1',
    manualCommentText: 'truong_fb_manual_comment_text_v1',
    postLinks: 'truong_fb_bridge_post_links_v1',
    postCaptions: 'truong_fb_bridge_post_captions_v1',
    postCommentCounts: 'truong_fb_bridge_post_comment_counts_v1',
    commented: 'truong_fb_bridge_commented_links_v1',
    removed: 'truong_fb_bridge_removed_links_v1',
    captionErrors: 'truong_fb_bridge_caption_error_links_v1',
    dailyLinkStats: 'truong_fb_bridge_daily_link_stats_v1'
  };

  const HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
  const APIFY_DEFAULT_ACTOR_ID = 'caprolok~facebook-groups-scraper';
  let apifyActorInputWired = false;
  let apifyTokensInputWired = false;

  const bridgeState = {
    closedLoopRunning: false,
    closedLoopPaused: false,
    bridgeBusy: false,
    processStatus: null,
    processSerial: 0,
    historyRetentionTimer: null
  };

  try {
    localStorage.removeItem('truong_fb_bridge_extension_id_v1');
    localStorage.removeItem('truong_fb_bridge_keep_facebook_login_on_spam_v1');
    localStorage.removeItem('truong_fb_bridge_filter_selling_posts_v1');
  } catch {}

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }

  function text(value) {
    return String(value || '').trim();
  }

  function clampNumber(value, fallback, min, max) {
    if (String(value ?? '').trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }


  function getScanSourceMode() {
    const allowed = new Set(['group_latest', 'group_top']);
    const raw = String(B.scanSourceModeSelect?.value || load(STORE.scanSourceMode, 'group_latest') || 'group_latest');
    const value = allowed.has(raw) ? raw : 'group_latest';
    if (B.scanSourceModeSelect) B.scanSourceModeSelect.value = value;
    save(STORE.scanSourceMode, value);
    return value;
  }

  function getGroupLimit() {
    const value = Math.round(clampNumber(B.groupLimitInput?.value, 5, 1, 50));
    if (B.groupLimitInput) B.groupLimitInput.value = String(value);
    save(STORE.groupLimit, B.groupLimitInput?.value || String(value));
    return value;
  }

  function getLoopPauseSeconds() {
    let fallback = 240;
    const savedSeconds = load(STORE.loopPauseSeconds, null);
    if (savedSeconds === null) {
      const oldMinutes = load(STORE.oldLoopPauseMinutes, null);
      if (oldMinutes !== null && oldMinutes !== '') fallback = Math.round(clampNumber(oldMinutes, 5, 0, 1440)) * 60;
    }
    const value = Math.round(clampNumber(B.loopPauseSecondsInput?.value, fallback, 0, 86400));
    if (B.loopPauseSecondsInput) B.loopPauseSecondsInput.value = String(value);
    save(STORE.loopPauseSeconds, B.loopPauseSecondsInput?.value || String(value));
    return value;
  }

  function getLinkPauseSeconds() {
    const value = Math.round(clampNumber(B.linkPauseSecondsInput?.value, 60, 0, 86400));
    if (B.linkPauseSecondsInput) B.linkPauseSecondsInput.value = String(value);
    save(STORE.linkPauseSeconds, B.linkPauseSecondsInput?.value || String(value));
    return value;
  }

  function normalizeSupportedApifyActorId(actorId) {
    const api = window.apifyGroupsApi;
    const fallback = api?.DEFAULT_ACTOR_ID || APIFY_DEFAULT_ACTOR_ID;
    try {
      const normalized = api?.normalizeActorId?.(actorId) || fallback;
      return api?.SUPPORTED_ACTORS?.some(actor => actor.id === normalized)
        ? normalized
        : fallback;
    } catch {
      return fallback;
    }
  }

  function getApifyActorId() {
    const raw = B.apifyActorIdInput?.value || load(STORE.apifyActorId, APIFY_DEFAULT_ACTOR_ID);
    const value = normalizeSupportedApifyActorId(raw);
    if (B.apifyActorIdInput) B.apifyActorIdInput.value = value;
    save(STORE.apifyActorId, value);
    return value;
  }

  function setApifyActorId(actorId) {
    const value = normalizeSupportedApifyActorId(actorId);
    if (B.apifyActorIdInput) B.apifyActorIdInput.value = value;
    save(STORE.apifyActorId, value);
    return value;
  }

  function wireApifyActorIdInput() {
    const value = setApifyActorId(load(STORE.apifyActorId, APIFY_DEFAULT_ACTOR_ID));
    if (B.apifyActorIdInput && !apifyActorInputWired) {
      B.apifyActorIdInput.addEventListener('change', () => {
        setApifyActorId(B.apifyActorIdInput.value);
      });
      apifyActorInputWired = true;
    }
    return value;
  }

  function normalizeApifyTokens(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
    const tokens = [];
    const seen = new Set();
    for (const item of source) {
      const token = String(item || '').trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
    return tokens;
  }

  function purgeRemoteApifyCredentialsOnce() {
    if (load(STORE.apifyLocalOnlyMigration, false)) return;
    localStorage.removeItem(STORE.apifyToken);
    localStorage.removeItem(STORE.apifyTokens);
    localStorage.removeItem(STORE.apifyActiveTokenIndex);
    save(STORE.apifyLocalOnlyMigration, true);
  }

  function getStoredApifyTokens() {
    const storedTokens = normalizeApifyTokens(load(STORE.apifyTokens, []));
    if (storedTokens.length) return storedTokens;
    return normalizeApifyTokens(load(STORE.apifyToken, ''));
  }

  function saveApifyTokens(tokens) {
    const normalized = normalizeApifyTokens(tokens);
    save(STORE.apifyTokens, normalized);
    // Giữ khoá cũ để nâng cấp không làm mất token đã lưu ở phiên bản trước.
    save(STORE.apifyToken, normalized[0] || '');
    return normalized;
  }

  function getApifyTokens() {
    const source = B.apifyApiTokenInput && apifyTokensInputWired
      ? B.apifyApiTokenInput.value
      : getStoredApifyTokens();
    return saveApifyTokens(source);
  }

  function getApifyActiveTokenIndex(tokens = getApifyTokens()) {
    if (!tokens.length) return -1;
    const storedIndex = Number.parseInt(load(STORE.apifyActiveTokenIndex, 0), 10);
    const index = Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < tokens.length
      ? storedIndex
      : 0;
    save(STORE.apifyActiveTokenIndex, index);
    return index;
  }

  function setApifyActiveTokenIndex(index, tokens = getApifyTokens()) {
    if (!tokens.length) {
      save(STORE.apifyActiveTokenIndex, 0);
      return -1;
    }
    const numericIndex = Number(index);
    const nextIndex = Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < tokens.length
      ? numericIndex
      : 0;
    save(STORE.apifyActiveTokenIndex, nextIndex);
    return nextIndex;
  }

  function getApifyToken() {
    const tokens = getApifyTokens();
    const index = getApifyActiveTokenIndex(tokens);
    return index >= 0 ? tokens[index] : '';
  }

  function setApifyFailoverStatus(message) {
    if (!B.apifyApiFailoverStatus) return;
    const value = String(message || '').trim();
    B.apifyApiFailoverStatus.textContent = value;
    B.apifyApiFailoverStatus.classList.toggle('hidden', !value);
  }

  function updateApifyFailoverStatus(tokens = getApifyTokens()) {
    if (tokens.length) getApifyActiveTokenIndex(tokens);
    setApifyFailoverStatus('');
  }

  function wireApifyTokensInput() {
    purgeRemoteApifyCredentialsOnce();
    const storedTokens = getStoredApifyTokens();
    if (B.apifyApiTokenInput) B.apifyApiTokenInput.value = storedTokens.join('\n');
    apifyTokensInputWired = true;
    const persist = () => {
      const tokens = getApifyTokens();
      setApifyActiveTokenIndex(getApifyActiveTokenIndex(tokens), tokens);
      updateApifyFailoverStatus(tokens);
    };
    const normalizeAndPersist = () => {
      const tokens = getApifyTokens();
      if (B.apifyApiTokenInput) B.apifyApiTokenInput.value = tokens.join('\n');
      setApifyActiveTokenIndex(getApifyActiveTokenIndex(tokens), tokens);
      updateApifyFailoverStatus(tokens);
    };
    B.apifyApiTokenInput?.addEventListener('input', persist);
    B.apifyApiTokenInput?.addEventListener('change', normalizeAndPersist);
    persist();
    return storedTokens;
  }

  function setBridgeStatus(message, type = '') {
    if (!B.bridgeStatus) return;
    const isHiddenSource = B.bridgeStatus.classList.contains('automation-status-source');
    B.bridgeStatus.textContent = message;
    B.bridgeStatus.className = (isHiddenSource ? 'automation-status-source hidden' : 'automation-status') + (type ? ' ' + type : '');
  }

  function reportProcess(detail = {}) {
    const payload = detail && typeof detail === 'object' ? detail : {};
    bridgeState.processSerial += 1;
    const next = {
      ...(bridgeState.processStatus || {}),
      ...payload,
      historyMessage: payload.historyMessage || '',
      historyTag: payload.historyTag || '',
      historyLevel: payload.historyLevel || '',
      historyKey: payload.historyKey || '',
      historyMode: payload.historyMode || '',
      statDelta: payload.statDelta && typeof payload.statDelta === 'object' ? payload.statDelta : null,
      resetStats: payload.resetStats === true,
      sequence: bridgeState.processSerial,
      timestamp: Date.now()
    };
    bridgeState.processStatus = next;
    window.dispatchEvent(new CustomEvent('autovip:process', { detail: next }));
    return next;
  }

  function getProcessStatus() {
    return bridgeState.processStatus ? { ...bridgeState.processStatus } : null;
  }

  function addInputSave(el, key) {
    if (!el) return;
    el.value = load(key, '') || '';
    const persist = () => save(key, el.value);
    el.addEventListener('input', persist);
    el.addEventListener('change', persist);
  }

  function getCommentCountBypassThreshold() {
    const stored = Number(load(STORE.commentCountBypassThreshold, 0)) >= 1 ? 1 : 0;
    const value = B.commentCountBypassInput
      ? (B.commentCountBypassInput.checked ? 1 : 0)
      : stored;
    if (B.commentCountBypassInput) B.commentCountBypassInput.value = String(value);
    if (B.commentCountBypassState) {
      B.commentCountBypassState.textContent = value ? 'Đang bật' : 'Đang tắt';
      B.commentCountBypassState.dataset.state = value ? 'on' : 'off';
    }
    save(STORE.commentCountBypassThreshold, value);
    return value;
  }

  function wireCommentCountBypassInput() {
    if (!B.commentCountBypassInput) return getCommentCountBypassThreshold();
    B.commentCountBypassInput.checked = Number(load(STORE.commentCountBypassThreshold, 0)) >= 1;
    const persist = () => getCommentCountBypassThreshold();
    B.commentCountBypassInput.addEventListener('change', persist);
    return persist();
  }

  function renderFilterSellingPostsState(enabled) {
    const isEnabled = enabled !== false;
    if (B.filterSellingPostsState) {
      B.filterSellingPostsState.textContent = isEnabled ? 'Đang bật' : 'Đang tắt';
      B.filterSellingPostsState.dataset.state = isEnabled ? 'on' : 'off';
    }
    return isEnabled;
  }

  function getFilterSellingPostsEnabled() {
    const stored = load(STORE.filterSellingPostsEnabled, true) !== false;
    const enabled = B.filterSellingPostsCheckbox
      ? B.filterSellingPostsCheckbox.checked
      : stored;
    save(STORE.filterSellingPostsEnabled, enabled);
    return renderFilterSellingPostsState(enabled);
  }

  function wireFilterSellingPostsToggle() {
    if (!B.filterSellingPostsCheckbox) return getFilterSellingPostsEnabled();
    B.filterSellingPostsCheckbox.checked = load(STORE.filterSellingPostsEnabled, true) !== false;
    const persist = () => getFilterSellingPostsEnabled();
    B.filterSellingPostsCheckbox.addEventListener('change', persist);
    return persist();
  }

  function parseLines(raw) {
    return String(raw || '')
      .split(/[\n,]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function normalizeUrl(raw) {
    try {
      const url = new URL(String(raw).trim());
      url.hash = '';
      url.protocol = 'https:';
      url.hostname = url.hostname.toLowerCase().replace(/^(?:facebook\.com|(?:m|mbasic|web)\.facebook\.com)$/i, 'www.facebook.com');

      const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      const groupPostMatch = pathname.match(/^\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)$/i);
      if (url.hostname === 'www.facebook.com' && groupPostMatch?.[1] && groupPostMatch?.[2]) {
        const encodePart = value => {
          try {
            return encodeURIComponent(decodeURIComponent(value));
          } catch {
            return encodeURIComponent(value);
          }
        };
        const groupId = encodePart(groupPostMatch[1]);
        const postId = encodePart(groupPostMatch[2]);
        return `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
      }

      url.pathname = pathname;
      const drop = ['fbclid', 'mibextid', '__cft__', '__tn__', 'ref', 'refid', 'paipv'];
      drop.forEach(key => url.searchParams.delete(key));
      return url.toString();
    } catch {
      return String(raw || '').trim();
    }
  }

  function isGroupPermalinkUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      const hostname = url.hostname.toLowerCase().replace(/^(m|mbasic|web)\.facebook\.com$/i, 'www.facebook.com');
      const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      return hostname === 'www.facebook.com'
        && /^\/groups\/[^/?#]+\/permalink\/[^/?#]+$/i.test(pathname);
    } catch {
      return false;
    }
  }

  function uniqueLinks(lines) {
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const clean = normalizeUrl(line);
      if (!clean || !isGroupPermalinkUrl(clean) || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  }

  function normalizeSavedAt(value, fallback = Date.now()) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
  }

  function getTimedHistoryEntries(storageKey, { defaultReason = null } = {}) {
    const stored = load(storageKey, []);
    const source = Array.isArray(stored) ? stored : [];
    const now = Date.now();
    const entries = [];
    const seen = new Set();

    for (const item of source) {
      const rawLink = typeof item === 'string' ? item : (item?.link || item?.url || '');
      const link = normalizeUrl(rawLink);
      if (!link || !isGroupPermalinkUrl(link) || seen.has(link)) continue;

      const savedAt = normalizeSavedAt(typeof item === 'object' && item ? item.savedAt : null, now);
      if ((now - savedAt) >= HISTORY_RETENTION_MS) continue;

      const entry = { link, savedAt };
      if (defaultReason !== null) {
        entry.reason = text(typeof item === 'object' && item ? item.reason : '') || defaultReason;
      }
      entries.push(entry);
      seen.add(link);
    }

    if (JSON.stringify(source) !== JSON.stringify(entries)) save(storageKey, entries);
    return entries;
  }

  function getCommentedEntries() {
    return getTimedHistoryEntries(STORE.commented);
  }

  function getCommentedLinks() {
    return getCommentedEntries().map(entry => entry.link);
  }

  function getLocalDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getDailyProcessStats() {
    const date = getLocalDayKey();
    const stored = load(STORE.dailyProcessStats, null);
    if (!stored || stored.date !== date) {
      return { date, success: 0, skipped: 0, errors: 0 };
    }
    return {
      date,
      success: Math.max(0, Math.floor(Number(stored.success) || 0)),
      skipped: Math.max(0, Math.floor(Number(stored.skipped) || 0)),
      errors: Math.max(0, Math.floor(Number(stored.errors) || 0))
    };
  }

  function addDailyProcessStats(delta) {
    if (!delta || typeof delta !== 'object') return getDailyProcessStats();
    const stats = getDailyProcessStats();
    stats.success += Math.max(0, Math.floor(Number(delta.success) || 0));
    stats.skipped += Math.max(0, Math.floor(Number(delta.skipped) || 0));
    stats.errors += Math.max(0, Math.floor(Number(delta.errors) || 0));
    save(STORE.dailyProcessStats, stats);
    return stats;
  }

  function getDailyCommentLimit() {
    const savedValue = load(STORE.dailyCommentLimit, 0);
    const value = Math.round(clampNumber(B.dailyCommentLimitInput?.value, savedValue, 0, 100000));
    if (B.dailyCommentLimitInput) B.dailyCommentLimitInput.value = String(value);
    save(STORE.dailyCommentLimit, value);
    return value;
  }

  function getDailyCommentLimitState() {
    const limit = getDailyCommentLimit();
    const stats = getDailyProcessStats();
    return {
      date: stats.date,
      limit,
      success: stats.success,
      remaining: limit > 0 ? Math.max(0, limit - stats.success) : null,
      reached: limit > 0 && stats.success >= limit
    };
  }

  function renderDailyCommentLimitStatus() {
    const state = getDailyCommentLimitState();
    if (!B.dailyCommentLimitStatus) return state;
    B.dailyCommentLimitStatus.dataset.state = state.reached ? 'reached' : '';
    B.dailyCommentLimitStatus.textContent = state.limit > 0
      ? state.reached
        ? `Hôm nay đã thành công ${state.success}/${state.limit} bình luận · Đã đạt giới hạn.`
        : `Hôm nay đã thành công ${state.success}/${state.limit} bình luận · Còn ${state.remaining}.`
      : `Hôm nay đã thành công ${state.success} bình luận · Không giới hạn.`;
    return state;
  }

  function getDailyLinkStats() {
    const today = getLocalDayKey();
    const stored = load(STORE.dailyLinkStats, {});
    const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const normalizeList = value => uniqueLinks(Array.isArray(value) ? value : []);

    if (raw.date !== today) {
      return {
        date: today,
        commented: [],
        removed: [],
        errors: []
      };
    }

    return {
      date: today,
      commented: normalizeList(raw.commented),
      removed: normalizeList(raw.removed),
      errors: normalizeList(raw.errors)
    };
  }

  function renderDailyLinkStats() {
    const stats = getDailyLinkStats();
    if (B.footerCommentedCount) B.footerCommentedCount.textContent = String(stats.commented.length);
    if (B.footerRemovedCount) B.footerRemovedCount.textContent = String(stats.removed.length);
    if (B.footerErrorCount) B.footerErrorCount.textContent = String(stats.errors.length);
  }

  function saveDailyLinkStat(type, link) {
    const clean = normalizeUrl(link);
    if (!clean) return false;

    const stats = getDailyLinkStats();
    const key = type === 'commented' || type === 'removed' || type === 'errors' ? type : '';
    if (!key || stats[key].includes(clean)) return false;

    stats[key].unshift(clean);
    save(STORE.dailyLinkStats, stats);
    renderDailyLinkStats();
    return true;
  }

  function renderRecordReviewLinks(container, counter, entries, emptyMessage) {
    const records = Array.isArray(entries) ? entries : [];
    if (counter) counter.textContent = String(records.length);
    if (!container) return;

    const previousScrollTop = container.scrollTop;
    const fragment = document.createDocumentFragment();

    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'record-link-empty';
      empty.textContent = emptyMessage;
      fragment.append(empty);
    }

    for (const entry of records) {
      const link = normalizeUrl(typeof entry === 'string' ? entry : entry?.link);
      if (!link || !isGroupPermalinkUrl(link)) continue;

      const item = document.createElement('div');
      item.className = 'record-link-item';
      item.setAttribute('role', 'listitem');

      const content = document.createElement('div');
      content.className = 'record-link-content';

      const address = document.createElement('span');
      address.className = 'record-link-url';
      address.textContent = link;
      content.append(address);

      const reason = text(typeof entry === 'object' && entry ? entry.reason : '');
      if (reason) {
        const detail = document.createElement('span');
        detail.className = 'record-link-reason';
        detail.textContent = reason;
        content.append(detail);
      }

      const viewButton = document.createElement('a');
      viewButton.className = 'secondary-button small-button record-link-view';
      viewButton.href = link;
      viewButton.target = '_blank';
      viewButton.rel = 'noopener noreferrer';
      viewButton.title = 'Mở bài viết Facebook trong tab mới';
      viewButton.setAttribute('aria-label', 'Xem bài viết Facebook trong tab mới');
      viewButton.textContent = 'Xem';

      item.append(content, viewButton);
      fragment.append(item);
    }

    container.replaceChildren(fragment);
    container.scrollTop = previousScrollTop;
  }

  function renderCommentedLinks() {
    const entries = getCommentedEntries();
    const list = entries.map(entry => entry.link);
    if (B.commentedLinksBox) B.commentedLinksBox.value = list.join('\n');
    if (B.commentedCountStat) B.commentedCountStat.textContent = String(list.length);
    renderRecordReviewLinks(B.commentedReviewList, B.commentedReviewCount, entries, 'Chưa có bài đã bình luận.');
    renderDailyLinkStats();
    scheduleHistoryRetentionCleanup();
  }

  function getRemovedEntries() {
    return getTimedHistoryEntries(STORE.removed);
  }

  function getRemovedLinks() {
    return getRemovedEntries().map(entry => entry.link);
  }

  function renderRemovedLinks() {
    const entries = getRemovedEntries();
    const list = entries.map(entry => entry.link);
    if (B.removedLinksBox) B.removedLinksBox.value = list.join('\n');
    if (B.removedCountStat) B.removedCountStat.textContent = String(list.length);
    renderRecordReviewLinks(B.removedReviewList, B.removedReviewCount, entries, 'Chưa có bài đã loại bỏ.');
    renderDailyLinkStats();
    scheduleHistoryRetentionCleanup();
  }

  function getErrorLinkEntries() {
    return getTimedHistoryEntries(STORE.captionErrors, {
      defaultReason: 'Không đọc được caption'
    });
  }

  function getErrorLinks() {
    return getErrorLinkEntries().map(entry => entry.link);
  }

  function renderErrorLinks() {
    const entries = getErrorLinkEntries();
    if (B.errorLinksBox) {
      B.errorLinksBox.value = entries
        .map(entry => `${entry.link} | ${entry.reason}`)
        .join('\n');
    }
    if (B.errorCountStat) B.errorCountStat.textContent = String(entries.length);
    renderRecordReviewLinks(B.errorReviewList, B.errorReviewCount, entries, 'Chưa có bài bị lỗi.');
    renderDailyLinkStats();
    scheduleHistoryRetentionCleanup();
  }

  function scheduleHistoryRetentionCleanup() {
    if (bridgeState.historyRetentionTimer !== null) {
      window.clearTimeout(bridgeState.historyRetentionTimer);
      bridgeState.historyRetentionTimer = null;
    }

    const entries = [
      ...getCommentedEntries(),
      ...getRemovedEntries(),
      ...getErrorLinkEntries()
    ];
    const nextExpiry = entries.reduce((nearest, entry) => {
      const expiresAt = entry.savedAt + HISTORY_RETENTION_MS;
      return nearest === null || expiresAt < nearest ? expiresAt : nearest;
    }, null);

    if (nextExpiry === null) return;

    const delay = Math.max(250, Math.min(nextExpiry - Date.now() + 25, 2147483647));
    bridgeState.historyRetentionTimer = window.setTimeout(() => {
      bridgeState.historyRetentionTimer = null;
      renderCommentedLinks();
      renderRemovedLinks();
      renderErrorLinks();
      syncPostLinksInput();
    }, delay);
  }

  function filterLinksAgainstHistory(links) {
    const candidates = uniqueLinks(Array.isArray(links) ? links : parseLines(links));
    const commented = new Set(getCommentedLinks().map(normalizeUrl));
    const removed = new Set(getRemovedLinks().map(normalizeUrl));
    const errors = new Set(getErrorLinks().map(normalizeUrl));
    const accepted = [];
    const duplicateCommented = [];
    const duplicateRemoved = [];
    const duplicateErrors = [];

    for (const link of candidates) {
      const key = normalizeUrl(link);
      if (commented.has(key)) {
        duplicateCommented.push(link);
        continue;
      }
      if (removed.has(key)) {
        duplicateRemoved.push(link);
        continue;
      }
      if (errors.has(key)) {
        duplicateErrors.push(link);
        continue;
      }
      accepted.push(link);
    }

    return {
      links: accepted,
      duplicateCommented,
      duplicateRemoved,
      duplicateErrors,
      duplicateHistoryCount: duplicateCommented.length + duplicateRemoved.length + duplicateErrors.length,
      candidateCount: candidates.length
    };
  }

  function filterNewLinks(links) {
    return filterLinksAgainstHistory(links).links;
  }

  function normalizeCaptionValue(value, depth = 0, seen = new WeakSet()) {
    if (depth > 10 || value == null) return '';
    if (['string', 'number'].includes(typeof value)) return text(value);
    if (typeof value !== 'object' || seen.has(value)) return '';

    seen.add(value);
    if (Array.isArray(value)) {
      const result = value
        .map(item => normalizeCaptionValue(item, depth + 1, seen))
        .filter(Boolean)
        .join('\n')
        .trim();
      seen.delete(value);
      return result;
    }

    const preferredFields = ['text', 'content', 'value', 'description', 'message', 'body', 'caption'];
    const entries = Object.entries(value);
    for (const fieldName of preferredFields) {
      const entry = entries.find(([key]) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase() === fieldName);
      if (!entry) continue;
      const result = normalizeCaptionValue(entry[1], depth + 1, seen);
      if (result) {
        seen.delete(value);
        return result;
      }
    }

    for (const nestedValue of Object.values(value)) {
      const result = normalizeCaptionValue(nestedValue, depth + 1, seen);
      if (result) {
        seen.delete(value);
        return result;
      }
    }

    seen.delete(value);
    return '';
  }

  function getPostCaptionMap() {
    const stored = load(STORE.postCaptions, {});
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') return {};
    const captions = {};
    for (const [url, caption] of Object.entries(stored)) {
      const key = normalizeUrl(url);
      const value = normalizeCaptionValue(caption);
      if (key && value) captions[key] = value;
    }
    return captions;
  }

  function setPostCaptions(records) {
    const captions = {};
    for (const record of Array.isArray(records) ? records : []) {
      const key = normalizeUrl(record?.url || record?.link);
      const caption = normalizeCaptionValue(
        record?.caption ??
        record?.post_caption ??
        record?.postCaption ??
        record?.post_text ??
        record?.postText ??
        record?.post_content ??
        record?.postContent ??
        ''
      );
      if (!key || !caption) continue;
      captions[key] = caption;
    }
    save(STORE.postCaptions, captions);
    return Object.keys(captions).length;
  }

  function getPostCaption(link) {
    return getPostCaptionMap()[normalizeUrl(link)] || '';
  }

  function removePostCaption(link) {
    const captions = getPostCaptionMap();
    const key = normalizeUrl(link);
    if (!key || !Object.prototype.hasOwnProperty.call(captions, key)) return;
    delete captions[key];
    save(STORE.postCaptions, captions);
  }

  function prunePostCaptions(links) {
    const allowed = new Set(uniqueLinks(Array.isArray(links) ? links : parseLines(links)).map(normalizeUrl));
    const captions = getPostCaptionMap();
    const nextCaptions = {};
    for (const [url, caption] of Object.entries(captions)) {
      if (allowed.has(normalizeUrl(url))) nextCaptions[url] = caption;
    }
    save(STORE.postCaptions, nextCaptions);
    return Object.keys(nextCaptions).length;
  }

  function normalizePostCommentCount(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') {
      for (const key of ['total_count', 'totalCount', 'count', 'total', 'value']) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const nestedCount = normalizePostCommentCount(value[key]);
        if (nestedCount !== null) return nestedCount;
      }
      return null;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    }

    const raw = String(value).replace(/\u00a0/g, ' ').trim().toLowerCase();
    const match = raw.match(/(-?\d+(?:[.,]\d+)*)\s*(k|m|nghìn|nghin|triệu|trieu)?/i);
    if (!match) return null;
    const suffix = String(match[2] || '').toLowerCase();
    let numberText = match[1];
    let number;
    if (suffix) {
      number = Number.parseFloat(numberText.replace(',', '.'));
      if (suffix === 'k' || suffix === 'nghìn' || suffix === 'nghin') number *= 1_000;
      else if (suffix === 'm' || suffix === 'triệu' || suffix === 'trieu') number *= 1_000_000;
    } else {
      const separatorCount = (numberText.match(/[.,]/g) || []).length;
      if (separatorCount > 1 || /[.,]\d{3}$/.test(numberText)) numberText = numberText.replace(/[.,]/g, '');
      else numberText = numberText.replace(',', '.');
      number = Number(numberText);
    }
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function getPostCommentCountMap() {
    const stored = load(STORE.postCommentCounts, {});
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') return {};
    const counts = {};
    for (const [url, count] of Object.entries(stored)) {
      const key = normalizeUrl(url);
      const value = normalizePostCommentCount(count);
      if (key && value !== null) counts[key] = value;
    }
    return counts;
  }

  function setPostCommentCounts(records) {
    const counts = {};
    for (const record of Array.isArray(records) ? records : []) {
      const key = normalizeUrl(record?.url || record?.link);
      const count = normalizePostCommentCount(
        record?.commentCount ??
        record?.comment_count ??
        record?.commentsCount ??
        record?.comments_count ??
        record?.numberOfComments ??
        null
      );
      if (!key || count === null) continue;
      counts[key] = Object.prototype.hasOwnProperty.call(counts, key)
        ? Math.max(counts[key], count)
        : count;
    }
    save(STORE.postCommentCounts, counts);
    return Object.keys(counts).length;
  }

  function getPostCommentCount(link) {
    const counts = getPostCommentCountMap();
    const key = normalizeUrl(link);
    return key && Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : null;
  }

  function removePostCommentCount(link) {
    const counts = getPostCommentCountMap();
    const key = normalizeUrl(link);
    if (!key || !Object.prototype.hasOwnProperty.call(counts, key)) return;
    delete counts[key];
    save(STORE.postCommentCounts, counts);
  }

  function prunePostCommentCounts(links) {
    const allowed = new Set(uniqueLinks(Array.isArray(links) ? links : parseLines(links)).map(normalizeUrl));
    const counts = getPostCommentCountMap();
    const nextCounts = {};
    for (const [url, count] of Object.entries(counts)) {
      if (allowed.has(normalizeUrl(url))) nextCounts[url] = count;
    }
    save(STORE.postCommentCounts, nextCounts);
    return Object.keys(nextCounts).length;
  }

  function updatePostLinkCounter(links = null) {
    if (!B.fbPostLinkCounter) return;
    const count = Array.isArray(links)
      ? links.length
      : filterNewLinks(parseLines(B.fbPostLinkInput?.value)).length;
    B.fbPostLinkCounter.textContent = `${count} link`;
  }

  function syncPostLinksInput() {
    if (!B.fbPostLinkInput) return;
    const links = filterNewLinks(parseLines(B.fbPostLinkInput.value));
    const value = links.join('\n');
    if (B.fbPostLinkInput.value !== value) B.fbPostLinkInput.value = value;
    save(STORE.postLinks, value);
    prunePostCaptions(links);
    prunePostCommentCounts(links);
    updatePostLinkCounter(links);
  }

  function setPostLinks(links) {
    if (!B.fbPostLinkInput) return;
    B.fbPostLinkInput.value = filterNewLinks(links).join('\n');
    save(STORE.postLinks, B.fbPostLinkInput.value);
    prunePostCaptions(parseLines(B.fbPostLinkInput.value));
    prunePostCommentCounts(parseLines(B.fbPostLinkInput.value));
    B.fbPostLinkInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function getPostLinks() {
    return filterNewLinks(parseLines(B.fbPostLinkInput?.value));
  }

  function saveCommentedLink(link) {
    const entries = getCommentedEntries();
    const clean = normalizeUrl(link);
    const isNew = Boolean(clean && !entries.some(entry => entry.link === clean));
    if (isNew) entries.unshift({ link: clean, savedAt: Date.now() });
    removePostCaption(clean);
    removePostCommentCount(clean);
    save(STORE.commented, entries);
    if (isNew) saveDailyLinkStat('commented', clean);
    renderCommentedLinks();
    syncPostLinksInput();
  }

  function saveRemovedLink(link) {
    const entries = getRemovedEntries();
    const clean = normalizeUrl(link);
    const isNew = Boolean(clean && !entries.some(entry => entry.link === clean));
    if (isNew) entries.unshift({ link: clean, savedAt: Date.now() });
    removePostCaption(clean);
    removePostCommentCount(clean);
    save(STORE.removed, entries);
    if (isNew) saveDailyLinkStat('removed', clean);
    renderRemovedLinks();
    syncPostLinksInput();
  }

  function saveErrorLink(link, reason = 'Không đọc được caption') {
    const clean = normalizeUrl(link);
    if (!clean || !isGroupPermalinkUrl(clean)) return false;

    const currentEntries = getErrorLinkEntries();
    const existingEntry = currentEntries.find(entry => normalizeUrl(entry.link) === clean);
    const isNew = !existingEntry;
    const entries = currentEntries.filter(entry => normalizeUrl(entry.link) !== clean);
    entries.unshift({
      link: clean,
      reason: text(reason) || 'Không đọc được caption',
      savedAt: existingEntry?.savedAt || Date.now()
    });

    removePostCaption(clean);
    removePostCommentCount(clean);
    save(STORE.captionErrors, entries);
    if (isNew) saveDailyLinkStat('errors', clean);
    renderErrorLinks();
    syncPostLinksInput();
    return true;
  }

  function wirePostLinksInput() {
    if (!B.fbPostLinkInput) return;
    B.fbPostLinkInput.value = load(STORE.postLinks, '') || '';
    syncPostLinksInput();
    B.fbPostLinkInput.addEventListener('input', syncPostLinksInput);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setClosedLoopRunning(value) {
    bridgeState.closedLoopRunning = !!value;
    if (!bridgeState.closedLoopRunning) bridgeState.closedLoopPaused = false;
  }

  function isClosedLoopRunning() {
    return !!bridgeState.closedLoopRunning;
  }

  function setClosedLoopPaused(value) {
    bridgeState.closedLoopPaused = bridgeState.closedLoopRunning && !!value;
  }

  function isClosedLoopPaused() {
    return !!bridgeState.closedLoopPaused;
  }

  function setBridgeBusy(value) {
    bridgeState.bridgeBusy = !!value;
  }

  function isBridgeBusy() {
    return !!bridgeState.bridgeBusy;
  }

  window.addEventListener('pagehide', () => {
    if (bridgeState.historyRetentionTimer !== null) {
      window.clearTimeout(bridgeState.historyRetentionTimer);
      bridgeState.historyRetentionTimer = null;
    }
  }, { once: true });

  window.fbBridgeShared = {
    $,
    B,
    STORE,
    save,
    load,
    text,
    clampNumber,
    getScanSourceMode,
    getGroupLimit,
    getLoopPauseSeconds,
    getLinkPauseSeconds,
    getApifyActorId,
    setApifyActorId,
    wireApifyActorIdInput,
    normalizeApifyTokens,
    getStoredApifyTokens,
    getApifyTokens,
    getApifyActiveTokenIndex,
    setApifyActiveTokenIndex,
    getApifyToken,
    setApifyFailoverStatus,
    updateApifyFailoverStatus,
    wireApifyTokensInput,
    getLocalDayKey,
    getDailyProcessStats,
    addDailyProcessStats,
    getDailyCommentLimit,
    getDailyCommentLimitState,
    renderDailyCommentLimitStatus,
    setBridgeStatus,
    reportProcess,
    getProcessStatus,
    addInputSave,
    getCommentCountBypassThreshold,
    wireCommentCountBypassInput,
    getFilterSellingPostsEnabled,
    wireFilterSellingPostsToggle,
    parseLines,
    normalizeUrl,
    isGroupPermalinkUrl,
    uniqueLinks,
    getPostLinks,
    setPostLinks,
    getCommentedLinks,
    getCommentedEntries,
    saveCommentedLink,
    renderCommentedLinks,
    getDailyLinkStats,
    renderDailyLinkStats,
    getRemovedLinks,
    getRemovedEntries,
    saveRemovedLink,
    renderRemovedLinks,
    getErrorLinkEntries,
    getErrorLinks,
    saveErrorLink,
    renderErrorLinks,
    scheduleHistoryRetentionCleanup,
    filterLinksAgainstHistory,
    filterNewLinks,
    getPostCaptionMap,
    setPostCaptions,
    getPostCaption,
    removePostCaption,
    prunePostCaptions,
    normalizePostCommentCount,
    getPostCommentCountMap,
    setPostCommentCounts,
    getPostCommentCount,
    removePostCommentCount,
    prunePostCommentCounts,
    syncPostLinksInput,
    updatePostLinkCounter,
    wirePostLinksInput,
    delay,
    setClosedLoopRunning,
    isClosedLoopRunning,
    setClosedLoopPaused,
    isClosedLoopPaused,
    setBridgeBusy,
    isBridgeBusy
  };
}());
