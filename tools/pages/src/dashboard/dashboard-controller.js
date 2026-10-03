import {
  JOB_STATUS,
  STORAGE_KEYS
} from "../shared/constants.js";
import { getLocal, setLocal } from "../shared/chrome-storage.js";
import { AdsManagerTokenWorkflow } from "./auth/ads-manager-token-workflow.js";
import {
  getDirectPage,
  getManagedPages,
  getPageStatistics
} from "./publishing/facebook-api.js";
import {
  applyContentTemplateSettings,
  CONTENT_TEMPLATE_LIMITS,
  createContentTemplate,
  normalizeContentTemplates,
  normalizeTemplateName
} from "./data/content-templates.js";
import {
  listVideoIds,
  pruneVideos,
  putVideo
} from "./data/video-database.js";
import {
  titleFromFileName,
  validateVideoFile,
  videoFingerprint
} from "./media/video-file.js";
import { VideoRunner, hasRetryableComment } from "./publishing/video-runner.js";
import { collectRetainedVideoIds } from "./data/retained-video-ids.js";
import { changePostingMode, isPhotoMode, normalizePostingMode, photoSettings, queueStorageKey } from "./data/posting-mode.js";
import { normalizePostingSpeed, postingSpeedHint } from "./data/posting-speed.js";
import { PHOTO_ACCEPT, validatePhotoFile } from "./media/photo-file.js";
import { PhotoPreviewView } from "./ui/photo-preview-view.js";
import { exportRunCsv } from "./reporting/csv-export.js";
import { ContentTemplatesView } from "./ui/content-templates-view.js";
import { RunResultsView } from "./ui/run-results-view.js";
import { ActivityLogView } from "./ui/activity-log-view.js";
import { TokenWorkflowView } from "./ui/token-workflow-view.js";
import {
  AI_MODELS,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROMPT,
  DEFAULT_AI_COMMENT_PROMPT,
  generateVideoContent,
  rewriteCommentContent,
  validateAiConfiguration
} from "./ai/openai-content.js";

const DEFAULT_SETTINGS = Object.freeze({
  contentMode: "reels",
  tokenMode: "user",
  accessToken: "",
  directPageId: "",
  selectedPageIds: [],
  postContent: "",
  useVideoTitleAsContent: false,
  aiEnabled: false,
  aiModel: DEFAULT_AI_MODEL,
  aiPrompt: DEFAULT_AI_PROMPT,
  commentAiEnabled: false,
  aiCommentPrompt: DEFAULT_AI_COMMENT_PROMPT,
  videosPerPage: 0,
  randomizeVideos: false,
  commentEnabled: false,
  commentText: "",
  uploadConcurrency: "fast",
  jobDelay: 5
});

const STATUS_LABELS = Object.freeze({
  [JOB_STATUS.PENDING]: "Chờ",
  [JOB_STATUS.GENERATING]: "Đang viết AI",
  [JOB_STATUS.UPLOADING]: "Đang tải lên",
  [JOB_STATUS.PROCESSING]: "Đang xử lý",
  [JOB_STATUS.SUCCEEDED]: "Thành công",
  [JOB_STATUS.FAILED]: "Thất bại",
  [JOB_STATUS.INTERRUPTED]: "Gián đoạn",
  [JOB_STATUS.CANCELLED]: "Đã dừng"
});

const QUEUE_SAVE_CHECKPOINT = 25;
const LEGACY_SCHEDULE_SETTING_KEYS = Object.freeze([
  "publishMode",
  "scheduleStart",
  "scheduleInterval"
]);

const elements = {};

let settings = { ...DEFAULT_SETTINGS };
let pages = [];
let queue = [];
const modeQueues = { reels: [], photos: [] };
let photoPreviewView = null;
let contentTemplates = [];
let settingsSaveTimer = null;
let aiKeySaveTimer = null;
let openAiApiKey = "";
let aiTestController = null;
let renderFrame = null;
let starting = false;
let loadingPages = false;
let loadingToken = false;
let importingVideos = false;
let editingLocked = false;
let savingTemplate = false;
let applyingTemplate = false;
let statisticsLoading = false;
let statisticsRows = [];
let statisticsLoadedKey = "";

const runResultsView = new RunResultsView(elements, STATUS_LABELS);
const activityLogView = new ActivityLogView(elements);
const tokenWorkflowView = new TokenWorkflowView(elements);
const contentTemplatesView = new ContentTemplatesView(elements);

const runner = new VideoRunner({
  getAiApiKey: () => openAiApiKey,
  onError: (error) => toast(error.message || "Tiến trình gặp lỗi.", "error"),
  onState: (snapshot) => scheduleSnapshotRender(snapshot),
  onJob: (_job, snapshot) => scheduleSnapshotRender(snapshot),
  onLog: (entry) => activityLogView.appendLog(entry)
});

const tokenWorkflow = new AdsManagerTokenWorkflow({
  onState: (state) => tokenWorkflowView.render(state)
});

function bindElements() {
  [
    "settingsPanel",
    "postingModeTabs",
    "postingEditor",
    "mediaSectionTitle",
    "jobDelayLabel",
    "commentEnabledLabel",
    "commentEnabledHint",
    "photoPostingHint",
    "photoPreviewList",
    "dashboardTabs",
    "navVideoCount",
    "navPageCount",
    "tokenStatus",
    "tokenWorkflowCard",
    "tokenWorkflowTitle",
    "tokenWorkflowDescription",
    "tokenStepSession",
    "tokenStepVerification",
    "tokenStepToken",
    "openAdsManagerButton",
    "retryTokenButton",
    "tokenMode",
    "directPageIdField",
    "directPageId",
    "accessToken",
    "toggleToken",
    "autoTokenButton",
    "loadPagesButton",
    "pageCount",
    "pageSearch",
    "selectVisiblePages",
    "clearPageSelection",
    "pageList",
    "statisticsPeriod",
    "refreshStatisticsButton",
    "statisticsStatus",
    "statisticsUpdatedAt",
    "statisticsProgress",
    "statisticsPageCount",
    "statisticsViews",
    "statisticsInteractions",
    "statisticsLikes",
    "statisticsComments",
    "statisticsShares",
    "statisticsBody",
    "templateCount",
    "addTemplateButton",
    "templateList",
    "videoCount",
    "clearAllVideosButton",
    "dropZone",
    "dropZoneTitle",
    "dropZoneHint",
    "videoInput",
    "videoImportStatus",
    "postContent",
    "useVideoTitleAsContent",
    "aiEnabled",
    "aiSourceControls",
    "aiSourceHint",
    "openAiSettingsButton",
    "aiApiKey",
    "aiModel",
    "aiPrompt",
    "aiCommentPrompt",
    "resetAiCommentPromptButton",
    "testAiCommentButton",
    "toggleAiKeyButton",
    "saveAiSettingsButton",
    "resetAiPromptButton",
    "testAiButton",
    "cancelAiTestButton",
    "aiTestSource",
    "aiStatus",
    "aiPreview",
    "aiPreviewTitle",
    "aiPreviewCaption",
    "videosPerPage",
    "randomizeVideos",
    "uploadConcurrency",
    "jobDelay",
    "commentEnabled",
    "commentAiEnabled",
    "commentAiField",
    "commentTextField",
    "commentText",
    "startButton",
    "newBatchButton",
    "runSummary",
    "runSpeedHint",
    "pauseButton",
    "resumeButton",
    "stopButton",
    "retryButton",
    "validationMessage",
    "exportCsvButton",
    "clearResultsButton",
    "totalStat",
    "successStat",
    "failedStat",
    "pendingStat",
    "overallProgress",
    "pageProgressList",
    "clearLogButton",
    "logList",
    "templateDialog",
    "templateForm",
    "templateDialogTitle",
    "templateName",
    "templateSnapshotSummary",
    "templateDialogError",
    "closeTemplateDialogButton",
    "cancelTemplateButton",
    "saveTemplateButton",
    "toastHost"
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
  photoPreviewView = new PhotoPreviewView(elements.photoPreviewList);
}

function mediaLabel() {
  return isPhotoMode(settings) ? "ảnh" : "video";
}

function activeMediaType() {
  return isPhotoMode(settings) ? "photo" : "video";
}

function visibleContentTemplates() {
  return contentTemplates.filter((template) => template.mediaType === activeMediaType());
}

function updatePostingModeUi() {
  const photos = isPhotoMode(settings);
  elements.settingsPanel.dataset.contentMode = settings.contentMode;
  elements.postingModeTabs.querySelectorAll("[data-posting-mode]").forEach((tab) => {
    const active = tab.dataset.postingMode === settings.contentMode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) elements.postingEditor.setAttribute("aria-labelledby", tab.id);
  });
  elements.settingsPanel.querySelectorAll("[data-reels-only]").forEach((node) => { node.hidden = photos; });
  elements.mediaSectionTitle.textContent = photos ? "Ảnh đăng" : "Video đăng";
  elements.videoInput.accept = photos ? PHOTO_ACCEPT : "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
  elements.postContent.placeholder = photos ? "Nhập nội dung bài viết cho các ảnh" : "Nhập nội dung chung cho các video";
  elements.jobDelayLabel.textContent = photos ? "Nghỉ giữa các bài của 1 Page" : "Nghỉ giữa các video của 1 Page";
  elements.commentEnabledLabel.textContent = photos ? "Bình luận vào bài viết" : "Tự bình luận sau khi đăng";
  elements.commentEnabledHint.textContent = photos ? "Sau khi bài ảnh đăng thành công." : "Sau khi video đăng thành công.";
  elements.photoPostingHint.hidden = !photos;
}

