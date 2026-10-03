import { MESSAGE, sendRequest } from "../platform/messaging.js";
import {
  DEFAULT_SETTINGS,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MIN_IMAGE_BYTES,
  MIN_VIDEO_BYTES,
  NATIVE_GROUP_LIMIT,
  RUN_STATUS,
  STORAGE_KEYS
} from "../shared/constants.js";
import { getLocal, setLocal } from "../platform/storage.js";
import { splitCrosspostGroupBatches } from "../features/facebook/crosspost.js";
import {
  formatFacebookGroupUidList,
  mergeFetchedGroupsWithUidList,
  resolveFacebookGroupsFromUidList
} from "../features/facebook/group-parser.js";
import { exactFacebookPostUrl } from "../features/facebook/post-links.js";
import {
  FacebookApi,
  extractLinks,
  readFacebookSession
} from "../features/facebook/facebook-api.js";
import { classifyCrosspostFailure } from "../features/facebook/facebook-errors.js";
import {
  CampaignRunner,
  calculateDelaySeconds,
  estimateCampaignSeconds,
  formatDuration,
  formatResultSummary
} from "../features/campaign/campaign-runner.js";
import {
  PostedResultsPanel,
  postedResultsFromCampaign,
  postedResultsFromCrosspost,
  resolvePostedGroupUrl
} from "../features/campaign/post-results.js";
import { STORE, dbDelete, dbGet, dbList, dbPut } from "../platform/database.js";
import { cloneData, createId } from "../shared/utils.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let profile = null;
let api = null;
let runner = null;
let postedResultsPanel = null;
let groups = [];
let selectedGroupIds = new Set();
let postItems = [newPostItem()];
let imageFile = null;
let videoFile = null;
let mediaObjectUrl = null;
let renderGeneration = 0;
let draftTimer = null;
let settingsTimer = null;
let groupLoadPromise = null;
let runtimeRestored = false;
let modalResolver = null;
let nativeGroupState = null;
let nativePollTimer = null;
let nativeExecutionPromise = null;
let nativeExecutionController = null;
let nativeCancelRequested = false;
const logs = [];
const handledNativeJobIds = new Set();

function newPostItem(text = "", preview = null) {
  return { id: createId(), text, preview };
}

function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function toast(title, message = "", level = "info", timeout = 4200) {
  const region = $("#toastRegion");
  const element = document.createElement("div");
  element.className = `toast toast--${level}`;
  const strong = document.createElement("strong");
  strong.textContent = title;
  element.appendChild(strong);
  if (message) {
    const span = document.createElement("span");
    span.textContent = message;
    element.appendChild(span);
  }
  region.appendChild(element);
  window.setTimeout(() => element.remove(), timeout);
}

function addLog(entry) {
  logs.push(entry);
  if (logs.length > 1000) logs.shift();
  const list = $("#logList");
  $(".empty-message", list)?.remove();
  const row = document.createElement("div");
  row.className = `log-item log-item--${entry.level || "info"}`;
  const time = document.createElement("time");
  time.textContent = timeLabel(entry.time || Date.now());
  const dot = document.createElement("span");
  dot.className = "log-dot";
  const message = document.createElement("p");
  message.textContent = entry.message;
  row.append(time, dot, message);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function clearLogs() {
  logs.length = 0;
  $("#logList").innerHTML = '<p class="empty-message">Sự kiện sẽ hiển thị tại đây.</p>';
}

function isNativeGroupActive(state = nativeGroupState) {
  return Boolean(state && ["queued", "running"].includes(state.status));
}

function nativeStageText(state) {
  const labels = {
    queued: "Đang xếp tiến trình",
    starting: "Đang chuẩn bị",
    starting_graphql: "Đang chuẩn bị GraphQL",
    uploading_image: "Đang tải ảnh",
    uploading_video: "Đang tải video",
    posting_graphql: "Đang gửi GraphQL",
    retrying_graphql: "Đang thử lại GraphQL",
    verifying_approval: "Đang kiểm tra trạng thái bài",
    verifying_groups: "Đang kiểm tra UID nhóm",
    batch_completed: "Đã xử lý lô",
    waiting_batch: "Đang chờ lô tiếp theo",
    waiting_graphql: "Đang chờ Facebook",
    submitting: "Đang nhấn Đăng",
    cancelling: "Đang dừng"
  };
  return labels[state?.stage] || state?.stage || "Đang xử lý";
}

function nativeResultCounts(state) {
  const groupIds = new Set((state?.groups || []).map((group) => String(group?.id || "")).filter(Boolean));
  const selectedIds = new Set(
    (state?.selectedGroupIds || []).map(String).filter((id) => groupIds.has(id))
  );
  const rawPendingIds = Array.isArray(state?.pendingGroupIds)
    ? state.pendingGroupIds.map(String)
    : state?.pendingApproval
      ? [...selectedIds]
      : [];
  const pendingIds = new Set(rawPendingIds.filter((id) => selectedIds.has(id)));
  const missingIds = new Set(
    (state?.missingGroups || []).map((item) => String(item?.id || "")).filter((id) => groupIds.has(id))
  );
  const total = groupIds.size;
  const successCount = Math.max(0, selectedIds.size - pendingIds.size);
  const failCount = state?.status === "failed"
    ? Math.max(missingIds.size, total - selectedIds.size)
    : missingIds.size;
  const processedCount = state?.status === "failed"
    ? total
    : Math.min(total, selectedIds.size + missingIds.size);
  return {
    total,
    selectedIds,
    pendingIds,
    successCount,
    pendingCount: pendingIds.size,
    failCount,
    processedCount
  };
}

function announceNativeTerminalState(state) {
  if (!state?.id || handledNativeJobIds.has(state.id)) return;
  if (!Array.isArray(state.groups) || !["succeeded", "failed", "cancelled"].includes(state.status)) return;
  handledNativeJobIds.add(state.id);
  if (state.status === "cancelled") {
    addLog({ level: "warning", message: state.errorMessage || "Đã dừng Đăng Chéo.", time: Date.now() });
    toast("Đã dừng", state.errorMessage || "Tiến trình Đăng Chéo đã dừng.", "warning");
    return;
  }

  const counts = nativeResultCounts(state);
  const summary = formatResultSummary(counts);
  if (state.status === "succeeded") {
    const batchCount = Math.ceil(state.groups.length / NATIVE_GROUP_LIMIT);
    addLog({
      level: counts.pendingCount > 0 ? "warning" : "success",
      message: `Hoàn tất ${batchCount} lô đăng chéo: ${summary}.`,
      time: Date.now()
    });
    toast(
      "Đăng bài đã hoàn tất",
      summary,
      counts.pendingCount > 0 ? "warning" : "success",
      7000
    );
  } else {
    const missingNames = (state.missingGroups || []).map((item) => item.name).filter(Boolean);
    addLog({
      level: counts.successCount + counts.pendingCount > 0 ? "warning" : "error",
      message: missingNames.length
        ? `${summary}. Nhóm lỗi: ${missingNames.join(", ")}.`
        : summary,
      time: Date.now()
    });
    toast(
      "Tiến trình đã kết thúc",
      summary,
      counts.successCount + counts.pendingCount > 0 ? "warning" : "error",
      8000
    );
  }
}

function renderNativeGroupState(state) {
  nativeGroupState = state || null;
  if (!state) {
    updateActionAvailability();
    return;
  }
  postedResultsPanel?.render(postedResultsFromCrosspost(state));
  const counts = nativeResultCounts(state);
  const { total, successCount, pendingCount, failCount, processedCount } = counts;
  const active = isNativeGroupActive(state);

  if (active) {
    const batched = total > NATIVE_GROUP_LIMIT;
    const stageFloor = (batched ? {
      starting_graphql: 5,
      uploading_image: 6,
      uploading_video: 6,
      posting_graphql: 8,
      retrying_graphql: 8,
      verifying_approval: 90,
      verifying_groups: 8,
      batch_completed: 8,
      waiting_batch: 8,
      waiting_graphql: 8,
      submitting: 8
    } : {
      starting_graphql: 8,
      uploading_image: 28,
      uploading_video: 35,
      posting_graphql: 82,
      retrying_graphql: 82,
      verifying_approval: 90,
      verifying_groups: 82,
      batch_completed: 82,
      waiting_batch: 82,
      waiting_graphql: 94,
      submitting: 94
    })[state.stage] || 8;
    const percent = Math.min(96, Math.max(stageFloor, total ? Math.round((processedCount / total) * 90) + 5 : stageFloor));
    $("#progressBar").style.width = `${percent}%`;
    $("#progressPercent").textContent = `${percent}%`;
    $("#processedCount").textContent = processedCount.toLocaleString("vi-VN");
    $("#successCount").textContent = successCount.toLocaleString("vi-VN");
    $("#pendingCount").textContent = pendingCount.toLocaleString("vi-VN");
    $("#failCount").textContent = failCount.toLocaleString("vi-VN");
    $("#progressText").textContent = `Đã xử lý ${processedCount.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")} nhóm`;
    $("#countdownText").textContent = state.progressMessage || nativeStageText(state);
    const status = $("#runnerStatus");
    status.className = "status-pill status-pill--running";
    status.textContent = nativeStageText(state);
  } else if (state.status === "succeeded") {
    const batchCount = Math.ceil(total / NATIVE_GROUP_LIMIT);
    $("#progressBar").style.width = "100%";
    $("#progressPercent").textContent = "100%";
    $("#processedCount").textContent = total.toLocaleString("vi-VN");
    $("#successCount").textContent = successCount.toLocaleString("vi-VN");
    $("#pendingCount").textContent = pendingCount.toLocaleString("vi-VN");
    $("#failCount").textContent = failCount.toLocaleString("vi-VN");
    $("#progressText").textContent = `${total.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")} nhóm`;
    $("#countdownText").textContent = batchCount === 1
      ? "Đã đăng 1 bài và thêm đủ UID nhóm đã chọn."
      : `Đã đăng ${batchCount} bài theo ${batchCount} lô và xử lý đủ nhóm đã chọn.`;
    const status = $("#runnerStatus");
    status.className = "status-pill status-pill--completed";
    status.textContent = "Đã hoàn tất";
  } else if (["failed", "cancelled"].includes(state.status)) {
    const terminalProcessed = processedCount;
    const terminalPercent = total ? Math.round((terminalProcessed / total) * 100) : 0;
    $("#progressBar").style.width = `${terminalPercent}%`;
    $("#progressPercent").textContent = `${terminalPercent}%`;
    $("#processedCount").textContent = terminalProcessed.toLocaleString("vi-VN");
    $("#successCount").textContent = successCount.toLocaleString("vi-VN");
    $("#pendingCount").textContent = pendingCount.toLocaleString("vi-VN");
    $("#failCount").textContent = failCount.toLocaleString("vi-VN");
    $("#progressText").textContent = state.status === "cancelled"
      ? "Đã dừng thao tác"
      : successCount + pendingCount > 0
        ? formatResultSummary({ successCount, pendingCount, failCount })
        : "Thao tác không hoàn tất";
    $("#countdownText").textContent = state.errorMessage || "—";
    const status = $("#runnerStatus");
    status.className = "status-pill status-pill--stopped";
    status.textContent = state.status === "cancelled" ? "Đã dừng" : successCount + pendingCount > 0 ? "Hoàn tất một phần" : "Thất bại";
  }
  announceNativeTerminalState(state);
  updateActionAvailability();
}

function stopNativePolling() {
  if (nativePollTimer !== null) window.clearTimeout(nativePollTimer);
  nativePollTimer = null;
}

async function pollNativeGroupStatus({ quiet = false } = {}) {
  stopNativePolling();
  try {
    const state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_STATUS);
    renderNativeGroupState(state);
    if (isNativeGroupActive(state)) {
      nativePollTimer = window.setTimeout(() => void pollNativeGroupStatus({ quiet: true }), 750);
    }
  } catch (error) {
    if (!quiet) addLog({ level: "warning", message: `Không đọc được trạng thái Đăng Chéo: ${error.message}`, time: Date.now() });
    if (isNativeGroupActive()) {
      nativePollTimer = window.setTimeout(() => void pollNativeGroupStatus({ quiet: true }), 1500);
    }
  }
}

