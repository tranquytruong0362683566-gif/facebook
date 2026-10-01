(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';
  const MAX_TERMINAL_LINES = 13;

  const dashboardState = {
    initialized: false,
    clockTimer: null,
    statusObserver: null,
    outputObserver: null,
    processEventHandler: null,
    lastStatusKey: '',
    lastOutputKey: '',
    lastHistoryKey: '',
    lastProcessSequence: 0,
    lastStructuredProcessAt: 0,
    processStartedAt: Date.now(),
    processActionKey: 'ready',
    progress: 0,
    currentIndex: 0,
    totalLinks: 0,
    activeStage: 'scan',
    activePage: 'home',
    activeSettings: null,
    activeWorkspace: null,
    activeWorkspaceTrigger: null,
    activeComposerTab: 'ai',
    processView: {
      title: 'Hệ thống sẵn sàng nhận lệnh',
      detail: 'Chưa có tác vụ đang chạy.',
      status: 'ready',
      cycle: 0,
      index: 0,
      total: 0,
      remaining: 0,
      source: '--',
      target: '',
      targetLabel: 'LINK HIỆN TẠI',
      countdown: null,
      countdownLabel: 'Đang chờ'
    }
  };

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getAiProviderLabel() {
    return normalizeText(window.chatGPTApiController?.getProviderLabel?.()) || 'AI API';
  }

  function clamp(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function emitFieldChange(field) {
    if (!field) return;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function showToast(message, type = 'success') {
    const host = $('#toastHost');
    if (!host) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    host.appendChild(item);
    window.setTimeout(() => item.remove(), 3000);
  }

  function getVietnamDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('vi-VN', {
      timeZone: VIETNAM_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);

    return Object.fromEntries(parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
  }

  function updateVietnamClock() {
    const clock = $('#systemClock');
    const dateElement = $('#systemDate');
    const weekdayElement = $('#systemWeekday');
    if (!clock || !dateElement || !weekdayElement) return;

    const now = new Date();
    const parts = getVietnamDateParts(now);
    const timeText = `${parts.hour}:${parts.minute}:${parts.second}`;
    const dateText = `${parts.day}/${parts.month}/${parts.year}`;
    const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
    const isoDateTime = `${isoDate}T${timeText}+07:00`;
    let weekday = new Intl.DateTimeFormat('vi-VN', {
      timeZone: VIETNAM_TIME_ZONE,
      weekday: 'long'
    }).format(now);
    weekday = weekday ? weekday.charAt(0).toUpperCase() + weekday.slice(1) : '';

    clock.textContent = timeText;
    clock.dateTime = isoDateTime;
    dateElement.textContent = dateText;
    dateElement.dateTime = isoDate;
    weekdayElement.textContent = weekday;
  }

  function getFieldValue(field) {
    if (!field) return '';
    if (field.type === 'checkbox' || field.type === 'radio') return Boolean(field.checked);
    return field.value;
  }

  function restoreFieldValue(field, value) {
    if (!field) return;
    if (field.type === 'checkbox' || field.type === 'radio') field.checked = Boolean(value);
    else field.value = String(value ?? '');
    emitFieldChange(field);
  }

  function resetSecretFields() {
    [
      ['#flatkeyApiKeyInput', '#flatkeyApiKeyToggle', 'FlatKey API key'],
      ['#chatApiKeyInput', '#chatApiKeyToggle', 'API key'],
      ['#apifyApiTokenInput', '#apifyApiTokenToggle', 'Apify API key']
    ].forEach(([inputSelector, toggleSelector, label]) => {
      const input = $(inputSelector);
      const toggle = $(toggleSelector);
      if (input?.tagName === 'TEXTAREA') {
        input.classList.toggle('masked-api-keys', Boolean(toggle));
      }
      else if (input) input.type = 'password';
      if (toggle) {
        toggle.hidden = false;
        toggle.textContent = 'Hiện';
        toggle.setAttribute('aria-label', `Hiện ${label}`);
        toggle.title = `Hiện ${label}`;
      }
    });
  }

  function syncDashboardPage(pageId = 'home', { workspaceTarget = '', scroll = true } = {}) {
    const homePage = $('#homePage');
    const selectedPage = pageId === 'home' ? null : document.getElementById(pageId);
    if (!homePage || (pageId !== 'home' && !selectedPage)) return false;

    const isHome = !selectedPage;
    homePage.hidden = !isHome;
    homePage.classList.toggle('is-page-active', isHome);
    homePage.setAttribute('aria-hidden', String(!isHome));

    $$('.dashboard-page').forEach(page => {
      const isActive = page === selectedPage;
      page.classList.toggle('show', isActive);
      page.classList.toggle('is-page-active', isActive);
      page.setAttribute('aria-hidden', String(!isActive));
    });

    let activeButton = $('#openHomeBtn');
    if (selectedPage?.id === 'apiSettingsModal') activeButton = $('#openApiSettingsBtn');
    else if (selectedPage?.id === 'webSettingsModal') activeButton = $('#openWebSettingsBtn');
    else if (selectedPage?.id === 'aiPromptsModal') activeButton = $('#openAiPromptsBtn');
    else if (selectedPage?.id === 'templateModal') activeButton = getWorkspaceTrigger('templates');
    else if (selectedPage?.id === 'workspaceModal') {
      activeButton = getWorkspaceTrigger(workspaceTarget || selectedPage.dataset.workspace || dashboardState.activeWorkspace);
    }

    $$('.header-nav .nav-button').forEach(button => {
      const isActive = button === activeButton;
      button.classList.toggle('is-active', isActive);
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      if (button.id !== 'openHomeBtn') button.setAttribute('aria-expanded', String(isActive));
    });

    document.body.style.overflow = '';
    dashboardState.activePage = selectedPage?.id || 'home';
    if (scroll) {
      try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
    }
    return true;
  }

  function navigateHome({ restoreFocus = false } = {}) {
    if (dashboardState.activeSettings) {
      saveSettings(dashboardState.activeSettings, { showHome: false, restoreFocus: false });
    }
    if (dashboardState.activeWorkspace) {
      closeWorkspace({ restoreFocus: false, showHome: false });
    }
    const result = syncDashboardPage('home');
    if (restoreFocus) $('#openHomeBtn')?.focus({ preventScroll: true });
    return result;
  }

  function navigateDashboardPage(pageId, options = {}) {
    const targetId = typeof pageId === 'string' ? pageId : pageId?.id || '';
    if (!targetId || targetId === 'home') return navigateHome(options);

    if (dashboardState.activeSettings && dashboardState.activeSettings.modal?.id !== targetId) {
      saveSettings(dashboardState.activeSettings, { showHome: false, restoreFocus: false });
    }
    if (dashboardState.activeWorkspace && !['workspaceModal', 'templateModal'].includes(targetId)) {
      closeWorkspace({ restoreFocus: false, showHome: false });
    }
    return syncDashboardPage(targetId, options);
  }

  function getSettingsDefinitions() {
    return {
      api: {
        modal: $('#apiSettingsModal'),
        openButton: $('#openApiSettingsBtn'),
        closeButton: $('#closeApiSettingsBtn'),
        fieldIds: [
          'chatApiProviderInput',
          'chatApiModelInput',
          'flatkeyApiKeyInput',
          'chatApiKeyInput',
          'apifyActorIdInput',
          'apifyApiTokenInput'
        ],
        savedMessage: 'Đã lưu Cài Đặt API.'
      },
      web: {
        modal: $('#webSettingsModal'),
        openButton: $('#openWebSettingsBtn'),
        closeButton: $('#closeWebSettingsBtn'),
        fieldIds: [
          'fbGroupIdInput',
          'scanSourceModeSelect',
          'groupLimitInput',
          'commentCountBypassInput',
          'filterSellingPostsCheckbox',
          'facebookCookiesInput',
          'loopPauseSecondsInput',
          'linkPauseSecondsInput',
          'dailyCommentLimitInput'
        ],
        savedMessage: 'Đã lưu cài đặt chạy.'
      }
    };
  }

  function closeSettings(definition, { showHome = true, restoreFocus = true } = {}) {
    if (!definition?.modal) return;
    definition.modal.classList.remove('show');
    definition.modal.setAttribute('aria-hidden', 'true');
    definition.openButton?.setAttribute('aria-expanded', 'false');
    if (dashboardState.activeSettings === definition) dashboardState.activeSettings = null;
    resetSecretFields();
    document.body.style.overflow = '';
    if (showHome) syncDashboardPage('home');
    if (restoreFocus) definition.openButton?.focus({ preventScroll: true });
  }

  function cancelSettings(definition) {
    if (!definition) return;
    const snapshot = definition.snapshot || new Map();
    definition.fieldIds.forEach(id => {
      const field = document.getElementById(id);
      if (snapshot.has(id)) restoreFieldValue(field, snapshot.get(id));
    });
    closeSettings(definition);
  }

  function sanitizeSettings(definition) {
    if (!definition) return;

    if (definition.modal?.id === 'webSettingsModal') {
      const groupLimit = $('#groupLimitInput');
      if (groupLimit) groupLimit.value = String(Math.round(clamp(groupLimit.value, 1, 50, 5)));
      const commentCountBypass = $('#commentCountBypassInput');
      if (commentCountBypass) commentCountBypass.value = commentCountBypass.checked ? '1' : '0';
      ['#loopPauseSecondsInput', '#linkPauseSecondsInput'].forEach(selector => {
        const input = $(selector);
        if (input) input.value = String(Math.round(clamp(input.value, 0, 86400, selector.includes('loop') ? 240 : 60)));
      });
      const dailyCommentLimit = $('#dailyCommentLimitInput');
      if (dailyCommentLimit) dailyCommentLimit.value = String(Math.round(clamp(dailyCommentLimit.value, 0, 100000, 0)));
    }
  }

  function saveSettings(definition, options = {}) {
    if (!definition) return;
    sanitizeSettings(definition);
    definition.fieldIds.forEach(id => emitFieldChange(document.getElementById(id)));
    definition.snapshot = null;
    closeSettings(definition, options);
    showToast(definition.savedMessage);
  }

  function openSettings(definition) {
    if (!definition?.modal) return;
    if (dashboardState.activeWorkspace) closeWorkspace({ restoreFocus: false, showHome: false });
    if (dashboardState.activeSettings && dashboardState.activeSettings !== definition) {
      saveSettings(dashboardState.activeSettings, { showHome: false, restoreFocus: false });
    }

    definition.snapshot = new Map(definition.fieldIds.map(id => {
      const field = document.getElementById(id);
      return [id, getFieldValue(field)];
    }));
    dashboardState.activeSettings = definition;
    navigateDashboardPage(definition.modal.id);
    window.requestAnimationFrame(() => {
      const firstField = definition.fieldIds.map(id => document.getElementById(id)).find(Boolean);
      firstField?.focus({ preventScroll: true });
    });
  }

  function wireSettingsModals() {
    const definitions = getSettingsDefinitions();

    Object.values(definitions).forEach(definition => {
      if (!definition.modal || !definition.openButton) return;
      definition.openButton.setAttribute('aria-expanded', 'false');
      definition.openButton.addEventListener('click', () => openSettings(definition));
      definition.closeButton?.addEventListener('click', () => saveSettings(definition));
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && dashboardState.activeSettings) {
        event.preventDefault();
        saveSettings(dashboardState.activeSettings);
      }
    });
  }

  const WORKSPACE_DEFINITIONS = {
    queue: {
      title: 'Hàng Đợi',
      icon: '◎',
      description: 'Kiểm tra danh sách link đang chờ hệ thống xử lý'
    },
    composer: {
      title: 'Soạn Bình Luận',
      icon: '✎',
      description: 'Chọn AI viết nội dung hoặc nhập nội dung dùng cho quá trình gửi tự động'
    },
    templates: {
      title: 'Kho Mẫu',
      icon: '◇',
      description: 'Quản lý mẫu sản phẩm dùng để điền dữ liệu nhanh'
    },
    records: {
      title: 'Kết Quả',
      icon: '▥',
      description: 'Theo dõi link đã bình luận thành công, đã loại bỏ và link lỗi caption'
    }
  };

  function getWorkspaceTrigger(target) {
    return $(`.workspace-trigger[data-workspace-target="${target}"]`);
  }

  function getStoredComposerTab() {
    const shared = window.fbBridgeShared;
    const stored = shared?.load?.(shared.STORE?.commentComposerMode, 'ai');
    return stored === 'manual' ? 'manual' : 'ai';
  }

  function saveComposerTab(tab) {
    const shared = window.fbBridgeShared;
    if (!shared?.STORE?.commentComposerMode || typeof shared.save !== 'function') return;
    shared.save(shared.STORE.commentComposerMode, tab);
  }

  function closeWorkspace({ restoreFocus = true, showHome = true } = {}) {
    const modal = $('#workspaceModal');
    if (!modal) return;

    const previousTrigger = dashboardState.activeWorkspaceTrigger;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    delete modal.dataset.workspace;
    $$('.workspace-panel.is-workspace-active').forEach(panel => panel.classList.remove('is-workspace-active'));
    $$('.workspace-trigger').forEach(trigger => {
      trigger.classList.remove('is-active');
      trigger.setAttribute('aria-expanded', 'false');
    });

    dashboardState.activeWorkspace = null;
    dashboardState.activeWorkspaceTrigger = null;
    document.body.style.overflow = '';
    if (showHome) syncDashboardPage('home');
    if (restoreFocus) previousTrigger?.focus({ preventScroll: true });
  }

  function setComposerTab(tabName = 'ai', { focus = false } = {}) {
    const tab = tabName === 'manual' ? 'manual' : 'ai';
    const buttons = $$('[data-composer-tab]');
    const panels = $$('[data-composer-panel]');
    if (!buttons.length || !panels.length) return false;

    buttons.forEach(button => {
      const isActive = button.dataset.composerTab === tab;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      if (isActive && focus) button.focus({ preventScroll: true });
    });

    panels.forEach(panel => {
      const isActive = panel.dataset.composerPanel === tab;
      panel.classList.toggle('is-active', isActive);
      panel.hidden = !isActive;
    });

    $('#composerOutput')?.classList.toggle('hidden', tab !== 'ai');
    dashboardState.activeComposerTab = tab;
    saveComposerTab(tab);
    window.dispatchEvent(new CustomEvent('autovip:composer-tab', { detail: { tab } }));
    return true;
  }

  function wireComposerTabs() {
    const buttons = $$('[data-composer-tab]');
    if (!buttons.length) return;

    buttons.forEach(button => {
      button.addEventListener('click', () => setComposerTab(button.dataset.composerTab));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = buttons.indexOf(button);
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        setComposerTab(buttons[nextIndex]?.dataset.composerTab, { focus: true });
      });
    });

    setComposerTab(getStoredComposerTab());
    window.dashboardComposerTabs = {
      select: (tab, options) => setComposerTab(tab, options),
      get active() { return dashboardState.activeComposerTab; }
    };
  }

  function openWorkspace(target, { focusClose = false } = {}) {
    const definition = WORKSPACE_DEFINITIONS[target];
    const modal = $('#workspaceModal');
    const title = $('#workspaceModalTitle');
    const icon = $('#workspaceModalIcon');
    const description = $('#workspaceModalDescription');
    const closeButton = $('#closeWorkspaceModalBtn');
    const panels = $$(`.workspace-panel[data-workspace-panel="${target}"]`);
    if (!definition || !modal || !panels.length) return false;

    if (dashboardState.activeSettings) {
      saveSettings(dashboardState.activeSettings, { showHome: false, restoreFocus: false });
    }

    $$('.workspace-panel.is-workspace-active').forEach(panel => panel.classList.remove('is-workspace-active'));
    panels.forEach(panel => panel.classList.add('is-workspace-active'));

    const trigger = getWorkspaceTrigger(target);
    $$('.workspace-trigger').forEach(item => {
      const isActive = item === trigger;
      item.classList.toggle('is-active', isActive);
      item.setAttribute('aria-expanded', String(isActive));
    });

    if (title) title.textContent = definition.title;
    if (icon) icon.textContent = definition.icon;
    if (description) description.textContent = definition.description;
    if (target === 'composer') setComposerTab(dashboardState.activeComposerTab || getStoredComposerTab());
    modal.dataset.workspace = target;
    dashboardState.activeWorkspace = target;
    dashboardState.activeWorkspaceTrigger = trigger;
    navigateDashboardPage(modal.id, { workspaceTarget: target });

    const content = $('#workspaceModalContent');
    if (content) content.scrollTop = 0;
    if (focusClose) window.requestAnimationFrame(() => closeButton?.focus({ preventScroll: true }));
    return true;
  }

  function wireWorkspaceModal() {
    const modal = $('#workspaceModal');
    if (!modal) return;

    $$('.workspace-trigger').forEach(trigger => {
      trigger.addEventListener('click', () => openWorkspace(trigger.dataset.workspaceTarget));
    });

    $('#openHomeBtn')?.addEventListener('click', () => navigateHome());
    $('#closeWorkspaceModalBtn')?.addEventListener('click', () => closeWorkspace());

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !dashboardState.activeWorkspace) return;
      if (dashboardState.activePage !== modal.id) return;
      event.preventDefault();
      closeWorkspace();
    });

    window.dashboardWorkspace = {
      open: (target, options) => openWorkspace(target, options),
      close: options => closeWorkspace(options),
      get active() { return dashboardState.activeWorkspace; }
    };
  }

  window.dashboardNavigation = {
    show: (page, options) => navigateDashboardPage(page, options),
    home: options => navigateHome(options),
    get active() { return dashboardState.activePage; }
  };

  function getShortTime() {
    const parts = getVietnamDateParts(new Date());
    return `${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function formatDuration(totalSeconds) {
    const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    const two = value => String(value).padStart(2, '0');
    return hours > 0
      ? `${two(hours)}:${two(minutes)}:${two(seconds)}`
      : `${two(minutes)}:${two(seconds)}`;
  }

  function updateProcessElapsed() {
    const elapsed = $('#systemElapsedTime');
    if (!elapsed) return;
    const seconds = Math.max(0, Math.floor((Date.now() - dashboardState.processStartedAt) / 1000));
    elapsed.textContent = formatDuration(seconds);
    elapsed.dateTime = `PT${seconds}S`;
  }

  function statusDisplay(status) {
    const values = {
      ready: ['READY', 'is-ready'],
      running: ['RUNNING', 'is-running'],
      ok: ['OK', 'is-ok'],
      wait: ['WAIT', 'is-wait'],
      error: ['ERROR', 'is-error'],
      next: ['NEXT', 'is-next'],
      stop: ['STOP', 'is-stop']
    };
    return values[status] || values.running;
  }

  function phaseProgress(stage, status) {
    if (status === 'ok' && stage === 'comment') return 1;
    if (status === 'next' || status === 'error') return 1;
    if (stage === 'ai') return .55;
    if (stage === 'comment') return .82;
    return .18;
  }

  function renderProcessStats() {
    const stats = window.fbBridgeShared?.getDailyProcessStats?.() || { success: 0, skipped: 0, errors: 0 };
    if ($('#systemSuccessCount')) $('#systemSuccessCount').textContent = String(stats.success);
    if ($('#systemSkippedCount')) $('#systemSkippedCount').textContent = String(stats.skipped);
    if ($('#systemErrorCount')) $('#systemErrorCount').textContent = String(stats.errors);
    window.fbBridgeShared?.renderDailyCommentLimitStatus?.();
  }

  function renderCurrentProcess(detail = {}, { fromEvent = false } = {}) {
    if (fromEvent) dashboardState.lastStructuredProcessAt = Date.now();
    const nextActionKey = normalizeText(detail.actionKey || dashboardState.processActionKey || 'process');
    if (nextActionKey && nextActionKey !== dashboardState.processActionKey) {
      dashboardState.processActionKey = nextActionKey;
      dashboardState.processStartedAt = Date.now();
    }

    const isNewEvent = !detail.sequence || detail.sequence !== dashboardState.lastProcessSequence;
    if (fromEvent && detail.sequence) dashboardState.lastProcessSequence = detail.sequence;
    if (fromEvent && isNewEvent && detail.statDelta && typeof detail.statDelta === 'object') {
      window.fbBridgeShared?.addDailyProcessStats?.(detail.statDelta);
    }

    const previous = dashboardState.processView;
    const next = { ...previous };
    const fields = ['title', 'detail', 'status', 'stage', 'cycle', 'index', 'total', 'remaining', 'source', 'target', 'targetLabel', 'countdown', 'countdownLabel'];
    fields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(detail, field)) next[field] = detail[field];
    });
    dashboardState.processView = next;

    const title = normalizeText(next.title) || 'Hệ thống đang hoạt động';
    const detailText = normalizeText(next.detail) || 'Đang chờ thông tin chi tiết từ tiến trình.';
    const status = normalizeText(next.status).toLowerCase() || 'running';
    const [badgeText, badgeClass] = statusDisplay(status);
    const badge = $('#systemProcessBadge');
    if (badge) {
      badge.textContent = badgeText;
      badge.className = `terminal-state-badge ${badgeClass}`;
    }
    if ($('#systemProcessTitle')) {
      $('#systemProcessTitle').textContent = title;
      $('#systemProcessTitle').title = title;
    }
    if ($('#systemProcessDetail')) {
      $('#systemProcessDetail').textContent = detailText;
      $('#systemProcessDetail').title = detailText;
    }

    const cycle = Math.max(0, Number(next.cycle) || 0);
    const index = Math.max(0, Number(next.index) || 0);
    const total = Math.max(0, Number(next.total) || 0);
    const remaining = Object.prototype.hasOwnProperty.call(next, 'remaining')
      ? Math.max(0, Number(next.remaining) || 0)
      : Math.max(0, total - index);
    if ($('#systemCycleValue')) $('#systemCycleValue').textContent = cycle ? String(cycle) : '--';
    if ($('#systemQueueValue')) $('#systemQueueValue').textContent = total ? `${index}/${total}` : '0/0';
    if ($('#systemRemainingValue')) $('#systemRemainingValue').textContent = String(remaining);
    if ($('#systemSourceValue')) {
      $('#systemSourceValue').textContent = normalizeText(next.source) || '--';
      $('#systemSourceValue').title = normalizeText(next.source) || '';
    }

    const target = normalizeText(next.target);
    if ($('#systemCurrentTargetLabel')) $('#systemCurrentTargetLabel').textContent = normalizeText(next.targetLabel) || 'LINK HIỆN TẠI';
    if ($('#systemCurrentLink')) {
      $('#systemCurrentLink').textContent = target || 'Chưa có link đang xử lý';
      $('#systemCurrentLink').title = target;
    }

    const countdownRow = $('#systemCountdownRow');
    const hasCountdown = next.countdown !== null && next.countdown !== undefined && Number.isFinite(Number(next.countdown));
    countdownRow?.classList.toggle('hidden', !hasCountdown);
    if (hasCountdown) {
      const seconds = Math.max(0, Math.ceil(Number(next.countdown) || 0));
      if ($('#systemCountdownLabel')) $('#systemCountdownLabel').textContent = normalizeText(next.countdownLabel) || 'Đang chờ';
      if ($('#systemCountdownValue')) {
        $('#systemCountdownValue').textContent = formatDuration(seconds);
        $('#systemCountdownValue').dateTime = `PT${seconds}S`;
      }
    }

    dashboardState.currentIndex = index;
    dashboardState.totalLinks = total;
    const explicitProgress = Number(detail.progress);
    const progress = Number.isFinite(explicitProgress)
      ? explicitProgress
      : total > 0
        ? (((Math.max(1, index) - 1) + phaseProgress(next.stage || detail.stage, status)) / total) * 100
        : status === 'ok'
          ? 100
          : dashboardState.progress;
    if (total > 0 || Number.isFinite(explicitProgress) || status === 'ok') setProgress(progress, true);
    if (detail.stage) setProcessStage(detail.stage);
    renderProcessStats();
    updateProcessElapsed();

    if (fromEvent && isNewEvent && normalizeText(detail.historyMessage)) {
      const explicitHistoryKey = normalizeText(detail.historyKey);
      const historyKey = explicitHistoryKey || `${detail.sequence || detail.timestamp || ''}:${normalizeText(detail.historyMessage)}`;
      appendTerminalLine(
        detail.historyMessage,
        detail.historyTag || badgeText,
        detail.historyLevel || (status === 'error' ? 'error' : status === 'ok' ? 'ok' : status === 'wait' || status === 'next' ? 'warn' : 'running'),
        historyKey,
        { update: detail.historyMode === 'update' && Boolean(explicitHistoryKey) }
      );
    }
  }

  function trimTerminalMessage(message, maxLength = 520) {
    const clean = normalizeText(message);
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
  }

  function appendTerminalLine(message, tag = 'RUNNING', level = 'running', key = '', options = {}) {
    const log = $('#systemTerminalLog');
    if (!log) return;

    const eventKey = key || `${level}:${tag}:${normalizeText(message)}`;
    const cleanMessage = trimTerminalMessage(message);
    const signature = `${eventKey}:${level}:${tag}:${cleanMessage}`;
    if (!options.update && signature === dashboardState.lastStatusKey) return;
    dashboardState.lastStatusKey = signature;

    let line = null;
    if (options.update) {
      line = Array.from(log.children).find(item => item.dataset?.historyKey === eventKey) || null;
    }

    if (!line) {
      line = document.createElement('div');
      line.dataset.historyKey = eventKey;
      line.dataset.startedAt = getShortTime();

      const prompt = document.createElement('span');
      prompt.textContent = '>';
      const content = document.createElement('em');
      const state = document.createElement('b');
      line.append(prompt, content, state);
      log.appendChild(line);
    }

    line.className = `terminal-line is-${level}${options.update ? ' is-live-entry' : ''}`;
    const content = line.querySelector('em');
    const state = line.querySelector('b');
    if (content) content.textContent = `[${line.dataset.startedAt || getShortTime()}] ${cleanMessage}`;
    if (state) state.textContent = `[${tag}]`;

    while (log.children.length > MAX_TERMINAL_LINES) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  function setProcessStage(stage) {
    if (!stage) return;
    dashboardState.activeStage = stage;
    const order = ['scan', 'ai', 'comment'];
    const activeIndex = order.indexOf(stage);

    $$('.process-step[data-process-step]').forEach(step => {
      const stepIndex = order.indexOf(step.dataset.processStep);
      step.classList.toggle('is-active', stepIndex === activeIndex);
      step.classList.toggle('is-done', stepIndex >= 0 && activeIndex >= 0 && stepIndex < activeIndex);
    });
  }

  function setProgress(value, allowDecrease = false) {
    const progressBar = $('#systemProgressBar');
    const progressText = $('#systemProgressText');
    let next = Math.round(clamp(value, 0, 100, 0));
    if (!allowDecrease) next = Math.max(dashboardState.progress, next);
    dashboardState.progress = next;
    if (progressBar) progressBar.style.width = `${next}%`;
    if (progressText) progressText.textContent = `${next}%`;
  }

  function progressForCurrentLink(phase) {
    const index = dashboardState.currentIndex;
    const total = dashboardState.totalLinks;
    if (!index || !total) return Math.round(phase * 100);
    return Math.round((((index - 1) + phase) / total) * 100);
  }

  function classifyBridgeStatus(rawMessage, statusElement) {
    const clean = normalizeText(rawMessage);
    const lower = clean.toLocaleLowerCase('vi-VN');
    const statusClass = statusElement?.classList.contains('error')
      ? 'error'
      : statusElement?.classList.contains('ok')
        ? 'ok'
        : statusElement?.classList.contains('warn')
          ? 'warn'
          : '';

    const linkMatch = clean.match(/(?:link|bài)\s+(\d+)\s*\/\s*(\d+)/i);
    if (linkMatch) {
      dashboardState.currentIndex = Number(linkMatch[1]);
      dashboardState.totalLinks = Number(linkMatch[2]);
    }

    let result = {
      text: clean || 'Hệ thống sẵn sàng',
      tag: statusClass === 'error' ? 'ERROR' : statusClass === 'ok' ? 'OK' : statusClass === 'warn' ? 'WAIT' : 'INFO',
      level: statusClass === 'error' ? 'error' : statusClass === 'ok' ? 'ok' : statusClass === 'warn' ? 'warn' : 'running',
      stage: dashboardState.activeStage,
      progress: dashboardState.progress,
      resetProgress: false,
      transient: false
    };

    if (/sẵn sàng/.test(lower)) {
      result = { ...result, text: 'Hệ thống sẵn sàng nhận lệnh', tag: 'READY', level: 'ok', stage: 'scan', progress: 0, resetProgress: true };
    } else if (/đang dò extension|chưa phát hiện extension|kết nối extension/.test(lower)) {
      result = { ...result, text: 'Kết nối tiến trình nền', tag: 'RUNNING', level: 'running', stage: 'scan', progress: 3 };
    } else if (/kiểm tra uid/.test(lower)) {
      result = { ...result, text: 'Kiểm tra UID Facebook', tag: 'RUNNING', level: 'running', stage: 'scan', progress: 6 };
    } else if (/đã phát hiện uid|đã có uid/.test(lower)) {
      const uid = clean.match(/UID\s+(\d+)/i)?.[1] || '';
      result = { ...result, text: `Xác thực UID Facebook${uid ? `: ${uid}` : ''}`, tag: 'OK', level: 'ok', stage: 'scan', progress: 10 };
    } else if (/đăng nhập cookie|dòng cookie|đổi tài khoản|uid đã đăng xuất/.test(lower)) {
      result = { ...result, text: 'Đang cập nhật trạng thái tài khoản Facebook', tag: statusClass === 'error' ? 'ERROR' : 'RUNNING', level: statusClass === 'error' ? 'error' : 'running', stage: 'scan', progress: 8 };
    } else if (/đang chạy vòng|bắt đầu quét nhóm|tự quét vòng tiếp theo/.test(lower)) {
      const cycle = clean.match(/vòng\s+(\d+)/i)?.[1];
      dashboardState.currentIndex = 0;
      dashboardState.totalLinks = 0;
      result = { ...result, text: `Khởi chạy${cycle ? ` vòng ${cycle}` : ' vòng mới'} bằng cơ chế 1.2.5`, tag: 'RUNNING', level: 'running', stage: 'scan', progress: 12, resetProgress: true };
    } else if (/cơ chế 1\.2\.5.*quét|quét ngầm|đang quét.*caption/.test(lower)) {
      result = { ...result, text: 'Quét ngầm bài viết nhóm Facebook', tag: 'RUNNING', level: 'running', stage: 'scan', progress: 22 };
    } else if (/không có bài viết mới|không có link mới/.test(lower)) {
      result = { ...result, text: 'Không có bài mới, chờ vòng tiếp theo', tag: 'IDLE', level: 'warn', stage: 'scan', progress: 100 };
    } else if (/đã lọc xong|lọc trùng|hàng đợi|đã mở và quét xong/.test(lower)) {
      result = { ...result, text: 'Lọc trùng và nạp hàng đợi liên kết', tag: statusClass === 'error' ? 'ERROR' : 'OK', level: statusClass === 'error' ? 'error' : 'ok', stage: 'scan', progress: 34 };
    } else if (/đang xử lý link/.test(lower)) {
      result = { ...result, text: `Xử lý link ${dashboardState.currentIndex || '?'}/${dashboardState.totalLinks || '?'}`, tag: 'RUNNING', level: 'running', stage: 'scan', progress: progressForCurrentLink(.08) };
    } else if (/facebook scanner|extension.*đọc|đang đọc.*facebook/.test(lower)) {
      result = { ...result, text: 'Extension đọc link và nội dung Facebook', tag: statusClass === 'ok' ? 'OK' : 'RUNNING', level: statusClass === 'ok' ? 'ok' : 'running', stage: 'scan', progress: progressForCurrentLink(.28) };
    } else if (/đã lấy nội dung|điền vào ô nội dung|đã lấy caption/.test(lower)) {
      result = { ...result, text: 'Nạp nội dung bài viết cho AI', tag: 'OK', level: 'ok', stage: 'ai', progress: progressForCurrentLink(.42) };
    } else if (/ai trả về.*next|ai xác định.*bỏ qua|bài người bán\/cho thuê/.test(lower)) {
      result = { ...result, text: 'AI loại bài không phù hợp và chuyển link', tag: 'NEXT', level: 'warn', stage: 'ai', progress: progressForCurrentLink(1) };
    } else if (/gửi bình luận|gửi mutation/.test(lower) && !/đã gửi/.test(lower)) {
      result = { ...result, text: 'Gửi mutation bình luận Facebook', tag: 'RUNNING', level: 'running', stage: 'comment', progress: progressForCurrentLink(.78) };
    } else if (/đã gửi bình luận xong|bình luận thành công/.test(lower)) {
      result = { ...result, text: 'Gửi bình luận Facebook thành công', tag: 'OK', level: 'ok', stage: 'comment', progress: progressForCurrentLink(1) };
    } else if (/đã chạy xong link|đang nghỉ.*link tiếp theo/.test(lower)) {
      const seconds = clean.match(/(\d+)\s*giây/i)?.[1];
      result = { ...result, text: `Hoàn tất link, nghỉ${seconds ? ` ${seconds} giây` : ''}`, tag: 'WAIT', level: 'warn', stage: 'comment', progress: progressForCurrentLink(1), transient: true };
    } else if (/đang nghỉ|nghỉ 0 giây/.test(lower)) {
      const seconds = clean.match(/(\d+)\s*giây/i)?.[1];
      result = { ...result, text: `Chờ${seconds ? ` ${seconds} giây` : ''} trước vòng tiếp theo`, tag: 'WAIT', level: 'warn', stage: 'scan', progress: 100, transient: true };
    } else if (/đã xử lý hết link/.test(lower)) {
      result = { ...result, text: 'Hoàn tất toàn bộ hàng đợi', tag: 'OK', level: 'ok', stage: 'comment', progress: 100 };
    } else if (/dừng|lỗi|thất bại|không thể/.test(lower) || statusClass === 'error') {
      result = { ...result, text: clean, tag: 'ERROR', level: 'error', progress: dashboardState.progress };
    }

    return result;
  }

  function renderBridgeStatus() {
    const status = $('#bridgeStatus');
    if (!status) return;
    const clean = normalizeText(status.textContent);
    if (!clean) return;
    const key = `${status.className}:${clean}`;
    const result = classifyBridgeStatus(clean, status);
    const hasRecentStructuredProcess = Date.now() - dashboardState.lastStructuredProcessAt <= 1500;
    if (!hasRecentStructuredProcess) {
      renderCurrentProcess({
        actionKey: `bridge-${result.stage}-${result.tag}-${result.text.replace(/\d+\s*giây/ig, 'countdown')}`,
        title: result.text,
        detail: clean,
        status: result.level === 'error' ? 'error' : result.tag === 'OK' ? 'ok' : result.tag === 'NEXT' ? 'next' : result.tag === 'STOP' ? 'stop' : result.level === 'warn' ? 'wait' : 'running',
        stage: result.stage,
        progress: result.progress
      });
      if (!result.transient) appendTerminalLine(result.text, result.tag, result.level, key);
    }
    setProcessStage(result.stage);
    setProgress(result.progress, result.resetProgress);
  }

  function renderAiOutputStatus() {
    const output = $('#output');
    if (!output) return;
    const clean = normalizeText(output.textContent);
    const aiSource = getAiProviderLabel();
    const key = `${output.className}:${clean}`;
    if (!clean || key === dashboardState.lastOutputKey) return;
    dashboardState.lastOutputKey = key;

    if (output.classList.contains('placeholder')) return;
    if (output.classList.contains('loading')) {
      const isClassifying = /phân loại/i.test(clean);
      appendTerminalLine(isClassifying ? 'AI phân loại nội dung bài viết' : 'AI tạo bình luận tự nhiên', 'RUNNING', 'running', `ai:${key}`);
      renderCurrentProcess({
        actionKey: isClassifying ? 'ai-classifying' : 'ai-generating-comment',
        title: isClassifying ? 'AI đang phân loại bài viết' : 'AI đang tạo bình luận',
        detail: clean,
        status: 'running',
        stage: 'ai',
        source: aiSource,
        countdown: null
      });
      setProcessStage('ai');
      setProgress(progressForCurrentLink(isClassifying ? .5 : .64));
      return;
    }
    if (output.classList.contains('error')) {
      appendTerminalLine(`${aiSource} trả về lỗi`, 'ERROR', 'error', `ai:${key}`);
      renderCurrentProcess({
        actionKey: 'ai-output-error',
        title: `${aiSource} trả về lỗi`,
        detail: clean,
        status: 'error',
        stage: 'ai',
        source: aiSource,
        countdown: null
      });
      setProcessStage('ai');
      return;
    }
    if (/^\(?next\)?$/i.test(clean)) {
      appendTerminalLine('AI trả về NEXT, bỏ qua bài viết', 'NEXT', 'warn', `ai:${key}`);
      renderCurrentProcess({
        actionKey: 'ai-output-next',
        title: 'AI trả về NEXT',
        detail: 'Bài viết không phù hợp và sẽ được chuyển sang danh sách loại bỏ.',
        status: 'next',
        stage: 'ai',
        source: aiSource,
        countdown: null
      });
      setProcessStage('ai');
      setProgress(progressForCurrentLink(1));
      return;
    }

    appendTerminalLine('AI đã tạo xong nội dung bình luận', 'OK', 'ok', `ai:${key}`);
    renderCurrentProcess({
      actionKey: 'ai-output-ready',
      title: 'AI đã tạo xong bình luận',
      detail: 'Nội dung bình luận đã sẵn sàng để gửi lên Facebook.',
      status: 'ok',
      stage: 'comment',
      source: aiSource,
      countdown: null
    });
    setProcessStage('comment');
    setProgress(progressForCurrentLink(.72));
  }

  function wireTerminalObservers() {
    const bridgeStatus = $('#bridgeStatus');
    const output = $('#output');

    if (bridgeStatus) {
      dashboardState.statusObserver = new MutationObserver(renderBridgeStatus);
      dashboardState.statusObserver.observe(bridgeStatus, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        characterData: true,
        subtree: true
      });
      renderBridgeStatus();
    }

    if (output) {
      dashboardState.outputObserver = new MutationObserver(renderAiOutputStatus);
      dashboardState.outputObserver.observe(output, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    dashboardState.processEventHandler = event => {
      if (!event?.detail || typeof event.detail !== 'object') return;
      renderCurrentProcess(event.detail, { fromEvent: true });
    };
    window.addEventListener('autovip:process', dashboardState.processEventHandler);
    const currentProcess = window.fbBridgeShared?.getProcessStatus?.();
    if (currentProcess) renderCurrentProcess(currentProcess, { fromEvent: true });

    const commandButtons = [
      ['#dashboardApiRunBtn', 'Nhận lệnh Chạy bằng API'],
      ['#dashboardManualRunBtn', 'Nhận lệnh Chạy thủ công'],
      ['#apifyScanBtn', 'Nhận lệnh quét link và caption bằng cơ chế 1.2.5'],
      ['#autoWorkflowBtn', 'Nhận lệnh chạy hàng đợi hiện có']
    ];

    commandButtons.forEach(([selector, message]) => {
      $(selector)?.addEventListener('click', () => {
        dashboardState.currentIndex = 0;
        dashboardState.totalLinks = 0;
        setProcessStage('scan');
        setProgress(2, true);
        appendTerminalLine(message, 'RUNNING', 'running', `command:${selector}:${Date.now()}`);
      }, { capture: true });
    });

    $('#stopClosedLoopBtn')?.addEventListener('click', () => {
      appendTerminalLine('Người dùng yêu cầu dừng vòng lặp', 'STOP', 'warn', `stop:${Date.now()}`);
    });
  }

  function cleanupDashboard() {
    if (dashboardState.clockTimer) {
      window.clearInterval(dashboardState.clockTimer);
      dashboardState.clockTimer = null;
    }
    dashboardState.statusObserver?.disconnect();
    dashboardState.outputObserver?.disconnect();
    dashboardState.statusObserver = null;
    dashboardState.outputObserver = null;
    if (dashboardState.processEventHandler) {
      window.removeEventListener('autovip:process', dashboardState.processEventHandler);
      dashboardState.processEventHandler = null;
    }
  }

  function initDashboard() {
    if (dashboardState.initialized || document.documentElement.dataset.dashboardV140 === 'ready') return;
    dashboardState.initialized = true;
    document.documentElement.dataset.dashboardV140 = 'ready';

    syncDashboardPage('home', { scroll: false });
    updateVietnamClock();
    dashboardState.clockTimer = window.setInterval(updateVietnamClock, 1000);
    wireSettingsModals();
    wireComposerTabs();
    wireWorkspaceModal();
    wireTerminalObservers();

    window.addEventListener('pagehide', event => {
      if (!event.persisted) cleanupDashboard();
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initDashboard, { once: true });
  } else {
    initDashboard();
  }
})();