async function switchPostingMode(mode) {
  if (mode === settings.contentMode || editingLocked || importingVideos || savingTemplate || applyingTemplate || aiTestController) return;
  syncSettingsFromInputs();
  clearTimeout(settingsSaveTimer);
  const nextSettings = changePostingMode(settings, mode, DEFAULT_SETTINGS);
  starting = true;
  updateControls(runner.getSnapshot());
  try {
    await setLocal({ [STORAGE_KEYS.SETTINGS]: nextSettings });
    modeQueues[settings.contentMode] = queue;
    settings = nextSettings;
    queue = modeQueues[settings.contentMode];
    elements.videoInput.value = "";
    elements.validationMessage.textContent = "";
    setVideoImportStatus("");
    applySettingsToInputs();
    renderContentTemplates();
    renderQueue();
  } catch (error) {
    toast("Không chuyển được mục đăng: " + error.message, "error");
  } finally {
    starting = false;
    updateControls(runner.getSnapshot());
  }
}

function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("vi-VN");
}

function normalizeUploadConcurrency(value) {
  return normalizePostingSpeed(value);
}

function setActivePanel(panelName) {
  const tabs = elements.dashboardTabs.querySelectorAll("[data-panel]");
  const selectedTab = Array.from(tabs).find((tab) => tab.dataset.panel === panelName);
  if (!selectedTab) return;

  tabs.forEach((tab) => {
    const active = tab === selectedTab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll("[data-dashboard-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.dashboardPanel !== panelName;
  });
  if (panelName === "statistics") void loadStatistics();
}

function toast(message, type = "") {
  const node = document.createElement("div");
  node.className = "toast" + (type ? " " + type : "");
  node.textContent = message;
  elements.toastHost.appendChild(node);
  setTimeout(() => node.remove(), 4_500);
}

function setTokenStatus(message, type = "") {
  elements.tokenStatus.textContent = message;
  elements.tokenStatus.className = type || "muted";
  const connected = type === "status-success";
  elements.autoTokenButton.hidden = connected || elements.tokenMode?.value === "page";
  elements.tokenStatus.closest(".token-compact-status")?.classList.toggle("is-connected", connected);
}

function updateAuthControls() {
  const busy = loadingPages || loadingToken;
  const directToken = elements.tokenMode?.value === "page";
  elements.autoTokenButton.disabled = editingLocked || busy;
  elements.loadPagesButton.disabled = editingLocked || busy;
  elements.openAdsManagerButton.disabled = editingLocked;
  elements.retryTokenButton.disabled = editingLocked || (!loadingToken && directToken);
  tokenWorkflowView.setLoading(loadingToken);
}

function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    setLocal({ [STORAGE_KEYS.SETTINGS]: settings }).catch((error) => {
      toast("Không lưu được thiết lập: " + error.message, "error");
    });
  }, 250);
}

function syncSettingsFromInputs() {
  settings.tokenMode = elements.tokenMode.value;
  settings.accessToken = elements.accessToken.value.trim();
  settings.directPageId = elements.directPageId.value.trim();
  settings.postContent = elements.postContent.value;
  settings.useVideoTitleAsContent = elements.useVideoTitleAsContent.checked;
  settings.aiEnabled = elements.aiEnabled.checked;
  settings.aiModel = elements.aiModel.value;
  settings.aiPrompt = elements.aiPrompt.value;
  settings.aiCommentPrompt = elements.aiCommentPrompt.value;
  settings.commentAiEnabled = elements.commentAiEnabled.checked;
  const requestedVideos = Math.max(
    0,
    Math.floor(Number(elements.videosPerPage.value) || 0)
  );
  settings.videosPerPage = queue.length
    ? Math.min(requestedVideos, queue.length)
    : 0;
  settings.randomizeVideos = elements.randomizeVideos.checked;
  settings.commentEnabled = elements.commentEnabled.checked;
  settings.commentText = elements.commentText.value;
  settings.uploadConcurrency = normalizeUploadConcurrency(elements.uploadConcurrency.value);
  settings.jobDelay = Math.min(3600, Math.max(0, Number(elements.jobDelay.value) || 0));
  if (isPhotoMode(settings)) settings = photoSettings(settings);
  scheduleSettingsSave();
}

function applySettingsToInputs() {
  updatePostingModeUi();
  elements.tokenMode.value = settings.tokenMode;
  elements.accessToken.value = settings.accessToken;
  elements.directPageId.value = settings.directPageId;
  elements.postContent.value = settings.postContent;
  elements.useVideoTitleAsContent.checked = settings.useVideoTitleAsContent;
  elements.aiEnabled.checked = settings.aiEnabled;
  elements.aiModel.value = settings.aiModel;
  elements.aiPrompt.value = settings.aiPrompt;
  elements.aiCommentPrompt.value = settings.aiCommentPrompt;
  elements.commentAiEnabled.checked = settings.commentAiEnabled;
  elements.aiApiKey.value = openAiApiKey;
  elements.randomizeVideos.checked = settings.randomizeVideos;
  elements.commentEnabled.checked = settings.commentEnabled;
  elements.commentText.value = settings.commentText;
  elements.uploadConcurrency.value = normalizeUploadConcurrency(settings.uploadConcurrency);
  elements.jobDelay.value = String(settings.jobDelay);
  syncVideosPerPageControl();
  updateTokenModeUi();
  updateContentUi();
  updateCommentUi();
}

function updateTokenModeUi() {
  elements.tokenMode.value = "user";
  elements.directPageIdField.hidden = true;
  elements.tokenWorkflowCard.hidden = true;
  elements.loadPagesButton.hidden = true;
  elements.loadPagesButton.textContent = "Tải danh sách Page";
  updateAuthControls();
}

function updateContentUi() {
  elements.postContent.disabled = editingLocked || elements.useVideoTitleAsContent.checked;
  elements.postContent.closest("label")?.classList.toggle(
    "field-disabled",
    elements.useVideoTitleAsContent.checked
  );
  const useTitle = elements.useVideoTitleAsContent.checked;
  elements.aiSourceControls.hidden = !elements.aiEnabled.checked;
  elements.aiSourceHint.textContent = useTitle ? "AI viết từ tên từng video." : "AI viết từ nội dung nhập thủ công.";
  elements.aiTestSource.textContent = useTitle
    ? (queue.length ? "Viết thử từ: " + queue[0].name : "Thêm video ở mục Nội dung để viết thử từ tên file.")
    : "Viết thử từ ô Nội dung bài viết.";
  updateAiControls();
}

function setAiStatus(message, type = "") {
  elements.aiStatus.textContent = message;
  elements.aiStatus.className = "ai-status" + (type ? " " + type : "");
}

function updateAiControls() {
  const testing = Boolean(aiTestController);
  elements.aiApiKey.disabled = starting || testing;
  elements.toggleAiKeyButton.disabled = starting || testing;
  elements.aiModel.disabled = editingLocked || testing;
  elements.aiPrompt.disabled = editingLocked || testing;
  elements.resetAiPromptButton.disabled = editingLocked || testing;
  elements.aiCommentPrompt.disabled = editingLocked || testing;
  elements.resetAiCommentPromptButton.disabled = editingLocked || testing;
  elements.testAiCommentButton.disabled = editingLocked || testing;
  elements.saveAiSettingsButton.disabled = starting || testing;
  elements.testAiButton.disabled = editingLocked || testing;
  elements.testAiButton.textContent = testing ? "Đang viết…" : "Viết thử";
  elements.cancelAiTestButton.hidden = !testing;
}

async function saveAiSettings() {
  syncSettingsFromInputs();
  clearTimeout(settingsSaveTimer);
  clearTimeout(aiKeySaveTimer);
  openAiApiKey = elements.aiApiKey.value.trim();
  try {
    await setLocal({
      [STORAGE_KEYS.SETTINGS]: settings,
      [STORAGE_KEYS.OPENAI_API_KEY]: openAiApiKey
    });
    setAiStatus("Đã lưu thiết lập AI.", "status-success");
  } catch {
    setAiStatus("Không lưu được thiết lập AI. Hãy thử lại.", "validation-message");
  }
}