async function restoreNativeGroupStatus() {
  try {
    let state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_STATUS);
    if (isNativeGroupActive(state) && state.executionMode === "graphql" && !nativeExecutionPromise) {
      const completedIds = new Set([
        ...(state.selectedGroupIds || []).map(String),
        ...(state.missingGroups || []).map((item) => String(item?.id || ""))
      ]);
      const interruptedGroups = (state.groups || [])
        .filter((group) => !completedIds.has(String(group.id)))
        .map((group) => ({
          id: String(group.id),
          name: String(group.name),
          reason: "Bảng điều khiển đã tải lại trước khi xử lý nhóm này."
        }));
      state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_PROGRESS, {
        state: {
          jobId: state.id,
          status: "failed",
          stage: "failed",
          message: "Bảng điều khiển đã tải lại khi GraphQL đang chạy.",
          selectedGroupIds: state.selectedGroupIds || [],
          missingGroups: [...(state.missingGroups || []), ...interruptedGroups],
          errorCode: "CROSSPOST_DASHBOARD_RELOADED",
          errorMessage: "Tiến trình bị gián đoạn. Hãy kiểm tra danh sách Nhóm đã đăng trước khi quyết định chạy lại; tiện ích không tự chạy lại để tránh trùng bài."
        }
      });
    }
    renderNativeGroupState(state);
  } catch (error) {
    addLog({ level: "warning", message: `Không khôi phục được trạng thái Đăng Chéo: ${error.message}`, time: Date.now() });
  }
}

async function sendNativeGraphqlProgress(jobId, patch) {
  const state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_PROGRESS, {
    state: {
      jobId,
      ...patch
    }
  });
  renderNativeGroupState(state);
  return state;
}

function nativeExecutionError(message = "Đã dừng Đăng Chéo.") {
  const error = new Error(message);
  error.code = "FACEBOOK_REQUEST_ABORTED";
  return error;
}

function assertNativeExecutionActive(signal) {
  if (nativeCancelRequested || signal?.aborted) throw nativeExecutionError();
}

function waitForNativeBatchDelay(milliseconds, signal) {
  const duration = Math.max(0, Number(milliseconds) || 0);
  if (duration === 0) {
    assertNativeExecutionActive(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(nativeExecutionError());
    };
    if (nativeCancelRequested || signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = window.setTimeout(finish, duration);
  });
}

