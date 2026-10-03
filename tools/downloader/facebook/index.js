(() => {
  "use strict";

  const {
    STORAGE_KEYS,
    cleanText,
    formatDuration,
    mergeSettings,
    normalizeFacebookDownloadUrl,
    sanitizeFolder,
    sessionItems,
    storageGet,
    storageRemove,
    storageSet
  } = globalThis.ReelKit;

  const ids = [
    "refreshButton", "openSourceButton", "closeDashboardButton", "pageName", "scanStatusBadge",
    "scanMessage", "sourceUrl", "totalStat", "readyStat", "selectedStat", "doneStat",
    "queueCard", "queueTitle", "queueSubtitle", "queueProgress", "queueCurrent", "retryButton",
    "cancelButton", "visibleCount", "clearButton", "searchInput", "filterSelect", "masterCheckbox",
    "selectedCount", "downloadSelectedButton", "folderInput", "saveFolderButton",
    "emptyState", "noMatchesState", "resultsList", "toast"
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  let session = null;
  let queue = null;
  let settings = mergeSettings({});
  let visibleItems = [];
  let refreshBusy = false;
  let toastTimer = null;
  const selected = new Set();

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.className = `toast show${error ? " error" : ""}`;
    toastTimer = setTimeout(() => { el.toast.className = "toast"; }, 3400);
  }

  function runningStatus(status) {
    return ["starting", "scanning", "resolving"].includes(status);
  }

  function scanStatusText(status) {
    return {
      starting: "Đang bắt đầu",
      scanning: "Đang quét",
      resolving: "Đang đọc metadata",
      completed: "Hoàn tất",
      stopped: "Đã dừng",
      empty: "Không có kết quả",
      failed: "Có lỗi"
    }[status] || "Sẵn sàng";
  }

  function downloadStatusText(item) {
    const status = item.downloadStatus || "idle";
    return {
      idle: downloadable(item) ? "Có link · chờ FSave" : "Thiếu link Reel",
      queued: "Đang xếp hàng",
      resolving: "FSave đang đọc liên kết",
      rendering: "FSave đang render",
      starting: "Đang bắt đầu",
      downloading: "Đang tải xuống",
      retrying: "Đang thử lại",
      completed: "Đã tải xong",
      failed: "Tải thất bại",
      cancelled: "Đã hủy"
    }[status] || status;
  }

  function downloadable(item) {
    return Boolean(item && !item.excluded && normalizeFacebookDownloadUrl(item.url));
  }

  function activeDownloadStatus(status) {
    return ["queued", "resolving", "rendering", "retrying", "starting", "downloading"].includes(status);
  }

  function filterItems(items) {
    const query = cleanText(el.searchInput.value, 300).toLocaleLowerCase("vi");
    const filter = el.filterSelect.value;
    return items.filter((item) => {
      if (query) {
        const haystack = `${item.description || ""} ${item.title || ""} ${item.ownerName || ""} ${item.id || ""}`.toLocaleLowerCase("vi");
        if (!haystack.includes(query)) return false;
      }
      if (filter === "ready" && !downloadable(item)) return false;
      if (filter === "unavailable" && downloadable(item)) return false;
      if (filter === "completed" && item.downloadStatus !== "completed") return false;
      if (filter === "failed" && item.downloadStatus !== "failed") return false;
      return true;
    });
  }

  function textNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function createVideoCard(item) {
    const canDownload = downloadable(item);
    const card = document.createElement("article");
    card.className = `video-card${selected.has(item.id) ? " selected" : ""}${canDownload ? "" : " unavailable"}`;
    card.dataset.id = item.id;

    const media = document.createElement("div");
    media.className = "video-media";
    if (item.thumbnail) {
      const image = document.createElement("img");
      image.src = item.thumbnail;
      image.alt = `Ảnh bìa Reel ${item.id}`;
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      media.append(image);
    }
    media.append(textNode("span", "media-fallback", "Facebook"));

    const checkLabel = document.createElement("label");
    checkLabel.className = "video-selector";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(item.id);
    checkbox.disabled = !canDownload;
    checkbox.setAttribute("aria-label", `Chọn Reel ${item.id}`);
    checkbox.addEventListener("change", () => toggleSelection(item.id, checkbox.checked));
    const checkVisual = document.createElement("span");
    checkVisual.setAttribute("aria-hidden", "true");
    checkLabel.append(checkbox, checkVisual);
    media.append(checkLabel);

    const duration = formatDuration(item.duration);
    if (duration) media.append(textNode("span", "duration-badge", duration));

    const content = document.createElement("div");
    content.className = "video-content";
    const displayTitle = item.description || item.title || `Facebook Reel ${item.id}`;
    const caption = textNode("p", "video-caption", displayTitle);
    caption.title = displayTitle;

    const author = textNode("a", "video-author", item.ownerName ? `Kênh: ${item.ownerName}` : "Mở Reel Facebook");
    author.href = item.url;
    author.target = "_blank";
    author.rel = "noreferrer";

    const footer = document.createElement("div");
    footer.className = "video-footer";
    const id = textNode("span", "", `ID ${item.id}`);
    id.title = item.id;
    footer.append(id);

    const status = textNode("span", `download-status ${item.downloadStatus || "idle"}`, downloadStatusText(item));
    status.title = item.downloadError || item.resolveError || downloadStatusText(item);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const downloadButton = textNode("button", "button secondary", "Tải Reel");
    downloadButton.type = "button";
    downloadButton.dataset.action = "download";
    downloadButton.disabled = !canDownload || activeDownloadStatus(item.downloadStatus);
    const openButton = textNode("button", "button ghost", "Mở Facebook ↗");
    openButton.type = "button";
    openButton.dataset.action = "open";
    actions.append(downloadButton, openButton);

    content.append(caption, author, footer, status, actions);
    card.append(media, content);
    card.addEventListener("click", (event) => {
      if (!canDownload || event.target.closest("a, button, input, label, select")) return;
      toggleSelection(item.id, !selected.has(item.id));
    });
    actions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "open") chrome.tabs.create({ url: item.url });
      if (button.dataset.action === "download") {
        button.disabled = true;
        saveFolder().then(() => queueDownloads([item.id])).catch((error) => toast(error?.message || String(error), true));
      }
    });
    return card;
  }

  function renderOverview(items) {
    const ready = items.filter(downloadable).length;
    const done = items.filter((item) => item.downloadStatus === "completed").length;
    const status = session?.status || "";
    el.pageName.textContent = session?.pageName || "Kết quả hiện tại";
    el.scanMessage.textContent = session?.statusMessage || "Chưa có tiến trình quét.";
    el.scanStatusBadge.textContent = scanStatusText(status);
    el.scanStatusBadge.className = `status-badge ${runningStatus(status) ? "running" : status === "completed" ? "completed" : ["failed", "empty"].includes(status) ? "error" : "idle"}`;
    el.sourceUrl.textContent = session?.sourceUrl || "Chưa chọn nguồn";
    el.sourceUrl.href = session?.sourceUrl || "#";
    el.sourceUrl.title = session?.sourceUrl || "";
    el.openSourceButton.disabled = !session?.sourceUrl;
    el.totalStat.textContent = String(items.length);
    el.readyStat.textContent = String(ready);
    el.selectedStat.textContent = String(selected.size);
    el.doneStat.textContent = String(done);
    el.clearButton.disabled = !session || runningStatus(status);
  }

  function renderQueue() {
    const jobs = queue?.jobs || [];
    const activeJobs = jobs.filter((job) => ["resolving", "rendering", "retrying", "downloading"].includes(job.status));
    const queued = jobs.filter((job) => job.status === "queued").length;
    const complete = jobs.filter((job) => job.status === "completed").length;
    const failed = jobs.filter((job) => job.status === "failed").length;
    const cancelled = jobs.filter((job) => job.status === "cancelled").length;
    const live = activeJobs.length + queued;
    const meaningful = jobs.length > 0 && (live > 0 || complete > 0 || failed > 0);
    el.queueCard.hidden = !meaningful;
    if (!meaningful) return;

    const maxConcurrent = Number(queue?.maxConcurrent || 5);
    el.queueTitle.textContent = activeJobs.length ? "Tiến trình tải video" : "Lượt tải gần nhất";
    el.queueSubtitle.textContent = `${complete} thành công · ${failed} lỗi · ${jobs.length} tổng`;
    el.queueCurrent.textContent = activeJobs.length
      ? `${activeJobs.length}/${maxConcurrent} luồng đang chạy · ${queued} Reel đang chờ`
      : queued
        ? `${queued} Reel đang chờ`
        : "Lô tải xuống đã hoàn tất";
    const terminal = complete + failed + cancelled;
    const percent = jobs.length ? Math.round((terminal / jobs.length) * 100) : 0;
    el.queueProgress.style.width = `${Math.max(live ? 2 : 0, percent)}%`;
    el.queueProgress.parentElement.setAttribute("aria-valuenow", String(percent));
    el.retryButton.hidden = failed === 0;
    el.cancelButton.hidden = live === 0;
  }

  function renderSelection() {
    const selectable = visibleItems.filter(downloadable);
    const selectedVisible = selectable.filter((item) => selected.has(item.id)).length;
    el.masterCheckbox.checked = selectable.length > 0 && selectedVisible === selectable.length;
    el.masterCheckbox.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
    el.masterCheckbox.disabled = selectable.length === 0;
    el.selectedCount.textContent = `Đã chọn ${selected.size}`;
    el.selectedStat.textContent = String(selected.size);
    el.downloadSelectedButton.disabled = selected.size === 0;
    el.downloadSelectedButton.textContent = selected.size ? `Tải xuống ${selected.size} Reel` : "Tải Reel đã chọn";
  }

  function renderResults(items) {
    visibleItems = filterItems(items);
    const fragment = document.createDocumentFragment();
    for (const item of visibleItems) fragment.append(createVideoCard(item));
    el.resultsList.replaceChildren(fragment);

    const hasItems = items.length > 0;
    const hasMatches = visibleItems.length > 0;
    el.emptyState.hidden = hasItems;
    el.noMatchesState.hidden = !hasItems || hasMatches;
    el.resultsList.hidden = !hasMatches;
    el.visibleCount.textContent = el.searchInput.value.trim() || el.filterSelect.value !== "all"
      ? `${visibleItems.length}/${items.length} Reel phù hợp`
      : hasItems ? `${items.length} Reel đã quét được` : "Chưa có dữ liệu";
  }

  function render() {
    const items = sessionItems(session);
    const available = new Set(items.filter(downloadable).map((item) => item.id));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
    renderOverview(items);
    renderQueue();
    renderResults(items);
    renderSelection();
    el.refreshButton.disabled = refreshBusy;
  }

  function toggleSelection(id, force) {
    const item = session?.items?.[id];
    if (!downloadable(item)) return;
    if (force) selected.add(id);
    else selected.delete(id);
    render();
  }

  async function queueDownloads(itemIds) {
    if (!session?.id) throw new Error("Chưa có danh sách quét.");
    const response = await runtimeMessage({ type: "FBRS_START_DOWNLOADS", sessionId: session.id, itemIds });
    if (!response?.ok) throw new Error(response?.error || "Không tạo được hàng tải.");
    toast(`Đã đưa ${response.added} Reel vào hàng đợi 5 luồng.`);
  }

  async function saveFolder(showToast = false) {
    settings = mergeSettings({ ...settings, downloadFolder: sanitizeFolder(el.folderInput.value) });
    el.folderInput.value = settings.downloadFolder;
    await storageSet({ [STORAGE_KEYS.SETTINGS]: settings });
    if (showToast) toast(`Đã lưu thư mục Downloads/${settings.downloadFolder}.`);
  }

  async function downloadSelected() {
    el.downloadSelectedButton.disabled = true;
    try {
      await saveFolder();
      await queueDownloads([...selected]);
      selected.clear();
      render();
    } catch (error) {
      toast(error?.message || String(error), true);
      renderSelection();
    }
  }

  async function clearResults() {
    if (!confirm("Xóa toàn bộ Reel đã quét và hàng đợi hiện tại? Video đã tải về máy không bị xóa.")) return;
    try {
      await runtimeMessage({ type: "FBRS_RESET_QUEUE", keepActive: false });
      await storageRemove(STORAGE_KEYS.SESSION);
      session = null;
      queue = null;
      selected.clear();
      render();
      toast("Đã xóa toàn bộ kết quả.");
    } catch (error) {
      toast(error?.message || String(error), true);
    }
  }

  async function retryFailed() {
    try {
      const response = await runtimeMessage({ type: "FBRS_RETRY_FAILED" });
      if (!response?.ok) throw new Error(response?.error || "Không thể thử lại.");
      toast(`Đã đưa ${response.count} Reel lỗi trở lại hàng đợi.`);
    } catch (error) {
      toast(error?.message || String(error), true);
    }
  }

  async function cancelQueue() {
    try {
      const response = await runtimeMessage({ type: "FBRS_CANCEL_QUEUE", includeActive: false });
      if (!response?.ok) throw new Error(response?.error || "Không thể hủy hàng chờ.");
      toast(`Đã hủy ${response.count} Reel chưa tải xong.`);
    } catch (error) {
      toast(error?.message || String(error), true);
    }
  }

  async function loadState(showToast = false) {
    refreshBusy = true;
    render();
    try {
      const stored = await storageGet([STORAGE_KEYS.SESSION, STORAGE_KEYS.QUEUE, STORAGE_KEYS.SETTINGS]);
      session = stored[STORAGE_KEYS.SESSION] || null;
      queue = stored[STORAGE_KEYS.QUEUE] || null;
      settings = mergeSettings(stored[STORAGE_KEYS.SETTINGS] || session?.settings || {});
      el.folderInput.value = settings.downloadFolder;
      if (showToast) toast("Đã cập nhật dữ liệu mới nhất.");
    } finally {
      refreshBusy = false;
      render();
    }
  }

  el.searchInput.addEventListener("input", render);
  el.filterSelect.addEventListener("change", render);
  el.masterCheckbox.addEventListener("change", () => {
    for (const item of visibleItems.filter(downloadable)) {
      if (el.masterCheckbox.checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    render();
  });
  el.downloadSelectedButton.addEventListener("click", downloadSelected);
  el.saveFolderButton.addEventListener("click", () => saveFolder(true).catch((error) => toast(error?.message || String(error), true)));
  el.clearButton.addEventListener("click", clearResults);
  el.retryButton.addEventListener("click", retryFailed);
  el.cancelButton.addEventListener("click", cancelQueue);
  el.refreshButton.addEventListener("click", () => loadState(true).catch((error) => toast(error?.message || String(error), true)));
  el.openSourceButton.addEventListener("click", () => { if (session?.sourceUrl) chrome.tabs.create({ url: session.sourceUrl }); });
  el.sourceUrl.addEventListener("click", (event) => { if (!session?.sourceUrl) event.preventDefault(); });
  el.closeDashboardButton.addEventListener("click", () => {
    chrome.tabs.getCurrent((tab) => {
      const error = chrome.runtime.lastError;
      if (!error && Number.isInteger(tab?.id)) chrome.tabs.remove(tab.id);
      else window.close();
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[STORAGE_KEYS.SESSION]) session = changes[STORAGE_KEYS.SESSION].newValue || null;
    if (changes[STORAGE_KEYS.QUEUE]) queue = changes[STORAGE_KEYS.QUEUE].newValue || null;
    if (changes[STORAGE_KEYS.SETTINGS]) {
      settings = mergeSettings(changes[STORAGE_KEYS.SETTINGS].newValue || {});
      if (document.activeElement !== el.folderInput) el.folderInput.value = settings.downloadFolder;
    }
    render();
  });

  loadState().catch((error) => toast(error?.message || String(error), true));
})();