async function testAiContent(commentMode = false) {
  if (aiTestController || editingLocked) return;
  syncSettingsFromInputs();
  const source = commentMode ? settings.commentText.trim() : settings.useVideoTitleAsContent
    ? (queue[0] ? titleFromFileName(queue[0].name) : "")
    : settings.postContent.trim();
  const config = { apiKey: openAiApiKey, model: settings.aiModel,
    prompt: commentMode ? settings.aiCommentPrompt : settings.aiPrompt, source };
  const validation = validateAiConfiguration(config);
  if (validation) {
    setAiStatus(validation, "validation-message");
    return;
  }
  aiTestController = new AbortController();
  elements.aiPreview.hidden = true;
  setAiStatus(commentMode ? "Đang viết lại bình luận…" : "Đang viết tiêu đề và nội dung…");
  updateAiControls();
  updateControls(runner.getSnapshot());
  try {
    const content = await (commentMode ? rewriteCommentContent : generateVideoContent)({
      ...config,
      signal: aiTestController.signal,
      onRetry: ({ nextAttempt, delayMs }) => setAiStatus(
        "OpenAI đang bận. Thử lần " + nextAttempt + " sau " + Math.ceil(delayMs / 1_000) + " giây…"
      )
    });
    elements.aiPreviewTitle.textContent = commentMode ? "Bình luận AI" : content.title;
    elements.aiPreviewCaption.textContent = commentMode ? content.comment : content.caption;
    elements.aiPreview.hidden = false;
    setAiStatus("Đã viết thử thành công.", "status-success");
  } catch (error) {
    setAiStatus(error.message || "Không viết được nội dung AI.", error.code === "ABORTED" ? "" : "validation-message");
  } finally {
    aiTestController = null;
    updateAiControls();
    updateControls(runner.getSnapshot());
  }
}

function updateCommentUi() {
  elements.commentEnabled.disabled = editingLocked;
  elements.commentTextField.hidden = !elements.commentEnabled.checked;
  elements.commentText.disabled = editingLocked || !elements.commentEnabled.checked;
  elements.commentAiField.hidden = isPhotoMode(settings) || !elements.commentEnabled.checked;
  elements.commentAiEnabled.disabled = isPhotoMode(settings) || editingLocked || !elements.commentEnabled.checked;
}

function retainedVideoIds(nextQueue = queue, nextTemplates = contentTemplates, snapshot = runner.snapshot) {
  const otherQueue = modeQueues[isPhotoMode(settings) ? "reels" : "photos"];
  return collectRetainedVideoIds([...nextQueue, ...otherQueue], nextTemplates, snapshot);
}

function renderContentTemplates() {
  contentTemplatesView.render(visibleContentTemplates(), {
    disabled: editingLocked || importingVideos || savingTemplate || applyingTemplate
  });
}

function contentTemplateById(templateId) {
  return visibleContentTemplates().find((template) => template.id === templateId) || null;
}

function openContentTemplateEditor(templateId = null) {
  if (editingLocked || importingVideos || savingTemplate || applyingTemplate) return;
  syncSettingsFromInputs();
  const template = templateId ? contentTemplateById(templateId) : null;
  if (templateId && !template) {
    toast("Mẫu không còn tồn tại.", "error");
    renderContentTemplates();
    return;
  }
  contentTemplatesView.openEditor({
    template,
    videos: queue,
    settings
  });
}

async function saveContentTemplate() {
  if (savingTemplate || editingLocked || importingVideos || applyingTemplate) return;
  syncSettingsFromInputs();
  const name = normalizeTemplateName(elements.templateName.value);
  const editingId = contentTemplatesView.editingTemplateId;
  const existing = editingId ? contentTemplateById(editingId) : null;

  if (!name) {
    contentTemplatesView.setError("Hãy nhập tên mẫu.");
    elements.templateName.focus();
    return;
  }
  const duplicate = visibleContentTemplates().some((template) => (
    template.id !== editingId
    && template.name.toLocaleLowerCase("vi-VN") === name.toLocaleLowerCase("vi-VN")
  ));
  if (duplicate) {
    contentTemplatesView.setError("Tên mẫu đã tồn tại. Hãy chọn tên khác.");
    elements.templateName.focus();
    return;
  }
  if (!existing && contentTemplates.length >= CONTENT_TEMPLATE_LIMITS.MAX_COUNT) {
    contentTemplatesView.setError(
      "Đã đạt giới hạn " + CONTENT_TEMPLATE_LIMITS.MAX_COUNT + " mẫu. Hãy xóa bớt mẫu cũ."
    );
    return;
  }

  savingTemplate = true;
  contentTemplatesView.setSaving(true);
  contentTemplatesView.setError("");
  contentTemplatesView.setDisabled(true);
  try {
    const availableVideoIds = new Set(await listVideoIds());
    const missingVideos = queue.filter((video) => !availableVideoIds.has(video.id));
    if (missingVideos.length) {
      throw new Error(
        formatNumber(missingVideos.length)
        + " " + mediaLabel() + " không còn trong bộ nhớ. Hãy chọn lại tệp trước khi lưu mẫu."
      );
    }
    const template = createContentTemplate({
      id: existing?.id,
      createdAt: existing?.createdAt,
      name,
      mediaType: activeMediaType(),
      videos: queue,
      settings
    });
    const nextTemplates = existing
      ? contentTemplates.map((item) => item.id === existing.id ? template : item)
      : [template, ...contentTemplates];
    await setLocal({ [STORAGE_KEYS.CONTENT_TEMPLATES]: nextTemplates });
    contentTemplates = nextTemplates;
    contentTemplatesView.closeEditor();
    renderContentTemplates();
    toast(existing ? "Đã cập nhật mẫu \"" + name + "\"." : "Đã lưu mẫu \"" + name + "\".", "success");
  } catch (error) {
    contentTemplatesView.setError(error.message || "Không lưu được mẫu.");
  } finally {
    savingTemplate = false;
    contentTemplatesView.setSaving(false);
    contentTemplatesView.setDisabled(editingLocked || importingVideos || applyingTemplate);
  }
}

async function applyContentTemplate(templateId) {
  if (editingLocked || importingVideos || applyingTemplate || savingTemplate) return;
  const template = contentTemplateById(templateId);
  if (!template) {
    toast("Mẫu không còn tồn tại.", "error");
    renderContentTemplates();
    return;
  }

  applyingTemplate = true;
  updateControls(runner.getSnapshot());
  try {
    const availableVideoIds = new Set(await listVideoIds());
    const nextQueue = template.videos
      .filter((video) => availableVideoIds.has(video.id))
      .map((video) => ({ ...video }));
    const missingCount = template.videos.length - nextQueue.length;
    const nextSettings = applyContentTemplateSettings(settings, template);
    clearTimeout(settingsSaveTimer);
    await setLocal({
      [STORAGE_KEYS.SETTINGS]: nextSettings,
      [queueStorageKey(settings)]: nextQueue
    });
    settings = nextSettings;
    queue = nextQueue;
    applySettingsToInputs();
    renderQueue();
    setVideoImportStatus(
      "Đã nạp " + formatNumber(nextQueue.length) + " " + mediaLabel() + " từ mẫu \"" + template.name + "\"."
        + (missingCount ? " Thiếu " + formatNumber(missingCount) + " " + mediaLabel() + " đã mất dữ liệu." : ""),
      missingCount ? "warning" : "success"
    );
    try {
      await pruneVideos(retainedVideoIds());
    } catch {
      // Dữ liệu thừa sẽ được dọn lại ở lần mở dashboard tiếp theo.
    }
    toast(
      missingCount
        ? "Đã áp dụng mẫu nhưng có " + formatNumber(missingCount) + " " + mediaLabel() + " cần chọn lại."
        : "Đã áp dụng mẫu \"" + template.name + "\".",
      missingCount ? "error" : "success"
    );
  } catch (error) {
    toast(error.message || "Không áp dụng được mẫu.", "error");
  } finally {
    applyingTemplate = false;
    renderContentTemplates();
    updateControls(runner.getSnapshot());
  }
}

async function deleteContentTemplate(templateId) {
  if (editingLocked || importingVideos || savingTemplate || applyingTemplate) return;
  const template = contentTemplateById(templateId);
  if (!template) return;
  if (!window.confirm("Xóa mẫu \"" + template.name + "\"? Tệp đang dùng ở mục Nội dung sẽ không bị xóa.")) {
    return;
  }

  const nextTemplates = contentTemplates.filter((item) => item.id !== templateId);
  applyingTemplate = true;
  contentTemplatesView.setDisabled(true);
  try {
    await setLocal({ [STORAGE_KEYS.CONTENT_TEMPLATES]: nextTemplates });
    contentTemplates = nextTemplates;
    if (contentTemplatesView.editingTemplateId === templateId) {
      contentTemplatesView.closeEditor();
    }
    renderContentTemplates();
    try {
      await pruneVideos(retainedVideoIds(queue, nextTemplates));
    } catch {
      // Dữ liệu thừa sẽ được dọn lại ở lần mở dashboard tiếp theo.
    }
    toast("Đã xóa mẫu \"" + template.name + "\".", "success");
  } catch (error) {
    toast(error.message || "Không xóa được mẫu.", "error");
  } finally {
    applyingTemplate = false;
    renderContentTemplates();
    updateControls(runner.getSnapshot());
  }
}