async function executeNativeGraphqlPost(initialState, chosenGroups, message) {
  if (nativeExecutionPromise) return nativeExecutionPromise;
  const jobId = String(initialState?.id || "");
  if (!jobId) throw new Error("Thiếu mã tiến trình GraphQL.");
  const groupSnapshot = chosenGroups.map((group) => ({ id: String(group.id), name: String(group.name) }));
  const batches = splitCrosspostGroupBatches(groupSnapshot);
  const imageSnapshot = imageFile;
  const videoSnapshot = videoFile;
  const previewSnapshot = postItems[0]?.preview ? cloneData(postItems[0].preview) : null;
  const delaySnapshot = cloneData(currentDelay());
  const executionController = new AbortController();
  nativeExecutionController = executionController;
  nativeCancelRequested = false;

  const operation = (async () => {
    const successfulIds = [];
    const pendingGroupIds = new Set();
    const missingGroups = [];
    const resultUrls = {};
    const commentPermissions = {};
    let firstResultUrl = null;
    const currentResultCounts = () => ({
      successCount: Math.max(0, successfulIds.length - pendingGroupIds.size),
      pendingCount: pendingGroupIds.size,
      failCount: missingGroups.length
    });
    try {
      await sendNativeGraphqlProgress(jobId, {
        status: "running",
        stage: "starting_graphql",
        message: batches.length === 1
          ? "Đang chuẩn bị một mutation GraphQL gồm UID nhóm gốc và tối đa 9 UID nhóm phụ."
          : `Đã chia ${groupSnapshot.length} nhóm thành ${batches.length} lô, tối đa ${NATIVE_GROUP_LIMIT} UID mỗi mutation.`,
        selectedGroupIds: [],
        pendingGroupIds: [],
        missingGroups: [],
        commentPermissions: {}
      });

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        assertNativeExecutionActive(executionController.signal);
        const batch = batches[batchIndex];
        const batchNumber = batchIndex + 1;
        try {
          const result = await api.publishMultiGroup(batch, message, {
            imageFile: imageSnapshot,
            videoFile: videoSnapshot,
            preview: previewSnapshot,
            signal: executionController.signal,
            verifyApproval: true,
            onStage: ({ stage, message: stageMessage }) => sendNativeGraphqlProgress(jobId, {
              status: "running",
              stage,
              message: `Lô ${batchNumber}/${batches.length}: ${stageMessage}`,
              selectedGroupIds: [...successfulIds],
              pendingGroupIds: [...pendingGroupIds],
              missingGroups: [...missingGroups],
              commentPermissions: { ...commentPermissions }
            })
          });
          assertNativeExecutionActive(executionController.signal);
          const confirmedIds = new Set(
            Array.isArray(result.groupIds)
              ? result.groupIds.map(String)
              : batch.map((group) => group.id)
          );
          const rejectedIds = new Set(
            Array.isArray(result.rejectedGroupIds) ? result.rejectedGroupIds.map(String) : []
          );
          const successfulBatchGroups = batch.filter((group) => confirmedIds.has(group.id) && !rejectedIds.has(group.id));
          const rejectedBatchGroups = batch.filter((group) => !confirmedIds.has(group.id) || rejectedIds.has(group.id));
          successfulIds.push(...successfulBatchGroups.map((group) => group.id));
          missingGroups.push(...rejectedBatchGroups.map((group) => ({
            id: group.id,
            name: group.name,
            reason: `Lô ${batchNumber}/${batches.length}: ${result.rejectedGroupReasons?.[group.id] || "Nhóm chưa tham gia hoặc tư cách hiện tại không có quyền đăng chéo."}`
          })));
          const batchResultUrl = resolvePostedGroupUrl(result.baseGroupId || batch[0].id, result);
          if (batchResultUrl) {
            firstResultUrl ||= batchResultUrl;
          }
          for (const group of successfulBatchGroups) {
            const groupResultUrl = resolvePostedGroupUrl(group.id, {
              ...result,
              resultUrl: batchResultUrl
            });
            if (groupResultUrl) resultUrls[group.id] = groupResultUrl;
            const groupApproval = result.groupApprovals?.[group.id] || {};
            const canComment = groupApproval.canComment;
            if (typeof canComment === "boolean") commentPermissions[group.id] = canComment;
          }
          const verifiedPendingIds = new Set((Array.isArray(result.pendingGroupIds)
            ? result.pendingGroupIds
            : result.pendingApproval ? successfulBatchGroups.map((group) => group.id) : []).map(String));
          for (const group of successfulBatchGroups) {
            const isPending = verifiedPendingIds.has(group.id) || commentPermissions[group.id] === false;
            if (isPending) {
              pendingGroupIds.add(group.id);
            }
          }
          const batchPendingCount = successfulBatchGroups.filter((group) => pendingGroupIds.has(group.id)).length;
          const batchSummary = formatResultSummary({
            successCount: successfulBatchGroups.length - batchPendingCount,
            pendingCount: batchPendingCount,
            failCount: rejectedBatchGroups.length
          });
          addLog({
            level: rejectedBatchGroups.length > 0 || batchPendingCount > 0 ? "warning" : "success",
            message: `Lô ${batchNumber}/${batches.length}: ${batchSummary}.`,
            time: Date.now()
          });
        } catch (error) {
          const cancelled = nativeCancelRequested
            || executionController.signal.aborted
            || error?.code === "FACEBOOK_REQUEST_ABORTED"
            || error?.code === "VIDEO_ABORTED";
          if (cancelled) throw error;
          const classification = classifyCrosspostFailure(error);
          const reason = classification.logMessage;
          missingGroups.push(...batch.map((group) => ({
            id: group.id,
            name: group.name,
            reason: `Lô ${batchNumber}/${batches.length}: ${reason}`
          })));
          addLog({
            level: "error",
            message: `Lô ${batchNumber}/${batches.length} thất bại (${batch.length} nhóm): ${reason}`,
            time: Date.now()
          });
          if (classification.shouldStop) {
            const terminalError = new Error(reason);
            terminalError.code = error?.code || classification.type;
            terminalError.data = error?.data || null;
            addLog({
              level: "warning",
              message: "Đã dừng các lô còn lại để tránh đăng trùng hoặc bảo vệ tài khoản Facebook.",
              time: Date.now()
            });
            throw terminalError;
          }
        }

        await sendNativeGraphqlProgress(jobId, {
          status: "running",
          stage: "batch_completed",
          message: `Đã xử lý lô ${batchNumber}/${batches.length}: ${formatResultSummary(currentResultCounts())}.`,
          selectedGroupIds: [...successfulIds],
          pendingGroupIds: [...pendingGroupIds],
          missingGroups: [...missingGroups],
          resultUrl: firstResultUrl,
          resultUrls: { ...resultUrls },
          commentPermissions: { ...commentPermissions },
          pendingApproval: pendingGroupIds.size > 0
        });

        if (batchNumber < batches.length) {
          const delaySeconds = calculateDelaySeconds(delaySnapshot);
          await sendNativeGraphqlProgress(jobId, {
            status: "running",
            stage: "waiting_batch",
            message: delaySeconds > 0
              ? `Chờ ${formatDuration(delaySeconds)} trước lô ${batchNumber + 1}/${batches.length}.`
              : `Đang chuyển sang lô ${batchNumber + 1}/${batches.length}.`,
            selectedGroupIds: [...successfulIds],
            pendingGroupIds: [...pendingGroupIds],
            missingGroups: [...missingGroups],
            resultUrl: firstResultUrl,
            resultUrls: { ...resultUrls },
            commentPermissions: { ...commentPermissions },
            pendingApproval: pendingGroupIds.size > 0
          });
          await waitForNativeBatchDelay(delaySeconds * 1000, executionController.signal);
        }
      }

      assertNativeExecutionActive(executionController.signal);
      if (missingGroups.length > 0) {
        await sendNativeGraphqlProgress(jobId, {
          status: "failed",
          stage: "completed_partial",
          message: `Đã xử lý ${batches.length} lô đăng chéo: ${formatResultSummary(currentResultCounts())}.`,
          selectedGroupIds: [...successfulIds],
          pendingGroupIds: [...pendingGroupIds],
          missingGroups: [...missingGroups],
          errorCode: successfulIds.length > 0 ? "CROSSPOST_BATCH_PARTIAL" : "CROSSPOST_BATCH_FAILED",
          errorMessage: formatResultSummary(currentResultCounts()),
          resultUrl: firstResultUrl,
          resultUrls: { ...resultUrls },
          commentPermissions: { ...commentPermissions },
          pendingApproval: pendingGroupIds.size > 0
        });
        return;
      }

      await sendNativeGraphqlProgress(jobId, {
        status: "succeeded",
        stage: "completed",
        message: batches.length === 1
          ? `Đã đăng một bài và thêm trực tiếp ${Math.max(0, groupSnapshot.length - 1)} UID nhóm phụ.`
          : `Đã đăng ${batches.length} bài theo ${batches.length} lô vào đủ ${groupSnapshot.length} nhóm.`,
        selectedGroupIds: [...successfulIds],
        pendingGroupIds: [...pendingGroupIds],
        missingGroups: [],
        errorCode: null,
        errorMessage: null,
        resultUrl: firstResultUrl,
        resultUrls: { ...resultUrls },
        commentPermissions: { ...commentPermissions },
        pendingApproval: pendingGroupIds.size > 0
      });
    } catch (error) {
      const cancelled = nativeCancelRequested
        || executionController.signal.aborted
        || error?.code === "FACEBOOK_REQUEST_ABORTED"
        || error?.code === "VIDEO_ABORTED";
      if (cancelled) {
        try {
          const state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_CANCEL);
          renderNativeGroupState(state);
        } catch {
          // Trạng thái hủy có thể đã được background ghi trước đó.
        }
        return;
      }
      const processedIds = new Set([
        ...successfulIds,
        ...missingGroups.map((group) => group.id)
      ]);
      const interruptedGroups = groupSnapshot
        .filter((group) => !processedIds.has(group.id))
        .map((group) => ({
          id: group.id,
          name: group.name,
          reason: error?.message || "Tiến trình dừng trước khi xử lý nhóm này."
        }));
      try {
        await sendNativeGraphqlProgress(jobId, {
          status: "failed",
          stage: "failed",
          message: "GraphQL không hoàn tất thao tác Đăng Chéo.",
          selectedGroupIds: [...successfulIds],
          pendingGroupIds: [...pendingGroupIds],
          missingGroups: [
            ...missingGroups,
            ...(Array.isArray(error?.data?.missingGroups) ? error.data.missingGroups : []),
            ...interruptedGroups
          ],
          errorCode: error?.code || "CROSSPOST_PUBLISH_FAILED",
          errorMessage: error?.message || "Facebook không xác nhận đăng bài.",
          resultUrl: firstResultUrl || exactFacebookPostUrl(error?.data?.url),
          resultUrls: { ...resultUrls },
          commentPermissions: { ...commentPermissions },
          pendingApproval: pendingGroupIds.size > 0
        });
      } catch (stateError) {
        addLog({ level: "error", message: `Không lưu được lỗi GraphQL: ${stateError.message}`, time: Date.now() });
      }
    }
  })();

  nativeExecutionPromise = operation;
  try {
    await operation;
  } finally {
    if (nativeExecutionPromise === operation) nativeExecutionPromise = null;
    if (nativeExecutionController === executionController) nativeExecutionController = null;
    nativeCancelRequested = false;
  }
}

