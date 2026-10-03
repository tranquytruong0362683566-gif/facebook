(function initializeResultsDashboard() {
  "use strict";

  const { MESSAGE, createMessage, isRequest } = globalThis.TTProtocol;
  const { hasVideoCaption, sanitizeCaptionFilename } = globalThis.TTUtils;

  const elements = {
    refreshBtn: document.getElementById("refreshBtn"),
    closeDashboardBtn: document.getElementById("closeDashboardBtn"),
    scanStatusBadge: document.getElementById("scanStatusBadge"),
    scanSummary: document.getElementById("scanSummary"),
    sourceName: document.getElementById("sourceName"),
    totalVideos: document.getElementById("totalVideos"),
    selectedVideos: document.getElementById("selectedVideos"),
    downloadPanel: document.getElementById("downloadPanel"),
    downloadSummary: document.getElementById("downloadSummary"),
    downloadProgressFill: document.getElementById("downloadProgressFill"),
    downloadCurrent: document.getElementById("downloadCurrent"),
    pauseDownloadBtn: document.getElementById("pauseDownloadBtn"),
    clearDownloadBtn: document.getElementById("clearDownloadBtn"),
    resultSummary: document.getElementById("resultSummary"),
    clearResultsBtn: document.getElementById("clearResultsBtn"),
    searchInput: document.getElementById("searchInput"),
    qualitySelect: document.getElementById("qualitySelect"),
    selectAllCheckbox: document.getElementById("selectAllCheckbox"),
    selectedCount: document.getElementById("selectedCount"),
    downloadBtn: document.getElementById("downloadBtn"),
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    exportJsonBtn: document.getElementById("exportJsonBtn"),
    emptyState: document.getElementById("emptyState"),
    noMatchesState: document.getElementById("noMatchesState"),
    resultsList: document.getElementById("resultsList"),
    toast: document.getElementById("toast"),
  };

  const appState = {
    scanState: {
      running: false,
      status: "idle",
      message: "Sẵn sàng quét TikTok",
      target: 50,
      count: 0,
      sourceInfo: null,
    },
    results: [],
    downloadState: {
      running: false,
      paused: false,
      quality: "hd",
      queue: [],
      completed: 0,
      failed: 0,
    },
    settings: { quality: "hd" },
  };

  const selectedIds = new Set();
  let toastTimerId = null;
  let renderFrameId = null;
  let downloadControlBusy = false;
  let refreshBusy = false;
  let applicationStarted = false;

  function runtimeErrorMessage() {
    return chrome.runtime.lastError?.message || "";
  }

  function sendRequest(type, payload = {}, timeoutMs = 15000) {
    const message = createMessage(type, payload);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timerId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Hết thời gian chờ phản hồi cho ${type}`));
      }, timeoutMs);

      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timerId);
        const lastError = runtimeErrorMessage();
        if (lastError) reject(new Error(lastError));
        else resolve(response || null);
      });
    });
  }

  function showToast(message, isError = false) {
    if (toastTimerId) clearTimeout(toastTimerId);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.classList.add("show");
    toastTimerId = setTimeout(() => {
      elements.toast.classList.remove("show");
      toastTimerId = null;
    }, 3400);
  }

  function formatCompact(value) {
    const number = Number(value) || 0;
    return new Intl.NumberFormat("vi-VN", {
      notation: number >= 1000 ? "compact" : "standard",
      maximumFractionDigits: 1,
    }).format(number);
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value) || 0));
    if (!seconds) return "";
    const minutes = Math.floor(seconds / 60);
    const remaining = String(seconds % 60).padStart(2, "0");
    return `${minutes}:${remaining}`;
  }

  function statusLabel(status) {
    const labels = {
      idle: "Sẵn sàng",
      running: "Đang quét",
      stopping: "Đang dừng",
      completed: "Hoàn tất",
      stopped: "Đã dừng",
      error: "Có lỗi",
    };
    return labels[status] || "Sẵn sàng";
  }

  function validResults() {
    return Array.isArray(appState.results)
      ? appState.results.filter(hasVideoCaption)
      : [];
  }

  function filteredResults() {
    const keyword = elements.searchInput.value.trim().toLowerCase();
    const results = validResults();
    if (!keyword) return results;
    return results.filter((video) =>
      [video.caption, video.authorUsername, video.authorDisplayName, video.id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword)),
    );
  }

  function downloadByVideoId() {
    const entries = Array.isArray(appState.downloadState?.queue)
      ? appState.downloadState.queue
      : [];
    return new Map(entries.map((item) => [String(item.videoId), item]));
  }

  function pruneSelection() {
    const available = new Set(validResults().map((video) => String(video.id)));
    for (const id of selectedIds) {
      if (!available.has(id)) selectedIds.delete(id);
    }
  }

  function toggleSelection(id, selected) {
    if (selected) selectedIds.add(id);
    else selectedIds.delete(id);
    scheduleRender();
  }

  function createStat(label, value) {
    const item = document.createElement("span");
    item.textContent = `${label} ${formatCompact(value)}`;
    return item;
  }

  function createVideoCard(video, queueItem) {
    const id = String(video.id);
    const card = document.createElement("article");
    card.className = `video-card${selectedIds.has(id) ? " selected" : ""}`;
    card.dataset.videoId = id;

    const media = document.createElement("div");
    media.className = "video-media";

    if (video.cover) {
      const image = document.createElement("img");
      image.src = video.cover;
      image.alt = `Ảnh bìa video của ${video.authorUsername || "TikTok"}`;
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      media.appendChild(image);
    }

    const fallback = document.createElement("span");
    fallback.className = "media-fallback";
    fallback.textContent = "TikTok";
    media.appendChild(fallback);

    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "video-selector";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.has(id);
    checkbox.setAttribute("aria-label", `Chọn video ${id}`);
    checkbox.addEventListener("change", () =>
      toggleSelection(id, checkbox.checked),
    );
    const checkVisual = document.createElement("span");
    checkVisual.setAttribute("aria-hidden", "true");
    checkboxLabel.append(checkbox, checkVisual);
    media.appendChild(checkboxLabel);

    const duration = formatDuration(video.duration);
    if (duration) {
      const durationBadge = document.createElement("span");
      durationBadge.className = "duration-badge";
      durationBadge.textContent = duration;
      media.appendChild(durationBadge);
    }

    const content = document.createElement("div");
    content.className = "video-content";

    const caption = document.createElement("p");
    caption.className = "video-caption";
    caption.textContent = video.caption;
    caption.title = video.caption;

    const author = document.createElement("a");
    author.className = "video-author";
    author.href = video.videoUrl;
    author.target = "_blank";
    author.rel = "noreferrer";
    author.textContent = video.authorUsername
      ? `@${video.authorUsername}${video.authorDisplayName ? ` · ${video.authorDisplayName}` : ""}`
      : "Mở video TikTok";

    const stats = document.createElement("div");
    stats.className = "video-stats";
    stats.append(
      createStat("▶", video.stats?.views),
      createStat("♥", video.stats?.likes),
      createStat("Bình luận", video.stats?.comments),
    );

    const footer = document.createElement("div");
    footer.className = "video-footer";
    const videoId = document.createElement("span");
    videoId.textContent = `ID ${id}`;
    videoId.title = id;
    footer.appendChild(videoId);

    if (queueItem) {
      const downloadStatus = document.createElement("span");
      downloadStatus.className = `download-status ${queueItem.status}`;
      const size = formatBytes(queueItem.sizeBytes);
      downloadStatus.textContent = size
        ? `${queueItem.statusText} · ${size}`
        : queueItem.statusText;
      downloadStatus.title = queueItem.filename || queueItem.statusText;
      content.append(caption, author, stats, footer, downloadStatus);
    } else {
      content.append(caption, author, stats, footer);
    }

    card.append(media, content);
    card.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, label, select")) return;
      toggleSelection(id, !selectedIds.has(id));
    });
    return card;
  }

  function renderOverview() {
    const scan = appState.scanState || {};
    const total = validResults().length;
    const target = Math.max(1, Number(scan.target) || 50);

    elements.scanStatusBadge.className = `status-badge ${scan.status || "idle"}`;
    elements.scanStatusBadge.textContent = statusLabel(scan.status);
    elements.totalVideos.textContent = String(total);
    elements.selectedVideos.textContent = String(selectedIds.size);
    elements.sourceName.textContent =
      scan.sourceInfo?.name || "Chưa chọn nguồn";
    elements.sourceName.title = scan.sourceInfo?.url || "";

    if (scan.running) {
      elements.scanSummary.textContent = `Đang quét: đã lấy ${total}/${target} video.`;
    } else if (scan.status === "completed") {
      elements.scanSummary.textContent = `Đã quét xong ${total} video.`;
    } else if (scan.status === "stopped") {
      elements.scanSummary.textContent = `Đã dừng quét và giữ lại ${total} video.`;
    } else if (scan.status === "error") {
      elements.scanSummary.textContent = `${scan.message || "Quá trình quét gặp lỗi"} · Giữ lại ${total} video.`;
    } else if (total) {
      elements.scanSummary.textContent = `Đang lưu ${total} video từ lần quét gần nhất.`;
    } else {
      elements.scanSummary.textContent = "Chưa có tiến trình quét.";
    }
  }

  function renderResults() {
    const allResults = validResults();
    const visibleResults = filteredResults();
    const queueMap = downloadByVideoId();
    const fragment = document.createDocumentFragment();

    for (const video of visibleResults) {
      fragment.appendChild(
        createVideoCard(video, queueMap.get(String(video.id))),
      );
    }
    elements.resultsList.replaceChildren(fragment);

    const hasResults = allResults.length > 0;
    const hasMatches = visibleResults.length > 0;
    elements.emptyState.hidden = hasResults;
    elements.noMatchesState.hidden = !hasResults || hasMatches;
    elements.resultsList.hidden = !hasMatches;
    elements.resultSummary.textContent = elements.searchInput.value.trim()
      ? `${visibleResults.length}/${allResults.length} video phù hợp`
      : hasResults
        ? `${allResults.length} video đã quét được`
        : "Chưa có dữ liệu";

    const visibleIds = visibleResults.map((video) => String(video.id));
    const selectedVisible = visibleIds.filter((id) => selectedIds.has(id)).length;
    elements.selectAllCheckbox.checked =
      visibleIds.length > 0 && selectedVisible === visibleIds.length;
    elements.selectAllCheckbox.indeterminate =
      selectedVisible > 0 && selectedVisible < visibleIds.length;
    elements.selectAllCheckbox.disabled = visibleIds.length === 0;
    elements.selectedCount.textContent = `Đã chọn ${selectedIds.size}`;
  }

  function renderDownloadState() {
    const download = appState.downloadState || {};
    const queue = Array.isArray(download.queue) ? download.queue : [];
    const terminalCount = queue.filter((item) =>
      ["done", "error"].includes(item.status),
    ).length;
    const percent = queue.length
      ? Math.round((terminalCount / queue.length) * 100)
      : 0;
    const current = queue.find((item) =>
      ["resolving", "downloading", "pending", "paused"].includes(item.status),
    );

    elements.downloadPanel.hidden = queue.length === 0;
    elements.downloadProgressFill.style.width = `${percent}%`;
    elements.downloadProgressFill.classList.toggle(
      "paused",
      Boolean(download.paused),
    );
    elements.downloadProgressFill.parentElement.setAttribute(
      "aria-valuenow",
      String(percent),
    );
    elements.downloadSummary.textContent = queue.length
      ? `${download.completed || 0} thành công · ${download.failed || 0} lỗi · ${queue.length} tổng`
      : "0 video";
    elements.downloadCurrent.textContent = current
      ? current.statusText
      : queue.length
        ? "Lô tải xuống đã hoàn tất"
        : "Đang chờ...";
    elements.pauseDownloadBtn.disabled =
      !download.running || downloadControlBusy;
    elements.pauseDownloadBtn.textContent = download.paused
      ? "Tiếp tục"
      : "Tạm dừng";
    elements.pauseDownloadBtn.setAttribute(
      "aria-pressed",
      String(Boolean(download.paused)),
    );
    const canClearPausedQueue = Boolean(download.running && download.paused);
    elements.clearDownloadBtn.disabled =
      downloadControlBusy ||
      (Boolean(download.running) && !canClearPausedQueue);
    elements.clearDownloadBtn.textContent = canClearPausedQueue
      ? "Xóa hàng chờ"
      : "Xóa lịch sử tải";
    elements.clearDownloadBtn.classList.toggle("danger", canClearPausedQueue);
    elements.clearDownloadBtn.classList.toggle("ghost", !canClearPausedQueue);
    elements.clearDownloadBtn.title = canClearPausedQueue
      ? "Hủy các tác vụ đang tạm dừng và xóa toàn bộ hàng chờ"
      : "Xóa lịch sử của lô tải đã hoàn tất";

    const scanBusy =
      Boolean(appState.scanState?.running) ||
      appState.scanState?.status === "stopping";
    elements.downloadBtn.disabled =
      selectedIds.size === 0 || Boolean(download.running) || scanBusy;
    elements.downloadBtn.textContent = selectedIds.size
      ? `Tải xuống ${selectedIds.size} video`
      : "Tải video đã chọn";
    elements.qualitySelect.disabled = Boolean(download.running);
    elements.clearResultsBtn.disabled = scanBusy;
    elements.exportCsvBtn.disabled = validResults().length === 0;
    elements.exportJsonBtn.disabled = validResults().length === 0;
  }

  function render() {
    pruneSelection();
    renderOverview();
    renderResults();
    renderDownloadState();
    elements.refreshBtn.disabled = refreshBusy;
  }

  function scheduleRender() {
    if (renderFrameId !== null) return;
    renderFrameId = requestAnimationFrame(() => {
      renderFrameId = null;
      render();
    });
  }

  function applyStatePayload(payload = {}) {
    if (["scan", "scan_progress"].includes(payload.scope)) {
      if (payload.scanState) appState.scanState = payload.scanState;
      if (Array.isArray(payload.results)) appState.results = payload.results;
    }
    if (payload.scope === "download" && payload.downloadState) {
      appState.downloadState = payload.downloadState;
    }
    scheduleRender();
  }

  async function loadState({ quiet = false } = {}) {
    refreshBusy = true;
    scheduleRender();
    try {
      const response = await sendRequest(MESSAGE.GET_APP_STATE, {});
      if (!response?.success) {
        throw new Error(response?.message || "Không thể lấy dữ liệu kết quả");
      }
      Object.assign(appState, response.data || {});
      appState.results = validResults();
      elements.qualitySelect.value =
        appState.settings?.quality === "normal" ? "normal" : "hd";
      if (!quiet) showToast("Đã cập nhật dữ liệu mới nhất");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      refreshBusy = false;
      render();
    }
  }

  function makeDataFilename(extension) {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    return `tiktok-data-${timestamp}.${extension}`;
  }

  function saveBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const headers = [
      "id",
      "video_url",
      "caption",
      "author_username",
      "author_display_name",
      "posted_at",
      "views",
      "likes",
      "comments",
      "shares",
      "bookmarks",
      "hashtags",
      "music_name",
      "music_author",
      "duration_seconds",
      "download_filename",
    ];
    const rows = validResults().map((video) => [
      video.id,
      video.videoUrl,
      video.caption,
      video.authorUsername,
      video.authorDisplayName,
      video.postedAt,
      video.stats?.views,
      video.stats?.likes,
      video.stats?.comments,
      video.stats?.shares,
      video.stats?.bookmarks,
      video.hashtags,
      video.musicName,
      video.musicAuthor,
      video.duration,
      sanitizeCaptionFilename(
        video.caption,
        `tiktok_${video.authorUsername || "video"}_${video.id}`,
      ),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n");
    saveBlob(`\ufeff${csv}`, "text/csv;charset=utf-8", makeDataFilename("csv"));
  }

  elements.searchInput.addEventListener("input", scheduleRender);

  elements.selectAllCheckbox.addEventListener("change", () => {
    const visibleIds = filteredResults().map((video) => String(video.id));
    if (elements.selectAllCheckbox.checked) {
      for (const id of visibleIds) selectedIds.add(id);
    } else {
      for (const id of visibleIds) selectedIds.delete(id);
    }
    scheduleRender();
  });

  elements.downloadBtn.addEventListener("click", async () => {
    if (!selectedIds.size) return;
    elements.downloadBtn.disabled = true;
    try {
      const response = await sendRequest(
        MESSAGE.START_DOWNLOAD,
        {
          ids: Array.from(selectedIds),
          quality: elements.qualitySelect.value,
        },
        20000,
      );
      if (!response?.success) {
        throw new Error(response?.message || "Không thể bắt đầu tải");
      }
      showToast(response.message || "Đã đưa video vào hàng đợi tải xuống");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      scheduleRender();
    }
  });

  elements.pauseDownloadBtn.addEventListener("click", async () => {
    if (!appState.downloadState?.running || downloadControlBusy) return;
    const shouldResume = Boolean(appState.downloadState.paused);
    downloadControlBusy = true;
    render();
    try {
      const response = await sendRequest(
        shouldResume ? MESSAGE.RESUME_DOWNLOAD : MESSAGE.PAUSE_DOWNLOAD,
        {},
        20000,
      );
      if (!response?.success) {
        throw new Error(response?.message || "Không thể đổi trạng thái tải");
      }
      if (response.data?.downloadState) {
        appState.downloadState = response.data.downloadState;
      }
      showToast(response.message);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      downloadControlBusy = false;
      render();
    }
  });

  elements.clearDownloadBtn.addEventListener("click", async () => {
    if (downloadControlBusy) return;
    const download = appState.downloadState || {};
    if (download.running && !download.paused) {
      showToast("Hãy tạm dừng tải xuống trước khi xóa hàng chờ", true);
      return;
    }

    downloadControlBusy = true;
    render();
    try {
      const response = await sendRequest(MESSAGE.CLEAR_DOWNLOAD_QUEUE, {});
      if (!response?.success) {
        throw new Error(response?.message || "Không thể xóa lịch sử tải");
      }
      if (response.data?.downloadState) {
        appState.downloadState = response.data.downloadState;
      }
      showToast(response.message || "Đã xóa lịch sử tải");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      downloadControlBusy = false;
      render();
    }
  });

  elements.clearResultsBtn.addEventListener("click", async () => {
    if (!window.confirm("Xóa toàn bộ video TikTok đã quét?")) return;
    try {
      const response = await sendRequest(MESSAGE.CLEAR_RESULTS, {});
      if (!response?.success) {
        throw new Error(response?.message || "Không thể xóa kết quả");
      }
      selectedIds.clear();
      showToast(response.message || "Đã xóa toàn bộ kết quả");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.exportCsvBtn.addEventListener("click", exportCsv);
  elements.exportJsonBtn.addEventListener("click", () => {
    saveBlob(
      JSON.stringify(validResults(), null, 2),
      "application/json;charset=utf-8",
      makeDataFilename("json"),
    );
  });

  elements.refreshBtn.addEventListener("click", () => loadState());

  elements.closeDashboardBtn.addEventListener("click", () => {
    chrome.tabs.getCurrent((tab) => {
      const lastError = runtimeErrorMessage();
      if (!lastError && Number.isInteger(tab?.id)) {
        chrome.tabs.remove(tab.id);
        return;
      }
      window.close();
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!isRequest(message) || message.type !== MESSAGE.APP_STATE_CHANGED) {
      return false;
    }
    applyStatePayload(message.payload);
    return false;
  });

  function startApplication() {
    if (applicationStarted) return;
    applicationStarted = true;
    loadState({ quiet: true });
  }

  if (document.documentElement.dataset.tqtLicenseAuthorized === "true") {
    startApplication();
  } else {
    window.addEventListener("tqt:license-authorized", startApplication, {
      once: true,
    });
  }
})();