function syncVideosPerPageControl() {
  const previous = Math.max(0, Math.floor(Number(settings.videosPerPage) || 0));
  const normalized = queue.length ? Math.min(previous, queue.length) : 0;
  settings.videosPerPage = normalized;
  elements.videosPerPage.value = String(normalized);
  elements.videosPerPage.max = String(queue.length);
  elements.videosPerPage.placeholder = queue.length
    ? "0 = tất cả " + formatNumber(queue.length) + " video"
    : "0 = tất cả";
}

function effectiveVideosPerPage() {
  if (isPhotoMode(settings)) return queue.length;
  const requested = Math.max(
    0,
    Math.floor(Number(elements.videosPerPage?.value) || 0)
  );
  return requested > 0 ? Math.min(requested, queue.length) : queue.length;
}

function selectedPages() {
  const selected = new Set(settings.selectedPageIds.map(String));
  return pages.filter((page) => selected.has(String(page.id)));
}

function updateStartLabel() {
  const pageTotal = selectedPages().length;
  const videoTotal = effectiveVideosPerPage();
  const jobTotal = pageTotal * videoTotal;
  const hasHistory = Boolean(runner.snapshot?.jobs.length);
  elements.startButton.textContent = hasHistory
    ? (jobTotal ? "Thêm " + formatNumber(jobTotal) + " lượt vào tiến trình" : "Thêm vào tiến trình")
    : (jobTotal ? "Đăng " + formatNumber(jobTotal) + " lượt" : "Bắt đầu đăng");
  elements.runSummary.textContent = jobTotal
    ? formatNumber(videoTotal) + " " + mediaLabel() + " × " + formatNumber(pageTotal) + " Page"
    : "Chọn Page và " + mediaLabel() + " để bắt đầu.";
  if (isPhotoMode(settings)) {
    elements.runSpeedHint.textContent = "Mỗi ảnh là một bài; các bài trên cùng Page được đăng tuần tự.";
    return;
  }
  const active = ["running", "pausing", "paused"].includes(runner.snapshot?.status);
  elements.runSpeedHint.textContent = postingSpeedHint(active
    ? runner.snapshot.speed?.configured : elements.uploadConcurrency?.value);
}

function pageMatchesSearch(page, query) {
  const haystack = (page.name + " " + page.id).toLocaleLowerCase("vi");
  return haystack.includes(query);
}

function renderPages() {
  elements.pageList.textContent = "";
  const query = elements.pageSearch.value.trim().toLocaleLowerCase("vi");
  if (!pages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Chưa có Page. Nhập token rồi tải danh sách.";
    elements.pageList.appendChild(empty);
    elements.pageCount.textContent = "0 Page";
    elements.navPageCount.textContent = "0";
    updateStartLabel();
    return;
  }
  const selected = new Set(settings.selectedPageIds.map(String));
  let visible = 0;
  for (const page of pages) {
    const row = document.createElement("label");
    row.className = "page-item";
    row.dataset.pageId = page.id;
    const match = pageMatchesSearch(page, query);
    row.hidden = !match;
    if (match) visible += 1;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "page-checkbox";
    checkbox.checked = selected.has(page.id);
    checkbox.addEventListener("change", () => {
      const next = new Set(settings.selectedPageIds.map(String));
      if (checkbox.checked) next.add(page.id);
      else next.delete(page.id);
      settings.selectedPageIds = [...next];
      scheduleSettingsSave();
      renderPageCount();
      updateStartLabel();
    });

    const avatar = document.createElement("span");
    avatar.className = "page-avatar";
    if (page.pictureUrl) {
      const image = document.createElement("img");
      image.src = page.pictureUrl;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      avatar.appendChild(image);
    } else {
      avatar.textContent = page.name.slice(0, 1).toUpperCase();
    }

    const info = document.createElement("span");
    info.className = "page-info";
    const name = document.createElement("span");
    name.className = "page-name";
    name.textContent = page.name;
    const id = document.createElement("span");
    id.className = "page-id";
    id.textContent = page.id;
    info.append(name, id);
    row.append(checkbox, avatar, info);
    elements.pageList.appendChild(row);
  }
  if (!visible) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Không có Page khớp từ khóa.";
    elements.pageList.appendChild(empty);
  }
  renderPageCount();
  updateStartLabel();
}

function renderPageCount() {
  const selected = selectedPages().length;
  elements.pageCount.textContent = formatNumber(selected) + "/" + formatNumber(pages.length) + " đã chọn";
  elements.navPageCount.textContent = formatNumber(selected);
}

function formatStatistic(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? formatNumber(value) : "—";
}

function statisticTotal(rows, key) {
  return rows.reduce((total, row) => {
    const value = row?.[key];
    return total + (
      value !== null && value !== undefined && Number.isFinite(Number(value))
        ? Number(value)
        : 0
    );
  }, 0);
}

function setStatisticsStatus(message, type = "") {
  elements.statisticsStatus.textContent = message;
  elements.statisticsStatus.className = type || "";
}

function renderStatisticsSummary(rows = []) {
  elements.statisticsPageCount.textContent = formatNumber(rows.length);
  elements.statisticsViews.textContent = formatNumber(statisticTotal(rows, "views"));
  elements.statisticsInteractions.textContent = formatNumber(statisticTotal(rows, "interactions"));
  elements.statisticsLikes.textContent = formatNumber(statisticTotal(rows, "likes"));
  elements.statisticsComments.textContent = formatNumber(statisticTotal(rows, "comments"));
  elements.statisticsShares.textContent = formatNumber(statisticTotal(rows, "shares"));
}

function createStatisticsPageCell(row) {
  const cell = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "statistics-page";
  const avatar = document.createElement("span");
  avatar.className = "page-avatar statistics-avatar";
  if (row.pictureUrl) {
    const image = document.createElement("img");
    image.src = row.pictureUrl;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    avatar.appendChild(image);
  } else {
    avatar.textContent = row.pageName.slice(0, 1).toUpperCase();
  }
  const copy = document.createElement("span");
  copy.className = "page-info";
  const name = document.createElement("strong");
  name.className = "page-name";
  name.textContent = row.pageName;
  const id = document.createElement("span");
  id.className = "page-id";
  id.textContent = row.pageId;
  copy.append(name, id);
  wrapper.append(avatar, copy);
  cell.appendChild(wrapper);
  return cell;
}

function renderStatistics(rows = []) {
  renderStatisticsSummary(rows);
  elements.statisticsBody.textContent = "";
  if (!rows.length) {
    const emptyRow = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "table-empty";
    cell.textContent = statisticsLoading ? "Đang lấy dữ liệu thống kê…" : "Chưa tải thống kê.";
    emptyRow.appendChild(cell);
    elements.statisticsBody.appendChild(emptyRow);
    return;
  }

  for (const row of rows) {
    const tableRow = document.createElement("tr");
    tableRow.appendChild(createStatisticsPageCell(row));
    for (const key of ["views", "interactions", "likes", "comments", "shares"]) {
      const cell = document.createElement("td");
      cell.className = "statistics-number";
      cell.textContent = formatStatistic(row[key]);
      tableRow.appendChild(cell);
    }
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = "status-text " + (
      row.status === "complete"
        ? "succeeded"
        : row.status === "partial"
          ? "warning"
          : "failed"
    );
    status.textContent = row.status === "complete"
      ? "Đầy đủ"
      : row.status === "partial"
        ? "Một phần"
        : "Không lấy được";
    if (row.warnings?.length) status.title = row.warnings.join("\n");
    statusCell.appendChild(status);
    tableRow.appendChild(statusCell);
    elements.statisticsBody.appendChild(tableRow);
  }
}

function statisticsKey(days) {
  return days + ":" + pages.map((page) => page.id).join(",");
}