async function beginNativeMultiGroupPost() {
  const runnerActive = [RUN_STATUS.RUNNING, RUN_STATUS.WAITING, RUN_STATUS.PAUSED].includes(runner?.state?.status);
  if (runnerActive || isNativeGroupActive()) {
    toast("Đang có tiến trình", "Hãy dừng hoặc chờ tiến trình hiện tại hoàn tất.", "warning");
    return;
  }
  if (!profile) return toast("Chưa có phiên Facebook", "Hãy đăng nhập Facebook và làm mới phiên.", "error");
  let chosen;
  try {
    chosen = selectedGroups();
  } catch (error) {
    toast("Danh sách UID không hợp lệ", error.message, "error", 7500);
    return;
  }
  if (chosen.length === 0) return toast("Chưa chọn nhóm", "Chọn ít nhất một nhóm.", "warning");
  const batchCount = Math.ceil(chosen.length / NATIVE_GROUP_LIMIT);
  const message = String(postItems[0]?.text || "").trim();
  if (!message) return toast("Chưa có nội dung", "Nhập nội dung bài đăng trước khi bắt đầu.", "warning");
  addLog({
    level: "info",
    message: `Bắt đầu Đăng Chéo bằng ${profile.type === "page" ? "Trang" : "tài khoản cá nhân"} với ${chosen.length} UID nhóm (${batchCount} lô; mỗi lô tối đa 1 + 9 UID).`,
    time: Date.now()
  });
  try {
    const state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_START, {
      profileType: profile.type,
      groups: chosen.map((group) => ({ id: group.id, name: group.name })),
      message,
      hasImage: Boolean(imageFile),
      hasVideo: Boolean(videoFile)
    });
    postedResultsPanel?.render([]);
    renderNativeGroupState(state);
    await executeNativeGraphqlPost(state, chosen, message);
    await pollNativeGroupStatus({ quiet: true });
  } catch (error) {
    toast("Không khởi động được Đăng Chéo", error.message, "error", 8000);
    addLog({ level: "error", message: `Không khởi động được Đăng Chéo: ${error.message}`, time: Date.now() });
    await pollNativeGroupStatus({ quiet: true });
  }
}

async function cancelNativeMultiGroupPost() {
  if (!isNativeGroupActive()) return;
  nativeCancelRequested = true;
  nativeExecutionController?.abort();
  stopNativePolling();
  try {
    await api?.abortMultiGroup();
    const state = await sendRequest(MESSAGE.NATIVE_GROUP_POST_CANCEL);
    renderNativeGroupState(state);
  } catch (error) {
    toast("Không dừng được Đăng Chéo", error.message, "error");
  } finally {
    stopNativePolling();
  }
}

function openModal({ title, body, actions }) {
  if (modalResolver) closeModal(null);
  $("#modalTitle").textContent = title;
  const bodyElement = $("#modalBody");
  bodyElement.replaceChildren();
  if (typeof body === "string") {
    const paragraph = document.createElement("p");
    paragraph.textContent = body;
    bodyElement.appendChild(paragraph);
  } else if (body instanceof Node) {
    bodyElement.appendChild(body);
  }
  const actionElement = $("#modalActions");
  actionElement.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.className || "btn btn--ghost";
    button.textContent = action.label;
    button.addEventListener("click", () => closeModal(action.value));
    actionElement.appendChild(button);
  }
  $("#modalBackdrop").hidden = false;
  return new Promise((resolve) => {
    modalResolver = resolve;
  });
}

function closeModal(value = null) {
  $("#modalBackdrop").hidden = true;
  const resolver = modalResolver;
  modalResolver = null;
  resolver?.(value);
}

async function confirmAction(title, message, confirmLabel = "Xác nhận") {
  return (await openModal({
    title,
    body: message,
    actions: [
      { label: "Hủy", value: false, className: "btn btn--ghost" },
      { label: confirmLabel, value: true, className: "btn btn--danger" }
    ]
  })) === true;
}

function scheduleDraftSave() {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(async () => {
    try {
      await dbPut(STORE.ASSETS, "draft", {
        posts: cloneData(postItems.slice(0, 1)),
        updatedAt: Date.now()
      });
    } catch (error) {
      console.warn("Không lưu được bản nháp:", error);
    }
  }, 450);
}

function scheduleSettingsSave() {
  window.clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(async () => {
    try {
      await setLocal(STORAGE_KEYS.SETTINGS, readSettings());
    } catch (error) {
      console.warn("Không lưu được cài đặt:", error);
    }
  }, 350);
}

function createPreviewCard(item) {
  if (!item.preview) return null;
  const display = item.preview.display || {};
  const wrapper = document.createElement("div");
  wrapper.className = "preview-card";
  const image = document.createElement("img");
  image.alt = "";
  if (display.image) image.src = display.image;
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = display.title || item.preview.selectedUrl;
  const domain = document.createElement("span");
  domain.textContent = display.domain || display.url || item.preview.selectedUrl;
  content.append(title, domain);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn btn--danger-ghost btn--small";
  clear.textContent = "Bỏ";
  clear.addEventListener("click", () => {
    item.preview = null;
    renderPosts();
    scheduleDraftSave();
  });
  wrapper.append(image, content, clear);
  return wrapper;
}

function updatePostLinkControls(card, item) {
  const links = extractLinks(item.text);
  const select = $(".post-link-select", card);
  const fetchButton = $(".fetch-preview-btn", card);
  const prior = select.value || item.preview?.selectedUrl || "";
  select.replaceChildren();
  if (links.length === 0) {
    select.appendChild(new Option("Không tìm thấy liên kết", ""));
    select.disabled = true;
    fetchButton.disabled = true;
  } else {
    for (const link of links) select.appendChild(new Option(link, link));
    select.value = links.includes(prior) ? prior : links[0];
    select.disabled = false;
    fetchButton.disabled = !api;
  }
  $(".post-char-count", card).textContent = `${item.text.length.toLocaleString("vi-VN")} ký tự`;
}

function renderPosts() {
  const container = $("#postsContainer");
  container.replaceChildren();
  postItems = postItems.length > 0 ? [postItems[0]] : [newPostItem()];
  postItems.forEach((item) => {
    const card = document.createElement("article");
    card.className = "post-card";
    card.dataset.postId = item.id;
    card.innerHTML = `
      <div class="post-card__head">
        <strong>Nội dung bài đăng</strong>
      </div>
      <textarea class="post-text" placeholder="Nhập nội dung bài đăng…"></textarea>
      <div class="post-card__meta"><span>Nội dung này được dùng cho các nhóm đã chọn.</span><span class="post-char-count"></span></div>
      <div class="link-tools">
        <div class="link-tools__row">
          <select class="post-link-select" aria-label="Chọn liên kết để tạo xem trước"></select>
          <button type="button" class="btn btn--secondary btn--small fetch-preview-btn">Lấy xem trước</button>
        </div>
      </div>`;
    const textarea = $(".post-text", card);
    textarea.value = item.text;
    textarea.addEventListener("input", () => {
      item.text = textarea.value;
      updatePostLinkControls(card, item);
      scheduleDraftSave();
      updateEstimate();
    });
    $(".fetch-preview-btn", card).addEventListener("click", async (event) => {
      const url = $(".post-link-select", card).value;
      if (!url || !api) return;
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "Đang lấy…";
      try {
        item.preview = await api.getLinkPreview(url);
        renderPosts();
        scheduleDraftSave();
        toast("Đã tạo xem trước", url, "success");
      } catch (error) {
        toast("Không tạo được xem trước", error.message, "error");
        updatePostLinkControls(card, item);
        event.currentTarget.textContent = "Lấy xem trước";
      }
    });
    updatePostLinkControls(card, item);
    const preview = createPreviewCard(item);
    if (preview) $(".link-tools", card).appendChild(preview);
    container.appendChild(card);
  });
}

function groupUidResolution() {
  return resolveFacebookGroupsFromUidList($("#groupUidList").value, groups);
}

function groupUidListError(invalidValues) {
  const shown = invalidValues.slice(0, 5).join(", ");
  const suffix = invalidValues.length > 5 ? ` và ${invalidValues.length - 5} mục khác` : "";
  const error = new Error(`Danh sách có UID hoặc liên kết không hợp lệ: ${shown}${suffix}.`);
  error.code = "INVALID_GROUP_UID_LIST";
  return error;
}

function selectedGroups() {
  const resolution = groupUidResolution();
  if (resolution.invalidValues.length > 0) throw groupUidListError(resolution.invalidValues);
  return resolution.groups;
}

function updateGroupUidListStatus(resolution = groupUidResolution()) {
  const status = $("#groupUidListStatus");
  if (resolution.invalidValues.length > 0) {
    status.className = "is-invalid";
    status.textContent = `${resolution.ids.length.toLocaleString("vi-VN")} UID hợp lệ · ${resolution.invalidValues.length} mục lỗi`;
  } else {
    status.className = "";
    status.textContent = `${resolution.ids.length.toLocaleString("vi-VN")} UID`;
  }
  return resolution;
}

function syncGroupSelectionFromUidList() {
  const resolution = updateGroupUidListStatus();
  selectedGroupIds = new Set(resolution.ids);
  for (const row of $$("#groupTableBody tr[data-group-id]")) {
    const checkbox = $("input[type='checkbox']", row);
    checkbox.checked = selectedGroupIds.has(row.dataset.groupId);
  }
  updateSelectedGroupUI();
  return resolution;
}

function syncGroupUidListFromSelection() {
  $("#groupUidList").value = formatFacebookGroupUidList(selectedGroupIds);
  updateGroupUidListStatus();
}

async function commitGroupUidListToTable() {
  const resolution = syncGroupSelectionFromUidList();
  if (resolution.invalidValues.length > 0) return;
  const knownIds = new Set(groups.map((group) => group.id));
  const additions = resolution.groups.filter((group) => !knownIds.has(group.id));
  if (additions.length === 0) return;
  groups = [...additions, ...groups];
  await renderGroups({ showLoader: false });
}

function updateSelectedGroupUI() {
  const count = selectedGroupIds.size;
  const resolution = updateGroupUidListStatus();
  $("#selectedGroupCount").textContent = `Đã chọn: ${count.toLocaleString("vi-VN")}`;
  const visibleCheckboxes = $$("#groupTableBody tr[data-group-id]:not([hidden]) input[type='checkbox']");
  const checked = visibleCheckboxes.filter((checkbox) => checkbox.checked).length;
  const selectAll = $("#selectVisibleGroups");
  selectAll.checked = visibleCheckboxes.length > 0 && checked === visibleCheckboxes.length;
  selectAll.indeterminate = checked > 0 && checked < visibleCheckboxes.length;
  $("#saveGroupListBtn").disabled = count === 0 || resolution.invalidValues.length > 0;
  updateEstimate();
}

function safeGroupUrl(group) {
  try {
    const url = new URL(group.url);
    if (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com")) return url.href;
  } catch {
    // Dùng liên kết dự phòng bên dưới.
  }
  return `https://www.facebook.com/groups/${encodeURIComponent(group.id)}`;
}

async function renderGroups({ showLoader = true } = {}) {
  const generation = ++renderGeneration;
  const body = $("#groupTableBody");
  body.replaceChildren();
  if (showLoader) $("#groupLoading").hidden = false;
  if (groups.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="3">Không có nhóm để hiển thị.</td></tr>';
    $("#groupLoading").hidden = true;
    updateSelectedGroupUI();
    return;
  }
  for (let start = 0; start < groups.length; start += 200) {
    if (generation !== renderGeneration) return;
    const fragment = document.createDocumentFragment();
    const chunk = groups.slice(start, start + 200);
    chunk.forEach((group, offset) => {
      const row = document.createElement("tr");
      row.dataset.groupId = group.id;
      row.dataset.searchText = `${group.name} ${group.id}`.toLocaleLowerCase("vi-VN");
      const checkCell = document.createElement("td");
      checkCell.className = "cell-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedGroupIds.has(group.id);
      checkbox.setAttribute("aria-label", `Chọn ${group.name}`);
      checkCell.appendChild(checkbox);
      const nameCell = document.createElement("td");
      const link = document.createElement("a");
      link.href = safeGroupUrl(group);
      link.target = "_blank";
      link.rel = "noreferrer";
      link.title = group.name;
      link.textContent = group.name;
      nameCell.appendChild(link);
      const numberCell = document.createElement("td");
      numberCell.className = "cell-number";
      numberCell.textContent = String(start + offset + 1);
      row.append(checkCell, nameCell, numberCell);
      fragment.appendChild(row);
    });
    body.appendChild(fragment);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  $("#groupLoading").hidden = true;
  filterGroups();
  updateSelectedGroupUI();
}

function filterGroups() {
  const query = $("#groupSearch").value.trim().toLocaleLowerCase("vi-VN");
  for (const row of $$("#groupTableBody tr[data-group-id]")) {
    row.hidden = Boolean(query) && !row.dataset.searchText.includes(query);
  }
  updateSelectedGroupUI();
}

async function loadFreshGroups() {
  if (groupLoadPromise) return groupLoadPromise;
  if (!api) {
    toast("Chưa có phiên Facebook", "Hãy đăng nhập Facebook và làm mới phiên.", "error");
    return;
  }
  const button = $("#loadGroupsBtn");
  const operation = (async () => {
    button.textContent = "Đang tải nhóm…";
    $("#groupLoading").hidden = false;
    addLog({
      level: "info",
      message: "Đang tải lại danh sách nhóm đã tham gia từ Facebook.",
      time: Date.now()
    });
    try {
      const fetchedGroups = await api.fetchGroups();
      const merged = mergeFetchedGroupsWithUidList(fetchedGroups, groups, $("#groupUidList").value);
      groups = merged.groups;
      selectedGroupIds = merged.selectedGroupIds;
      await renderGroups();
      addLog({
        level: "success",
        message: `Đã tải ${fetchedGroups.length.toLocaleString("vi-VN")} nhóm; danh sách UID trong ô vẫn được giữ và các nhóm tải mới chưa tự chọn.`,
        time: Date.now()
      });
      toast(
        "Đã tải lại danh sách nhóm",
        `${fetchedGroups.length.toLocaleString("vi-VN")} nhóm`,
        "success"
      );
      return groups;
    } catch (error) {
      $("#groupLoading").hidden = true;
      addLog({ level: "error", message: `Tải nhóm thất bại: ${error.message}`, time: Date.now() });
      toast("Không tải được nhóm", error.message, "error", 7000);
      return null;
    }
  })();
  groupLoadPromise = operation;
  updateActionAvailability();
  try {
    return await operation;
  } finally {
    if (groupLoadPromise === operation) groupLoadPromise = null;
    $("#groupLoading").hidden = true;
    button.textContent = "Tải lại nhóm";
    updateActionAvailability();
  }
}

async function refreshSavedSelects() {
  const groupLists = await dbList(STORE.GROUP_LISTS);
  fillSavedSelect($("#groupListSelect"), groupLists, "Danh sách đã lưu…");
}

function fillSavedSelect(select, rows, placeholder) {
  const current = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  for (const row of rows) {
    const date = new Date(row.updatedAt).toLocaleDateString("vi-VN");
    select.appendChild(new Option(`${row.key} · ${date}`, row.key));
  }
  if (rows.some((row) => row.key === current)) select.value = current;
}

async function saveGroupList() {
  const name = $("#groupListName").value.trim();
  let chosen;
  try {
    chosen = selectedGroups();
  } catch (error) {
    toast("Danh sách UID không hợp lệ", error.message, "warning", 7000);
    return;
  }
  if (!name) return toast("Thiếu tên danh sách", "Nhập tên trước khi lưu.", "warning");
  if (chosen.length === 0) return toast("Chưa chọn nhóm", "Chọn ít nhất một nhóm.", "warning");
  await dbPut(STORE.GROUP_LISTS, name, { groups: chosen });
  await refreshSavedSelects();
  $("#groupListSelect").value = name;
  toast("Đã lưu danh sách nhóm", `${name} · ${chosen.length} nhóm`, "success");
}

async function loadGroupList() {
  const key = $("#groupListSelect").value;
  if (!key) return toast("Chưa chọn danh sách", "Chọn một danh sách đã lưu.", "warning");
  const data = await dbGet(STORE.GROUP_LISTS, key);
  if (!data?.groups) return toast("Không tìm thấy dữ liệu", key, "error");
  groups = cloneData(data.groups);
  selectedGroupIds = new Set(groups.map((group) => group.id));
  $("#groupUidList").value = formatFacebookGroupUidList(groups);
  $("#groupListName").value = key;
  await renderGroups();
  toast("Đã mở danh sách nhóm", `${groups.length} nhóm được chọn`, "success");
}

async function deleteGroupList() {
  const key = $("#groupListSelect").value;
  if (!key) return toast("Chưa chọn danh sách", "Chọn danh sách cần xóa.", "warning");
  if (!await confirmAction("Xóa danh sách nhóm?", `Danh sách “${key}” sẽ bị xóa khỏi thiết bị này.`, "Xóa danh sách")) return;
  await dbDelete(STORE.GROUP_LISTS, key);
  await refreshSavedSelects();
  toast("Đã xóa danh sách", key, "success");
}

function currentDelay() {
  return {
    fixedSeconds: Number($("#fixedSeconds").value)
  };
}

function readSettings() {
  const fixedSeconds = Number($("#fixedSeconds").value);
  return {
    fixedSeconds: Number.isFinite(fixedSeconds) ? fixedSeconds : DEFAULT_SETTINGS.fixedSeconds
  };
}

function applySettings(settings = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const fixedSeconds = Number(merged.fixedSeconds);
  $("#fixedSeconds").value = Number.isFinite(fixedSeconds)
    ? Math.max(0, Math.min(86400, fixedSeconds))
    : DEFAULT_SETTINGS.fixedSeconds;
  updateEstimate();
}

function updateEstimate() {
  const count = selectedGroupIds.size;
  const delay = currentDelay();
  const seconds = estimateCampaignSeconds(count, delay);
  $("#estimateGroups").textContent = count.toLocaleString("vi-VN");
  $("#estimateTime").textContent = formatDuration(seconds);
  $("#estimateFinish").textContent = count > 0
    ? new Date(Date.now() + seconds * 1000).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })
    : "—";
  updateActionAvailability();
}