async function loadStatistics(options = {}) {
  if (statisticsLoading) return;
  const days = Number(elements.statisticsPeriod.value) === 30 ? 30 : 7;
  if (!settings.accessToken) {
    setStatisticsStatus("Chưa có token. Hãy lấy token tự động trước.", "validation-message");
    renderStatistics([]);
    return;
  }
  if (!pages.length) await loadPages({ silent: true });
  if (!pages.length) {
    setStatisticsStatus("Không có Page để thống kê.", "validation-message");
    renderStatistics([]);
    return;
  }
  const cacheKey = statisticsKey(days);
  if (!options.force && cacheKey === statisticsLoadedKey && statisticsRows.length) {
    renderStatistics(statisticsRows);
    return;
  }

  statisticsLoading = true;
  elements.refreshStatisticsButton.disabled = true;
  elements.statisticsPeriod.disabled = true;
  elements.statisticsProgress.hidden = false;
  elements.statisticsProgress.max = pages.length;
  elements.statisticsProgress.value = 0;
  elements.statisticsUpdatedAt.textContent = "";
  setStatisticsStatus("Đang lấy thống kê 0/" + formatNumber(pages.length) + " Page…");
  renderStatistics([]);

  const targetPages = pages.slice();
  const results = new Array(targetPages.length);
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (nextIndex < targetPages.length) {
      const index = nextIndex;
      nextIndex += 1;
      const page = targetPages[index];
      try {
        results[index] = await getPageStatistics(page, { days });
      } catch (error) {
        results[index] = {
          pageId: page.id,
          pageName: page.name,
          pictureUrl: page.pictureUrl,
          views: null,
          interactions: null,
          likes: null,
          comments: null,
          shares: null,
          status: "error",
          warnings: [error?.message || "Không lấy được thống kê."]
        };
      }
      completed += 1;
      elements.statisticsProgress.value = completed;
      setStatisticsStatus(
        "Đang lấy thống kê " + formatNumber(completed)
          + "/" + formatNumber(targetPages.length) + " Page…"
      );
      renderStatistics(results.filter(Boolean));
    }
  };

  try {
    const workerCount = Math.min(3, targetPages.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    statisticsRows = results.filter(Boolean);
    statisticsLoadedKey = cacheKey;
    renderStatistics(statisticsRows);
    const failed = statisticsRows.filter((row) => row.status === "error").length;
    const partial = statisticsRows.filter((row) => row.status === "partial").length;
    const issueCount = failed + partial;
    setStatisticsStatus(
      issueCount
        ? "Đã thống kê " + formatNumber(statisticsRows.length)
          + " Page; " + formatNumber(issueCount) + " Page thiếu một phần dữ liệu."
        : "Đã thống kê đầy đủ " + formatNumber(statisticsRows.length) + " Page.",
      issueCount ? "statistics-warning" : "status-success"
    );
    elements.statisticsUpdatedAt.textContent = "Cập nhật "
      + new Date().toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      });
  } finally {
    statisticsLoading = false;
    elements.refreshStatisticsButton.disabled = false;
    elements.statisticsPeriod.disabled = false;
    elements.statisticsProgress.hidden = true;
  }
}

async function loadPages(options = {}) {
  if (loadingPages) return;
  syncSettingsFromInputs();
  if (!settings.accessToken) {
    setTokenStatus("Chưa nhập token.", "validation-message");
    return;
  }
  if (settings.tokenMode === "page" && !/^\d{5,30}$/.test(settings.directPageId)) {
    setTokenStatus("Page ID phải là dãy số.", "validation-message");
    return;
  }

  loadingPages = true;
  updateAuthControls();
  setTokenStatus("Đang tải Page…");
  try {
    pages = settings.tokenMode === "page"
      ? [await getDirectPage(settings.accessToken, settings.directPageId)]
      : await getManagedPages(settings.accessToken);
    if (!pages.length) throw new Error("Token không trả về Page nào đang quản lý.");
    if (settings.tokenMode === "page") {
      settings.selectedPageIds = [pages[0].id];
    } else {
      const validIds = new Set(pages.map((page) => page.id));
      settings.selectedPageIds = settings.selectedPageIds.filter((id) => validIds.has(String(id)));
    }
    runner.setPages(pages);
    statisticsRows = [];
    statisticsLoadedKey = "";
    scheduleSettingsSave();
    renderPages();
    setTokenStatus(settings.tokenMode === "user"
      ? "Đã tự động lấy token thành công."
      : "Đã kết nối Page thành công.", "status-success");
    if (!options.silent) toast("Đã tải danh sách Page.", "success");
  } catch (error) {
    pages = [];
    statisticsRows = [];
    statisticsLoadedKey = "";
    runner.setPages([]);
    renderPages();
    setTokenStatus(error.message || "Không tải được Page.", "validation-message");
    if (!options.silent) toast(error.message || "Không tải được Page.", "error");
  } finally {
    loadingPages = false;
    updateAuthControls();
    updateControls(runner.getSnapshot());
  }
}

async function autoFetchToken() {
  if (loadingPages) return;
  if (loadingToken) {
    tokenWorkflow.requestRetry();
    return;
  }
  loadingToken = true;
  updateAuthControls();
  elements.autoTokenButton.textContent = "Đang lấy token…";
  try {
    const token = await tokenWorkflow.acquire();
    elements.accessToken.value = token;
    settings.accessToken = token;
    settings.tokenMode = "user";
    elements.tokenMode.value = "user";
    updateTokenModeUi();
    scheduleSettingsSave();
    setTokenStatus("Đã lấy User Token.", "status-success");
    toast("Lấy User Token thành công.", "success");
    await loadPages({ silent: true });
  } catch (error) {
    tokenWorkflowView.render({
      phase: "error",
      message: error.message || "Không lấy được token."
    });
    toast(error.message || "Không lấy được token.", "error");
  } finally {
    loadingToken = false;
    elements.autoTokenButton.textContent = "Lấy token tự động";
    updateAuthControls();
  }
}

function setVideoImportStatus(message, type = "") {
  elements.videoImportStatus.textContent = message || "";
  elements.videoImportStatus.className = "import-status" + (type ? " " + type : "");
  elements.videoImportStatus.hidden = !message;
}

function yieldToUi() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function addVideoFiles(fileList) {
  if (importingVideos || editingLocked || savingTemplate || applyingTemplate) return;
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  importingVideos = true;
  updateControls(runner.getSnapshot());
  const knownVideos = new Set(queue.map(videoFingerprint));
  let added = 0;
  let duplicates = 0;
  let rejected = 0;
  let firstError = "";
  let persistenceError = null;
  let lastCheckpointSaved = 0;

  try {
    for (let index = 0; index < incoming.length; index += 1) {
      const file = incoming[index];
      setVideoImportStatus(
        "Đang thêm " + mediaLabel() + " " + formatNumber(index + 1) + "/" + formatNumber(incoming.length) + "…"
      );
      try {
        await (isPhotoMode(settings) ? validatePhotoFile(file) : validateVideoFile(file));
        const fingerprint = videoFingerprint(file);
        if (knownVideos.has(fingerprint)) {
          duplicates += 1;
          continue;
        }
        const id = crypto.randomUUID();
        await putVideo(id, file);
        queue.push({
          id,
          mediaType: activeMediaType(),
          name: file.name,
          size: file.size,
          type: file.type || "",
          lastModified: file.lastModified,
          title: titleFromFileName(file.name),
          caption: "",
          createdAt: new Date().toISOString()
        });
        knownVideos.add(fingerprint);
        added += 1;
      } catch (error) {
        rejected += 1;
        firstError ||= error?.message || "Không thêm được " + mediaLabel() + ".";
      }

      if (added - lastCheckpointSaved >= QUEUE_SAVE_CHECKPOINT) {
        try {
          await setLocal({ [queueStorageKey(settings)]: queue });
          persistenceError = null;
        } catch (error) {
          persistenceError = error;
        }
        lastCheckpointSaved = added;
      }
      if ((index + 1) % 10 === 0) await yieldToUi();
    }

    if (added) {
      try {
        await setLocal({ [queueStorageKey(settings)]: queue });
        persistenceError = null;
      } catch (error) {
        persistenceError = error;
      }
    }
  } finally {
    importingVideos = false;
    renderQueue();
  }

  const summary = [
    added ? "đã thêm " + formatNumber(added) : "không có " + mediaLabel() + " mới",
    duplicates ? "bỏ qua " + formatNumber(duplicates) + " " + mediaLabel() + " trùng" : "",
    rejected ? formatNumber(rejected) + " " + mediaLabel() + " không hợp lệ" : ""
  ].filter(Boolean).join(" · ");

  if (persistenceError) {
    setVideoImportStatus(
      "Đã thêm vào phiên hiện tại nhưng chưa lưu được hàng đợi: " + persistenceError.message,
      "error"
    );
    toast("Không lưu được hàng đợi " + mediaLabel() + ".", "error");
  } else {
    setVideoImportStatus(summary.charAt(0).toLocaleUpperCase("vi-VN") + summary.slice(1) + ".", rejected ? "warning" : "success");
  }
  if (added) toast("Đã thêm " + formatNumber(added) + " " + mediaLabel() + ".", "success");
  if (rejected) {
    toast(
      "Không thêm được " + formatNumber(rejected) + " " + mediaLabel() + ". " + firstError,
      "error"
    );
  }
}