async function validateImage(file) {
  const types = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
  if (!file || !types.includes(file.type)) throw new Error("Chỉ chấp nhận JPG, PNG, GIF hoặc WEBP.");
  if (!/\.(jpe?g|png|gif|webp)$/i.test(file.name)) throw new Error("Phần mở rộng của tệp ảnh không hợp lệ.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Ảnh vượt quá 10MB.");
  if (file.size < MIN_IMAGE_BYTES) throw new Error("Ảnh nhỏ hơn 1KB hoặc đã hỏng.");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const valid = hex.startsWith("ffd8ff")
    || hex.startsWith("89504e47")
    || hex.startsWith("47494638")
    || (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250");
  if (!valid) throw new Error("Nội dung tệp không khớp định dạng ảnh cho phép.");
}

function mediaKind(file) {
  if (!file) return null;
  if (file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/i.test(file.name)) return "image";
  if (file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name)) return "video";
  return null;
}

async function validateVideo(file) {
  const types = ["video/mp4", "video/quicktime", "video/webm", ""];
  if (!file || !types.includes(file.type)) throw new Error("Chỉ chấp nhận MP4, MOV hoặc WEBM.");
  if (!/\.(mp4|mov|webm)$/i.test(file.name)) throw new Error("Phần mở rộng của tệp video không hợp lệ.");
  if (file.size > MAX_VIDEO_BYTES) throw new Error("Video vượt quá 500MB.");
  if (file.size < MIN_VIDEO_BYTES) throw new Error("Video nhỏ hơn 1KB hoặc đã hỏng.");
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const isIsoMedia = hex.slice(8, 16) === "66747970";
  const isWebm = hex.startsWith("1a45dfa3");
  if (!isIsoMedia && !isWebm) throw new Error("Nội dung tệp không khớp định dạng video cho phép.");
}

async function validateMedia(file) {
  const kind = mediaKind(file);
  if (kind === "image") await validateImage(file);
  else if (kind === "video") await validateVideo(file);
  else throw new Error("Chỉ chấp nhận tệp ảnh hoặc video được hỗ trợ.");
  return kind;
}

function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function setMedia(file, { persist = true } = {}) {
  const kind = file ? await validateMedia(file) : null;
  if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
  mediaObjectUrl = null;
  imageFile = kind === "image" ? file : null;
  videoFile = kind === "video" ? file : null;
  $("#imageInput").value = "";
  const imagePreview = $("#imagePreviewImg");
  const videoPreview = $("#videoPreviewPlayer");
  imagePreview.hidden = true;
  videoPreview.hidden = true;
  videoPreview.pause();
  videoPreview.removeAttribute("src");
  if (!file) {
    $("#imagePreview").hidden = true;
    imagePreview.removeAttribute("src");
    if (persist) {
      await Promise.all([
        dbDelete(STORE.ASSETS, "draftImage"),
        dbDelete(STORE.ASSETS, "draftVideo")
      ]);
    }
    return;
  }
  mediaObjectUrl = URL.createObjectURL(file);
  if (kind === "video") {
    videoPreview.src = mediaObjectUrl;
    videoPreview.hidden = false;
    videoPreview.load();
  } else {
    imagePreview.src = mediaObjectUrl;
    imagePreview.hidden = false;
  }
  $("#imageFileName").textContent = file.name;
  $("#imageFileMeta").textContent = `${kind === "video" ? "Video" : "Ảnh"} · ${formatFileSize(file.size)} · ${file.type || "không rõ MIME"}`;
  $("#imagePreview").hidden = false;
  if (persist) {
    if (kind === "video") {
      await dbDelete(STORE.ASSETS, "draftImage");
      await dbPut(STORE.ASSETS, "draftVideo", file);
    } else {
      await dbDelete(STORE.ASSETS, "draftVideo");
      await dbPut(STORE.ASSETS, "draftImage", file);
    }
  }
}

function collectCampaignConfig() {
  if (!profile || !api) throw new Error("Chưa đọc được phiên Facebook.");
  const queue = selectedGroups();
  if (queue.length === 0) throw new Error("Chưa chọn nhóm để đăng.");
  const posts = [];
  const previews = {};
  for (const item of postItems.slice(0, 1)) {
    const text = item.text.trim();
    if (!text) continue;
    const nextIndex = posts.length;
    posts.push(text);
    if (item.preview) previews[String(nextIndex)] = cloneData(item.preview);
  }
  if (posts.length === 0) throw new Error("Cần nhập nội dung bài đăng.");
  const delay = currentDelay();
  if (!Number.isFinite(delay.fixedSeconds) || delay.fixedSeconds < 0 || delay.fixedSeconds > 86400) {
    throw new Error("Chờ cố định phải là số từ 0 đến 86400 giây.");
  }
  return {
    queue,
    posts,
    previews,
    delay,
    imageFile,
    videoFile
  };
}

async function beginCampaign() {
  let config;
  try {
    config = collectCampaignConfig();
  } catch (error) {
    toast("Chưa thể bắt đầu", error.message, "error");
    return;
  }
  addLog({ level: "info", message: "---------------------------------------------------", time: Date.now() });
  void runner.start(config).catch((error) => {
    toast("Không khởi động được chiến dịch", error.message, "error");
  });
}

function statusText(status) {
  return {
    [RUN_STATUS.IDLE]: "Sẵn sàng",
    [RUN_STATUS.RUNNING]: "Đang đăng",
    [RUN_STATUS.WAITING]: "Đang chờ",
    [RUN_STATUS.PAUSED]: "Đã tạm dừng",
    [RUN_STATUS.COMPLETED]: "Đã hoàn tất",
    [RUN_STATUS.STOPPED]: "Đã dừng"
  }[status] || status;
}

function updateProgress(state) {
  const total = state.queue?.length || 0;
  const processed = Math.min(state.currentIndex || 0, total);
  const percent = total ? Math.round((processed / total) * 100) : 0;
  $("#progressBar").style.width = `${percent}%`;
  $("#progressPercent").textContent = `${percent}%`;
  $("#processedCount").textContent = processed.toLocaleString("vi-VN");
  $("#successCount").textContent = (state.successCount || 0).toLocaleString("vi-VN");
  $("#pendingCount").textContent = (state.pendingCount || 0).toLocaleString("vi-VN");
  $("#failCount").textContent = (state.failCount || 0).toLocaleString("vi-VN");
  $("#progressText").textContent = total
    ? `${processed.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")} nhóm`
    : "Chưa có chiến dịch";
  const status = $("#runnerStatus");
  status.className = `status-pill status-pill--${state.status || "idle"}`;
  status.textContent = statusText(state.status || RUN_STATUS.IDLE);
  const remainingSeconds = Math.max(0, Math.ceil((state.pendingDelayMs || 0) / 1000));
  if (remainingSeconds > 0) {
    const prefix = state.pendingDelayKind === "break"
      ? "☕ Hết giờ nghỉ sau"
      : state.pendingDelayKind === "retry"
        ? "↻ Thử lại sau"
        : "Bài tiếp theo sau";
    const next = state.queue?.[state.currentIndex]?.name;
    $("#countdownText").textContent = `${prefix} ${formatDuration(remainingSeconds)}${next ? ` · ${next}` : ""}`;
  } else if (state.phase === "posting" && state.queue?.[state.currentIndex]) {
    $("#countdownText").textContent = `Đang gửi tới ${state.queue[state.currentIndex].name}…`;
  } else if (state.status === RUN_STATUS.COMPLETED) {
    $("#countdownText").textContent = "Chiến dịch đã hoàn tất.";
  } else if (state.status === RUN_STATUS.STOPPED) {
    $("#countdownText").textContent = state.stoppedReason || "Chiến dịch đã dừng.";
  } else {
    $("#countdownText").textContent = "—";
  }
  const active = [RUN_STATUS.RUNNING, RUN_STATUS.WAITING, RUN_STATUS.PAUSED].includes(state.status);
  const nativeActive = isNativeGroupActive();
  $("#pauseBtn").hidden = !active || nativeActive;
  $("#stopBtn").hidden = !(active || nativeActive);
  $("#pauseBtn").textContent = state.status === RUN_STATUS.PAUSED ? "Tiếp tục" : "Tạm dừng";
  $("#startBtn").disabled = active || nativeActive || !profile || selectedGroupIds.size === 0;
  $("#nativeMultiGroupBtn").disabled = active || nativeActive || !profile || selectedGroupIds.size === 0;
  updateActionAvailability();
}

function updateActionAvailability() {
  const state = runner?.state || { status: RUN_STATUS.IDLE };
  const active = [RUN_STATUS.RUNNING, RUN_STATUS.WAITING, RUN_STATUS.PAUSED].includes(state.status);
  const nativeActive = isNativeGroupActive();
  const groupLoading = Boolean(groupLoadPromise);
  const uidListInvalid = groupUidResolution().invalidValues.length > 0;
  const groupControlsDisabled = !profile || active || nativeActive || groupLoading;
  $("#startBtn").disabled = groupControlsDisabled || uidListInvalid || selectedGroupIds.size === 0;
  $("#nativeMultiGroupBtn").disabled = groupControlsDisabled || uidListInvalid || selectedGroupIds.size === 0;
  $("#loadGroupsBtn").disabled = groupControlsDisabled;
  $("#groupUidList").disabled = groupControlsDisabled;
  if (nativeActive) {
    $("#pauseBtn").hidden = true;
    $("#stopBtn").hidden = false;
  } else if (!active) {
    $("#pauseBtn").hidden = true;
    $("#stopBtn").hidden = true;
  }
}

function initializeRunner() {
  if (runner) {
    runner.setApi(api);
    return;
  }
  runner = new CampaignRunner({
    api,
    onState: async (snapshot) => {
      updateProgress(snapshot);
      postedResultsPanel?.render(postedResultsFromCampaign(snapshot));
      try {
        await sendRequest(MESSAGE.SET_RUNTIME_STATE, { state: snapshot });
      } catch (error) {
        console.warn("Không lưu được trạng thái tiến trình:", error);
      }
    },
    onLog: addLog,
    onProgress: updateProgress,
    onComplete: (snapshot) => {
      postedResultsPanel?.render(postedResultsFromCampaign(snapshot));
      if (snapshot.status === RUN_STATUS.COMPLETED) {
        const level = snapshot.failCount > 0 || snapshot.pendingCount > 0 ? "warning" : "success";
        toast("Đăng bài đã hoàn tất", formatResultSummary(snapshot), level, 8000);
      } else if (snapshot.status === RUN_STATUS.STOPPED) {
        toast("Chiến dịch đã dừng", `${formatResultSummary(snapshot)}. ${snapshot.stoppedReason || ""}`.trim(), "warning", 8000);
      }
    }
  });
}

async function loadSession() {
  const button = $("#refreshSessionBtn");
  button.disabled = true;
  $("#accountName").textContent = "Đang đọc phiên Facebook…";
  try {
    profile = await readFacebookSession();
    api = new FacebookApi(profile);
    initializeRunner();
    $("#accountName").textContent = profile.NAME;
    $("#accountType").textContent = profile.type === "page" ? `Trang · ID ${profile.ID}` : `Tài khoản cá nhân · ID ${profile.ID}`;
    if (profile.profilePicture) {
      $("#accountAvatar").style.backgroundImage = `url("${profile.profilePicture.replace(/"/g, "%22")}")`;
      $("#accountAvatar").textContent = "";
    } else {
      $("#accountAvatar").style.backgroundImage = "";
      $("#accountAvatar").textContent = profile.NAME.slice(0, 2).toLocaleUpperCase("vi-VN");
    }
    addLog({ level: "success", message: `Đã kết nối Facebook: ${profile.NAME} (${profile.type === "page" ? "Trang" : "cá nhân"}).`, time: Date.now() });
    toast("Đã kết nối Facebook", profile.NAME, "success");
    if (!runtimeRestored) await restoreRuntimeState();
  } catch (error) {
    profile = null;
    api = null;
    $("#accountName").textContent = "Chưa kết nối Facebook";
    $("#accountType").textContent = "Đăng nhập Facebook rồi thử lại";
    addLog({ level: "error", message: `Không đọc được phiên Facebook: ${error.message}`, time: Date.now() });
    toast("Không đọc được phiên Facebook", error.message, "error", 8000);
  } finally {
    button.disabled = false;
    updateActionAvailability();
  }
}

async function restoreRuntimeState() {
  runtimeRestored = true;
  let snapshot = null;
  try {
    snapshot = await sendRequest(MESSAGE.GET_RUNTIME_STATE);
  } catch (error) {
    console.warn("Không đọc được trạng thái tiến trình:", error);
  }
  if (!snapshot || !Array.isArray(snapshot.queue) || snapshot.queue.length === 0) return;
  groups = cloneData(snapshot.queue);
  selectedGroupIds = new Set(groups.map((group) => group.id));
  $("#groupUidList").value = formatFacebookGroupUidList(groups);
  const sourcePosts = Array.isArray(snapshot.posts) ? snapshot.posts : [];
  const sourceIndex = Math.min(Math.max(0, Number(snapshot.currentPostIndex) || 0), Math.max(0, sourcePosts.length - 1));
  const restoredText = sourcePosts[sourceIndex] || sourcePosts[0] || "";
  const restoredPreview = snapshot.previews?.[String(sourceIndex)] || snapshot.previews?.["0"] || null;
  postItems = [newPostItem(restoredText, restoredPreview)];
  const restoredSettings = { ...readSettings() };
  if (snapshot.delay) Object.assign(restoredSettings, {
    fixedSeconds: snapshot.delay.fixedSeconds
  });
  applySettings(restoredSettings);
  const [storedImage, storedVideo] = await Promise.all([
    snapshot.hasImage ? dbGet(STORE.ASSETS, "draftImage") : null,
    snapshot.hasVideo ? dbGet(STORE.ASSETS, "draftVideo") : null
  ]);
  const storedMedia = storedVideo || storedImage;
  if (storedMedia) await setMedia(storedMedia, { persist: false });
  const normalizedSnapshot = {
    ...cloneData(snapshot),
    posts: [restoredText],
    previews: restoredPreview ? { "0": cloneData(restoredPreview) } : {},
    currentPostIndex: 0,
    delay: currentDelay(),
    safetyBreak: null,
    scheduledPublishTime: null,
    hasImage: Boolean(storedImage),
    hasVideo: Boolean(storedVideo),
    pendingDelayMs: snapshot.pendingDelayKind === "break" ? 0 : snapshot.pendingDelayMs,
    pendingDelayKind: snapshot.pendingDelayKind === "break" ? null : snapshot.pendingDelayKind
  };
  renderPosts();
  await renderGroups();
  await runner.restore(normalizedSnapshot, { imageFile: storedImage, videoFile: storedVideo });
  if (![RUN_STATUS.COMPLETED, RUN_STATUS.STOPPED, RUN_STATUS.IDLE].includes(snapshot.status)) {
    toast("Đã khôi phục chiến dịch", "Chiến dịch đang tạm dừng. Kiểm tra trạng thái rồi nhấn Tiếp tục.", "warning", 8000);
  }
}