function renderQueue() {
  elements.videoCount.textContent = formatNumber(queue.length) + " " + mediaLabel();
  elements.navVideoCount.textContent = formatNumber(queue.length);
  elements.dropZoneTitle.textContent = queue.length
    ? "Đã chọn " + formatNumber(queue.length) + " " + mediaLabel() + " · Bấm để thêm"
    : "Chọn hoặc thả " + mediaLabel() + " vào đây";
  const previewNames = queue.slice(0, 2).map((video) => video.name).join(" · ");
  elements.dropZoneHint.textContent = queue.length
    ? previewNames + (queue.length > 2 ? " · và " + formatNumber(queue.length - 2) + " " + mediaLabel() + " khác" : "")
    : isPhotoMode(settings) ? "JPG, PNG, GIF · Tối đa 10 MB mỗi ảnh" : "MP4, MOV, WebM · Không giới hạn số lượng";
  elements.clearAllVideosButton.disabled = editingLocked || importingVideos || !queue.length;
  syncVideosPerPageControl();
  updateStartLabel();
  updateControls(runner.getSnapshot());
  updateContentUi();
}

async function clearAllVideos() {
  if (starting || importingVideos || applyingTemplate || savingTemplate) return;
  starting = true;
  updateControls(runner.getSnapshot());
  try {
    await setLocal({ [queueStorageKey(settings)]: [] });
    queue = [];
    renderQueue();
    try {
      await pruneVideos(retainedVideoIds());
    } catch {
      // Giữ thao tác xóa hàng đợi thành công; dữ liệu thừa sẽ được dọn sau.
    }
    toast("Đã xóa tất cả " + mediaLabel() + " đã chọn.", "success");
  } catch (error) {
    toast("Không xóa được toàn bộ " + mediaLabel() + ": " + error.message, "error");
  } finally {
    starting = false;
    updateControls(runner.getSnapshot());
  }
}

function validateRun() {
  const chosenPages = selectedPages();
  if (!settings.accessToken) return "Chưa nhập Access Token.";
  if (!pages.length) return "Hãy tải danh sách Page.";
  if (!chosenPages.length) return "Chọn ít nhất một Page.";
  if (!queue.length) return "Thêm ít nhất một " + mediaLabel() + ".";
  if (settings.aiEnabled) {
    const aiError = validateAiConfiguration({
      apiKey: openAiApiKey,
      model: settings.aiModel,
      prompt: settings.aiPrompt,
      source: settings.useVideoTitleAsContent ? undefined : settings.postContent.trim()
    });
    if (aiError) return aiError;
  }
  if (elements.commentEnabled.checked && !elements.commentText.value.trim()) {
    return "Nhập nội dung bình luận tự động.";
  }
  if (settings.commentEnabled && settings.commentAiEnabled) {
    const validation = validateAiConfiguration({ apiKey: openAiApiKey, model: settings.aiModel,
      prompt: settings.aiCommentPrompt, source: settings.commentText.trim() });
    if (validation) return validation;
  }
  return null;
}

async function startRun() {
  if (starting || importingVideos || savingTemplate || applyingTemplate || aiTestController) return;
  syncSettingsFromInputs();
  const errorMessage = validateRun();
  elements.validationMessage.textContent = errorMessage || "";
  if (errorMessage) return;

  setActivePanel("results");

  starting = true;
  updateControls(runner.getSnapshot());
  try {
    const useTitle = settings.useVideoTitleAsContent;
    const config = {
      mediaType: activeMediaType(),
      videos: queue.map((item) => ({
        ...item,
        title: titleFromFileName(item.name),
        caption: useTitle ? titleFromFileName(item.name) : settings.postContent.trim()
      })),
      pages: selectedPages(),
      videosPerPage: settings.videosPerPage,
      randomizeVideos: settings.randomizeVideos,
      ai: { enabled: settings.aiEnabled, model: settings.aiModel, prompt: settings.aiPrompt },
      commentAi: { enabled: settings.commentEnabled && settings.commentAiEnabled,
        model: settings.aiModel, prompt: settings.aiCommentPrompt },
      commentText: settings.commentEnabled ? settings.commentText.trim() : "",
      uploadConcurrency: settings.uploadConcurrency,
      delaySeconds: settings.jobDelay
    };
    const added = await runner.enqueueBatch(config);
    toast("Đã lưu đợt " + added.batchNumber + " vào tiến trình.", "success");
  } catch (error) {
    toast(error.message || "Không bắt đầu được tiến trình.", "error");
  } finally {
    starting = false;
    updateControls(runner.getSnapshot());
  }
}

async function prepareNextBatch() {
  if (starting || importingVideos || savingTemplate || applyingTemplate || aiTestController) return;
  syncSettingsFromInputs();
  const nextSettings = { ...settings, selectedPageIds: [], postContent: "", commentText: "", videosPerPage: 0 };
  starting = true;
  updateControls(runner.getSnapshot());
  try {
    clearTimeout(settingsSaveTimer);
    await setLocal({ [STORAGE_KEYS.SETTINGS]: nextSettings, [queueStorageKey(settings)]: [] });
    queue = [];
    settings = nextSettings;
    elements.pageSearch.value = "";
    elements.validationMessage.textContent = "";
    applySettingsToInputs();
    renderQueue();
    renderPages();
    setActivePanel("auth");
    await pruneVideos(retainedVideoIds()).catch(() => {});
    toast("Chọn Page và nội dung cho đợt tiếp theo.", "success");
  } catch (error) {
    toast("Không tạo được đợt mới: " + error.message, "error");
  } finally {
    starting = false;
    updateControls(runner.getSnapshot());
  }
}

async function ensurePagesForResume() {
  if (pages.length) {
    runner.setPages(pages);
    return true;
  }
  await loadPages({ silent: true });
  if (!pages.length) {
    toast("Không tải được Page Token để tiếp tục.", "error");
    return false;
  }
  runner.setPages(pages);
  return true;
}

async function resumeRun(retryFailed = false) {
  try {
    if (!await ensurePagesForResume()) return;
    setActivePanel("results");
    if (retryFailed) await runner.retryFailed(
      { model: settings.aiModel, prompt: settings.aiPrompt },
      { model: settings.aiModel, prompt: settings.aiCommentPrompt }
    );
    else await runner.resume();
  } catch (error) {
    toast(error.message || "Không tiếp tục được tiến trình.", "error");
  }
}

function scheduleSnapshotRender(snapshot) {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    renderSnapshot(snapshot);
  });
}

function renderSnapshot(snapshot) {
  runResultsView.render(snapshot);
  activityLogView.render(snapshot?.logs || []);
  updateControls(snapshot);
  if (!isPhotoMode(settings) && snapshot?.speed && ["running", "pausing", "paused"].includes(snapshot.status)) {
    elements.runSpeedHint.textContent = postingSpeedHint(snapshot.speed.configured);
  } else {
    updateStartLabel();
  }
}

function setEditingDisabled(disabled) {
  editingLocked = disabled;
  [
    elements.tokenMode,
    elements.directPageId,
    elements.accessToken,
    elements.autoTokenButton,
    elements.loadPagesButton,
    elements.selectVisiblePages,
    elements.clearPageSelection,
    elements.useVideoTitleAsContent,
    elements.aiEnabled,
    elements.videosPerPage,
    elements.randomizeVideos,
    elements.uploadConcurrency,
    elements.jobDelay
  ].forEach((node) => {
    node.disabled = disabled;
  });
  const videoSelectionLocked = disabled || importingVideos;
  elements.postingModeTabs.querySelectorAll("button").forEach((node) => {
    node.disabled = videoSelectionLocked || savingTemplate || applyingTemplate || Boolean(aiTestController);
  });
  void photoPreviewView?.render(queue, {
    enabled: isPhotoMode(settings), disabled: videoSelectionLocked || savingTemplate || applyingTemplate
  });
  elements.videoInput.disabled = videoSelectionLocked;
  elements.dropZone.disabled = videoSelectionLocked;
  elements.dropZone.setAttribute("aria-disabled", String(videoSelectionLocked));
  document.querySelectorAll(".page-checkbox").forEach((node) => {
    node.disabled = disabled;
  });
  elements.clearAllVideosButton.disabled = videoSelectionLocked || !queue.length;
  contentTemplatesView.setDisabled(
    videoSelectionLocked || savingTemplate || applyingTemplate
  );
  updateContentUi();
  updateCommentUi();
  updateAuthControls();
}