async function handlePauseResume() {
  if (!runner) return;
  if (runner.state.status === RUN_STATUS.PAUSED) {
    const action = runner.runPromise ? runner.resume() : runner.resumeRestored();
    void Promise.resolve(action).catch((error) => toast("Không thể tiếp tục", error.message, "error"));
  } else {
    await runner.pause(false);
  }
}

async function handleStopAction() {
  if (isNativeGroupActive()) {
    await cancelNativeMultiGroupPost();
    return;
  }
  await runner?.stop("Người dùng đã dừng chiến dịch.");
}

async function resetEverything() {
  if (!await confirmAction("Đặt lại toàn bộ phiên làm việc?", "Nhóm đang tải, lựa chọn, bản nháp, ảnh/video, nhật ký và tiến trình hiện tại sẽ được xóa. Các danh sách nhóm đã lưu vẫn được giữ.", "Đặt lại")) return;
  if (isNativeGroupActive()) await cancelNativeMultiGroupPost();
  if (runner) await runner.reset();
  try {
    await Promise.all([
      sendRequest(MESSAGE.CLEAR_RUNTIME_STATE),
      sendRequest(MESSAGE.NATIVE_GROUP_POST_CLEAR)
    ]);
  } catch (error) {
    console.warn(error);
  }
  stopNativePolling();
  nativeGroupState = null;
  groups = [];
  selectedGroupIds.clear();
  postItems = [newPostItem()];
  await setMedia(null);
  await dbDelete(STORE.ASSETS, "draft");
  applySettings(DEFAULT_SETTINGS);
  await setLocal(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  clearLogs();
  postedResultsPanel?.render([]);
  renderPosts();
  await renderGroups({ showLoader: false });
  $("#groupSearch").value = "";
  $("#groupUidList").value = "";
  updateGroupUidListStatus();
  $("#groupListName").value = "";
  updateProgress({ status: RUN_STATUS.IDLE, queue: [], currentIndex: 0, successCount: 0, pendingCount: 0, failCount: 0 });
  toast("Đã đặt lại", "Các dữ liệu đã lưu vẫn được giữ nguyên.", "success");
}

function bindEvents() {
  $("#modalClose").addEventListener("click", () => closeModal(null));
  $("#modalBackdrop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeModal(null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#modalBackdrop").hidden) closeModal(null);
  });
  $("#refreshSessionBtn").addEventListener("click", loadSession);
  $("#loadGroupsBtn").addEventListener("click", loadFreshGroups);
  $("#groupUidList").addEventListener("input", syncGroupSelectionFromUidList);
  $("#groupUidList").addEventListener("change", () => void commitGroupUidListToTable());
  $("#groupSearch").addEventListener("input", filterGroups);
  $("#groupTableBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[type='checkbox']");
    const row = event.target.closest("tr[data-group-id]");
    if (!checkbox || !row) return;
    if (checkbox.checked) selectedGroupIds.add(row.dataset.groupId);
    else selectedGroupIds.delete(row.dataset.groupId);
    syncGroupUidListFromSelection();
    updateSelectedGroupUI();
  });
  $("#selectVisibleGroups").addEventListener("change", (event) => {
    for (const row of $$("#groupTableBody tr[data-group-id]:not([hidden])")) {
      const checkbox = $("input[type='checkbox']", row);
      checkbox.checked = event.target.checked;
      if (event.target.checked) selectedGroupIds.add(row.dataset.groupId);
      else selectedGroupIds.delete(row.dataset.groupId);
    }
    syncGroupUidListFromSelection();
    updateSelectedGroupUI();
  });
  $("#saveGroupListBtn").addEventListener("click", () => void saveGroupList().catch((error) => toast("Không lưu được danh sách", error.message, "error")));
  $("#loadGroupListBtn").addEventListener("click", () => void loadGroupList().catch((error) => toast("Không mở được danh sách", error.message, "error")));
  $("#deleteGroupListBtn").addEventListener("click", () => void deleteGroupList().catch((error) => toast("Không xóa được danh sách", error.message, "error")));

  const dropZone = $("#imageDropZone");
  $("#imageInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void setMedia(file)
      .then(() => toast(`Đã chọn ${mediaKind(file) === "video" ? "video" : "ảnh"}`, file.name, "success"))
      .catch((error) => toast("Tệp không hợp lệ", error.message, "error"));
  });
  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  }
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    void setMedia(file)
      .then(() => toast(`Đã chọn ${mediaKind(file) === "video" ? "video" : "ảnh"}`, file.name, "success"))
      .catch((error) => toast("Tệp không hợp lệ", error.message, "error"));
  });
  $("#removeImageBtn").addEventListener("click", () => void setMedia(null));

  const fixedDelayInput = $("#fixedSeconds");
  for (const eventName of ["input", "change"]) {
    fixedDelayInput.addEventListener(eventName, () => {
      updateEstimate();
      scheduleSettingsSave();
    });
  }
  $("#startBtn").addEventListener("click", () => void beginCampaign());
  $("#nativeMultiGroupBtn").addEventListener("click", () => void beginNativeMultiGroupPost());
  $("#pauseBtn").addEventListener("click", () => void handlePauseResume());
  $("#stopBtn").addEventListener("click", () => void handleStopAction());
  $("#resetBtn").addEventListener("click", () => void resetEverything());
  $("#clearLogsBtn").addEventListener("click", clearLogs);
}

async function initialize() {
  postedResultsPanel = new PostedResultsPanel({
    container: $("#postedResultsPanel"),
    list: $("#postedResultsList"),
    count: $("#postedResultsCount")
  });
  bindEvents();
  applySettings(DEFAULT_SETTINGS);
  renderPosts();
  updateProgress({ status: RUN_STATUS.IDLE, queue: [], currentIndex: 0, successCount: 0, pendingCount: 0, failCount: 0 });
  try {
    await sendRequest(MESSAGE.REGISTER_DASHBOARD, {});
  } catch (error) {
    console.warn("Không đăng ký được bảng điều khiển:", error);
  }
  try {
    const [settings, draft, storedImage, storedVideo] = await Promise.all([
      getLocal(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS),
      dbGet(STORE.ASSETS, "draft"),
      dbGet(STORE.ASSETS, "draftImage"),
      dbGet(STORE.ASSETS, "draftVideo")
    ]);
    applySettings(settings || DEFAULT_SETTINGS);
    if (draft?.posts?.length) {
      postItems = draft.posts.slice(0, 1).map((item) => ({
        id: item.id || createId(),
        text: item.text || "",
        preview: item.preview || null
      }));
      renderPosts();
    }
    if (storedVideo || storedImage) await setMedia(storedVideo || storedImage, { persist: false });
    await refreshSavedSelects();
  } catch (error) {
    toast("Không đọc được dữ liệu cục bộ", error.message, "warning");
  }
  updateEstimate();
  await loadSession();
  await restoreNativeGroupStatus();
}

window.addEventListener("pagehide", () => {
  stopNativePolling();
  window.clearTimeout(draftTimer);
  window.clearTimeout(settingsTimer);
});

void initialize();