function updateControls(snapshot) {
  const status = snapshot?.status || "idle";
  const active = ["running", "pausing", "paused"].includes(status);
  const running = status === "running";
  const pausing = status === "pausing";
  const paused = status === "paused";
  const hasPending = snapshot?.jobs?.some((job) => job.status === JOB_STATUS.PENDING);
  const hasRetry = snapshot?.jobs?.some((job) => [
    JOB_STATUS.FAILED,
    JOB_STATUS.INTERRUPTED
  ].includes(job.status) || hasRetryableComment(job));

  setEditingDisabled(starting || applyingTemplate);
  elements.uploadConcurrency.disabled = active || starting;
  if (active && snapshot.speed) elements.uploadConcurrency.value = normalizeUploadConcurrency(snapshot.speed.configured);
  elements.startButton.disabled = starting || loadingPages || loadingToken || importingVideos || savingTemplate || applyingTemplate || Boolean(aiTestController);
  elements.startButton.hidden = false;
  elements.newBatchButton.disabled = starting || importingVideos || savingTemplate || applyingTemplate || Boolean(aiTestController);
  elements.pauseButton.hidden = !running;
  elements.pauseButton.disabled = pausing;
  elements.resumeButton.hidden = !paused || !hasPending;
  elements.stopButton.hidden = !(active || paused);
  elements.retryButton.hidden = active || !hasRetry;
  elements.exportCsvButton.disabled = !snapshot?.jobs?.length;
  elements.clearResultsButton.disabled = active || starting || !snapshot?.jobs?.length;
  updateStartLabel();
}

function exportCsv() {
  exportRunCsv(runner.getSnapshot());
}

async function clearResults() {
  if (starting) return;
  starting = true;
  updateControls(runner.getSnapshot());
  try {
    await runner.clear();
    runResultsView.reset();
    renderSnapshot(null);
    await pruneVideos(retainedVideoIds()).catch(() => {});
  } catch (error) {
    toast(error.message || "Không xóa được kết quả.", "error");
  } finally {
    starting = false;
    updateControls(runner.getSnapshot());
  }
}

function setupEvents() {
  elements.postingModeTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-posting-mode]");
    if (tab && !tab.disabled) void switchPostingMode(tab.dataset.postingMode);
  });
  elements.postingModeTabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(elements.postingModeTabs.querySelectorAll("button:not(:disabled)"));
    if (!tabs.length) return;
    event.preventDefault();
    const current = tabs.indexOf(event.target);
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].focus();
    void switchPostingMode(tabs[index].dataset.postingMode);
  });
  elements.photoPreviewList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-photo]");
    if (!button || button.disabled || !isPhotoMode(settings) || starting || importingVideos || savingTemplate || applyingTemplate) return;
    const nextQueue = queue.filter((item) => item.id !== button.dataset.removePhoto);
    starting = true;
    updateControls(runner.getSnapshot());
    try {
      await setLocal({ [STORAGE_KEYS.PHOTO_QUEUE]: nextQueue });
      queue = nextQueue;
      renderQueue();
      await pruneVideos(retainedVideoIds()).catch(() => {});
    } catch (error) {
      toast("Không bỏ được ảnh: " + error.message, "error");
    } finally {
      starting = false;
      updateControls(runner.getSnapshot());
    }
  });
  elements.dashboardTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-panel]");
    if (tab) setActivePanel(tab.dataset.panel);
  });
  elements.dashboardTabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(elements.dashboardTabs.querySelectorAll("[data-panel]"));
    const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    let next = current;
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    event.preventDefault();
    setActivePanel(tabs[next].dataset.panel);
    tabs[next].focus();
  });

  elements.tokenMode.addEventListener("change", () => {
    if (elements.tokenMode.value === "page") tokenWorkflow.cancel();
    updateTokenModeUi();
    syncSettingsFromInputs();
    pages = [];
    renderPages();
  });
  elements.directPageId.addEventListener("input", syncSettingsFromInputs);
  elements.accessToken.addEventListener("input", syncSettingsFromInputs);
  elements.toggleToken.addEventListener("click", () => {
    const showing = elements.accessToken.type === "text";
    elements.accessToken.type = showing ? "password" : "text";
    elements.toggleToken.textContent = showing ? "Hiện" : "Ẩn";
  });
  elements.autoTokenButton.addEventListener("click", autoFetchToken);
  elements.openAdsManagerButton.addEventListener("click", async () => {
    try {
      await tokenWorkflow.openVerificationTab();
      if (loadingToken) tokenWorkflow.requestRetry();
    } catch (error) {
      toast(error.message || "Không mở được Ads Manager.", "error");
    }
  });
  elements.retryTokenButton.addEventListener("click", () => {
    if (loadingToken) tokenWorkflow.requestRetry();
    else autoFetchToken();
  });
  elements.loadPagesButton.addEventListener("click", () => loadPages());
  elements.refreshStatisticsButton.addEventListener("click", () => {
    loadStatistics({ force: true }).catch((error) => {
      setStatisticsStatus(error.message || "Không lấy được thống kê.", "validation-message");
    });
  });
  elements.statisticsPeriod.addEventListener("change", () => {
    loadStatistics({ force: true }).catch((error) => {
      setStatisticsStatus(error.message || "Không lấy được thống kê.", "validation-message");
    });
  });
  elements.pageSearch.addEventListener("input", renderPages);
  elements.selectVisiblePages.addEventListener("click", () => {
    const selected = new Set(settings.selectedPageIds.map(String));
    for (const row of elements.pageList.querySelectorAll(".page-item:not([hidden])")) {
      selected.add(row.dataset.pageId);
    }
    settings.selectedPageIds = [...selected];
    scheduleSettingsSave();
    renderPages();
  });
  elements.clearPageSelection.addEventListener("click", () => {
    settings.selectedPageIds = [];
    scheduleSettingsSave();
    renderPages();
  });

  elements.addTemplateButton.addEventListener("click", () => openContentTemplateEditor());
  elements.templateList.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-template-action]");
    if (!actionButton || !elements.templateList.contains(actionButton)) return;
    const templateId = actionButton.dataset.templateId;
    if (actionButton.dataset.templateAction === "apply") {
      await applyContentTemplate(templateId);
    } else if (actionButton.dataset.templateAction === "update") {
      openContentTemplateEditor(templateId);
    } else if (actionButton.dataset.templateAction === "delete") {
      await deleteContentTemplate(templateId);
    }
  });
  elements.templateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveContentTemplate();
  });
  elements.templateName.addEventListener("input", () => contentTemplatesView.setError(""));
  elements.closeTemplateDialogButton.addEventListener("click", () => {
    if (!savingTemplate) contentTemplatesView.closeEditor();
  });
  elements.cancelTemplateButton.addEventListener("click", () => {
    if (!savingTemplate) contentTemplatesView.closeEditor();
  });
  elements.templateDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!savingTemplate) contentTemplatesView.closeEditor();
  });
  elements.templateDialog.addEventListener("click", (event) => {
    if (event.target !== elements.templateDialog || savingTemplate) return;
    const bounds = elements.templateDialog.getBoundingClientRect();
    const inside = event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom;
    if (!inside) contentTemplatesView.closeEditor();
  });

  const openPicker = () => {
    if (elements.videoInput.disabled) return;
    elements.videoInput.click();
  };
  elements.dropZone.addEventListener("click", openPicker);
  elements.videoInput.addEventListener("change", async () => {
    await addVideoFiles(elements.videoInput.files);
    elements.videoInput.value = "";
  });
  elements.dropZone.addEventListener("dragover", (event) => {
    if (elements.videoInput.disabled) return;
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
  elements.dropZone.addEventListener("dragleave", () => {
    elements.dropZone.classList.remove("dragging");
  });
  elements.dropZone.addEventListener("drop", async (event) => {
    elements.dropZone.classList.remove("dragging");
    if (elements.videoInput.disabled) return;
    event.preventDefault();
    await addVideoFiles(event.dataTransfer.files);
  });
  elements.clearAllVideosButton.addEventListener("click", clearAllVideos);

  elements.postContent.addEventListener("input", syncSettingsFromInputs);
  elements.aiEnabled.addEventListener("change", () => {
    syncSettingsFromInputs();
    updateContentUi();
  });
  elements.openAiSettingsButton.addEventListener("click", () => setActivePanel("ai"));
  elements.aiApiKey.addEventListener("input", () => {
    openAiApiKey = elements.aiApiKey.value.trim();
    clearTimeout(aiKeySaveTimer);
    aiKeySaveTimer = setTimeout(() => {
      setLocal({ [STORAGE_KEYS.OPENAI_API_KEY]: openAiApiKey }).catch(() => {
        setAiStatus("Không lưu được API key. Hãy bấm Lưu thiết lập.", "validation-message");
      });
    }, 250);
    setAiStatus("");
  });
  elements.aiModel.addEventListener("change", syncSettingsFromInputs);
  elements.aiPrompt.addEventListener("input", syncSettingsFromInputs);
  elements.toggleAiKeyButton.addEventListener("click", () => {
    const showing = elements.aiApiKey.type === "text";
    elements.aiApiKey.type = showing ? "password" : "text";
    elements.toggleAiKeyButton.textContent = showing ? "Hiện" : "Ẩn";
    elements.toggleAiKeyButton.setAttribute("aria-label", showing ? "Hiện API key" : "Ẩn API key");
    elements.toggleAiKeyButton.setAttribute("aria-pressed", String(!showing));
  });
  elements.saveAiSettingsButton.addEventListener("click", saveAiSettings);
  elements.resetAiPromptButton.addEventListener("click", () => {
    elements.aiPrompt.value = DEFAULT_AI_PROMPT;
    syncSettingsFromInputs();
    setAiStatus("Đã khôi phục prompt mặc định.", "status-success");
  });
  elements.testAiButton.addEventListener("click", () => testAiContent(false));
  elements.testAiCommentButton.addEventListener("click", () => testAiContent(true));
  elements.aiCommentPrompt.addEventListener("input", syncSettingsFromInputs);
  elements.resetAiCommentPromptButton.addEventListener("click", () => {
    elements.aiCommentPrompt.value = DEFAULT_AI_COMMENT_PROMPT;
    syncSettingsFromInputs();
    setAiStatus("Đã khôi phục prompt bình luận.", "status-success");
  });
  elements.cancelAiTestButton.addEventListener("click", () => aiTestController?.abort());
  elements.useVideoTitleAsContent.addEventListener("change", () => {
    syncSettingsFromInputs();
    updateContentUi();
  });
  elements.videosPerPage.addEventListener("change", () => {
    syncSettingsFromInputs();
    syncVideosPerPageControl();
    updateStartLabel();
  });
  elements.randomizeVideos.addEventListener("change", syncSettingsFromInputs);
  elements.uploadConcurrency.addEventListener("change", () => {
    syncSettingsFromInputs();
    updateStartLabel();
  });
  elements.jobDelay.addEventListener("input", syncSettingsFromInputs);
  elements.commentEnabled.addEventListener("change", () => {
    syncSettingsFromInputs();
    updateCommentUi();
  });
  elements.commentText.addEventListener("input", syncSettingsFromInputs);
  elements.commentAiEnabled.addEventListener("change", syncSettingsFromInputs);

  elements.startButton.addEventListener("click", startRun);
  elements.newBatchButton.addEventListener("click", prepareNextBatch);
  elements.pauseButton.addEventListener("click", () => {
    runner.requestPause().catch((error) => toast(error.message, "error"));
  });
  elements.resumeButton.addEventListener("click", () => resumeRun(false));
  elements.stopButton.addEventListener("click", () => {
    runner.stop().catch((error) => toast(error.message, "error"));
  });
  elements.retryButton.addEventListener("click", () => resumeRun(true));
  elements.exportCsvButton.addEventListener("click", exportCsv);
  elements.clearResultsButton.addEventListener("click", clearResults);
  elements.clearLogButton.addEventListener("click", () => activityLogView.clearDisplayedLogs());

  window.addEventListener("beforeunload", () => tokenWorkflow.cancel());
  window.addEventListener("beforeunload", () => aiTestController?.abort());
  window.addEventListener("beforeunload", () => photoPreviewView?.clear());

}

function normalizeQueue(items, mediaType) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.id === "string" && item.id)
    .map((item) => ({
      id: item.id, mediaType,
      name: String(item.name || (mediaType === "photo" ? "anh.jpg" : "video.mp4")),
      size: Math.max(0, Number(item.size) || 0),
      type: String(item.type || ""),
      lastModified: Number(item.lastModified) || 0,
      title: String(item.title || titleFromFileName(item.name)),
      caption: String(item.caption || ""),
      createdAt: String(item.createdAt || new Date().toISOString())
    }));
}

async function loadStoredState() {
  const stored = await getLocal([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.QUEUE,
    STORAGE_KEYS.PHOTO_QUEUE,
    STORAGE_KEYS.CONTENT_TEMPLATES,
    STORAGE_KEYS.OPENAI_API_KEY
  ]);
  const storedSettings = stored[STORAGE_KEYS.SETTINGS] || {};
  const settingsNeedMigration = LEGACY_SCHEDULE_SETTING_KEYS.some((key) => (
    Object.prototype.hasOwnProperty.call(storedSettings, key)
  ));
  settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings
  };
  for (const key of LEGACY_SCHEDULE_SETTING_KEYS) delete settings[key];
  settings.contentMode = normalizePostingMode(settings.contentMode);
  settings.tokenMode = "user";
  settings.accessToken = String(settings.accessToken || "");
  settings.directPageId = String(settings.directPageId || "");
  settings.uploadConcurrency = normalizeUploadConcurrency(settings.uploadConcurrency);
  settings.jobDelay = Math.min(3600, Math.max(0, Number(settings.jobDelay) || 0));
  settings.postContent = String(settings.postContent || "");
  settings.useVideoTitleAsContent = Boolean(settings.useVideoTitleAsContent);
  settings.aiEnabled = Boolean(settings.aiEnabled);
  settings.aiModel = AI_MODELS.some((model) => model.id === settings.aiModel) ? settings.aiModel : DEFAULT_AI_MODEL;
  settings.aiPrompt = typeof settings.aiPrompt === "string" ? settings.aiPrompt : DEFAULT_AI_PROMPT;
  settings.aiCommentPrompt = typeof settings.aiCommentPrompt === "string" ? settings.aiCommentPrompt : DEFAULT_AI_COMMENT_PROMPT;
  settings.commentAiEnabled = Boolean(settings.commentAiEnabled);
  openAiApiKey = String(stored[STORAGE_KEYS.OPENAI_API_KEY] || "");
  settings.videosPerPage = Math.max(
    0,
    Math.floor(Number(settings.videosPerPage) || 0)
  );
  settings.randomizeVideos = Boolean(settings.randomizeVideos);
  settings.commentEnabled = Boolean(settings.commentEnabled);
  settings.commentText = String(settings.commentText || "");
  settings.selectedPageIds = Array.isArray(settings.selectedPageIds)
    ? settings.selectedPageIds.map(String)
    : [];
  if (isPhotoMode(settings)) settings = photoSettings(settings);
  modeQueues.reels = normalizeQueue(stored[STORAGE_KEYS.QUEUE], "video");
  modeQueues.photos = normalizeQueue(stored[STORAGE_KEYS.PHOTO_QUEUE], "photo");
  queue = modeQueues[settings.contentMode];
  const storedTemplates = Array.isArray(stored[STORAGE_KEYS.CONTENT_TEMPLATES])
    ? stored[STORAGE_KEYS.CONTENT_TEMPLATES]
    : [];
  const templatesNeedMigration = storedTemplates.some((template) => (
    LEGACY_SCHEDULE_SETTING_KEYS.some((key) => (
      Object.prototype.hasOwnProperty.call(template?.settings || {}, key)
    ))
  ));
  contentTemplates = normalizeContentTemplates(storedTemplates);

  const storedVideoIds = new Set(await listVideoIds());
  const repairedTemplates = contentTemplates.map((template) => ({
    ...template,
    videos: template.videos.filter((item) => storedVideoIds.has(item.id))
  }));
  const repairs = {};
  if (settingsNeedMigration) repairs[STORAGE_KEYS.SETTINGS] = settings;
  for (const mode of ["reels", "photos"]) {
    const available = modeQueues[mode].filter((item) => storedVideoIds.has(item.id));
    if (available.length !== modeQueues[mode].length) {
      modeQueues[mode] = available;
      repairs[queueStorageKey({ contentMode: mode })] = available;
    }
  }
  queue = modeQueues[settings.contentMode];
  if (templatesNeedMigration || repairedTemplates.some((template, index) => (
    template.videos.length !== contentTemplates[index].videos.length
  ))) {
    contentTemplates = repairedTemplates;
    repairs[STORAGE_KEYS.CONTENT_TEMPLATES] = contentTemplates;
  }
  if (Object.keys(repairs).length) await setLocal(repairs);
  try {
    await pruneVideos(retainedVideoIds(queue, contentTemplates, null));
  } catch {
    // Không chặn khởi động chỉ vì bước dọn dữ liệu thừa thất bại.
  }
}

async function init() {
  bindElements();
  for (const model of AI_MODELS) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    elements.aiModel.appendChild(option);
  }
  starting = true;
  updateControls(null);
  tokenWorkflowView.render({ phase: "idle" });
  setActivePanel("auth");
  try {
    // A newly opened/reloaded dashboard starts a fresh posting session.
    // Clear the previous run before pruning files or enabling posting actions.
    await runner.clear();
  } catch (error) {
    const message = "Không thể mở phiên mới: " + error.message;
    setTokenStatus(message, "validation-message");
    toast(message, "error");
    return;
  }
  try {
    await loadStoredState();
  } catch (error) {
    toast("Không khôi phục được dữ liệu cục bộ: " + error.message, "error");
  }
  applySettingsToInputs();
  renderContentTemplates();
  renderQueue();
  renderPages();

  starting = false;
  setupEvents();
  renderSnapshot(null);

  if (settings.tokenMode === "user" && settings.accessToken) {
    await loadPages({ silent: true });
    if (!pages.length) await autoFetchToken();
  } else if (settings.tokenMode === "user") {
    setTokenStatus("Chưa lấy token tự động", "");
  } else if (settings.accessToken) {
    await loadPages({ silent: true });
  }
}

init();
