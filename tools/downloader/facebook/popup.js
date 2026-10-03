(() => {
  "use strict";

  const {
    STORAGE_KEYS,
    extractFacebookDownloadLinks,
    formatDateTime,
    isFacebookUrl,
    mergeSettings,
    normalizeFacebookDownloadUrl,
    sessionItems,
    storageGet,
    storageSet
  } = globalThis.ReelKit;

  const MAX_BATCH_LINKS = 1000;
  const ids = [
    "surfaceDot", "surfaceTitle", "surfaceUrl", "statusPill", "updatedAt",
    "statusMessage", "progressCount", "scrollCount", "progressFill", "foundCount",
    "readyCount", "downloadedCount", "resultMessage", "maxItems", "startButton",
    "stopButton", "resultsButton", "batchLinksInput", "batchLinkCount",
    "batchDownloadButton", "notice"
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  let activeTab = null;
  let currentSession = null;
  let toastTimer = null;
  let batchSubmitting = false;

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function tabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function showToast(message = "", error = false) {
    clearTimeout(toastTimer);
    el.notice.textContent = message;
    el.notice.className = `toast${message ? " show" : ""}${error ? " error" : ""}`;
    if (message) {
      toastTimer = setTimeout(() => { el.notice.className = "toast"; }, 3400);
    }
  }

  function sessionIsRunning(session) {
    return ["starting", "scanning", "resolving"].includes(session?.status);
  }

  function statusLabel(status) {
    return {
      starting: "Đang bắt đầu",
      scanning: "Đang quét",
      resolving: "Đang đọc",
      completed: "Hoàn tất",
      stopped: "Đã dừng",
      empty: "Không có kết quả",
      failed: "Có lỗi"
    }[status] || "Sẵn sàng";
  }

  function statusClass(status) {
    if (["starting", "scanning", "resolving"].includes(status)) return "running";
    if (status === "completed") return "completed";
    if (["failed", "empty"].includes(status)) return "error";
    return "idle";
  }

  function renderSession(session) {
    currentSession = session || null;
    const items = sessionItems(session);
    const ready = items.filter((item) => normalizeFacebookDownloadUrl(item.url)).length;
    const downloaded = items.filter((item) => item.downloadStatus === "completed").length;
    const running = sessionIsRunning(session);
    const count = items.length;
    const manualOnly = session?.sourceType === "manual-batch";
    const target = manualOnly
      ? Math.max(1, count)
      : Math.max(1, Number(session?.settings?.maxItems || el.maxItems.value || 500));
    const canViewResults = !running && count > 0;

    el.foundCount.textContent = String(count);
    el.readyCount.textContent = String(ready);
    el.downloadedCount.textContent = String(downloaded);
    el.statusMessage.textContent = session?.status === "completed"
      ? session?.hasManualBatch
        ? session.statusMessage || `Đã nhận ${count} link Facebook`
        : `Đã quét được ${count} Reel đúng kênh`
      : session?.statusMessage || "Sẵn sàng quét Facebook Reels";
    el.updatedAt.textContent = session?.updatedAt ? formatDateTime(session.updatedAt) : "Chưa có dữ liệu";
    el.scrollCount.textContent = manualOnly
      ? "Tải nền tối đa 5 luồng"
      : `${Number(session?.scrollStep || 0)} lần cuộn`;
    el.progressCount.textContent = manualOnly ? `${count} link` : `${count} / ${target}`;

    let percent = Math.min(100, Math.round((count / target) * 100));
    if (session?.status === "resolving" && session.resolveTotal) {
      percent = Math.round((Number(session.resolveDone || 0) / Number(session.resolveTotal)) * 100);
    } else if (session?.status === "completed") {
      percent = 100;
    }
    el.progressFill.style.width = `${Math.max(running ? 2 : 0, Math.min(100, percent))}%`;
    el.progressFill.parentElement.setAttribute("aria-valuenow", String(percent));

    el.statusPill.className = canViewResults
      ? "status-badge results-link"
      : `status-badge ${statusClass(session?.status)}`;
    el.statusPill.textContent = canViewResults ? "Xem kết quả" : statusLabel(session?.status);
    el.statusPill.disabled = !canViewResults;
    el.statusPill.title = canViewResults ? `Mở dashboard với ${count} Reel` : "Trạng thái quét";

    if (running) {
      el.resultMessage.textContent = `Đang quét, hiện đã lấy được ${count} Reel.`;
    } else if (count > 0) {
      el.resultMessage.textContent = `Đã có ${count} Reel. Mở dashboard để chọn và tải xuống.`;
    } else if (["failed", "empty"].includes(session?.status)) {
      el.resultMessage.textContent = session?.statusMessage || "Không lấy được Reel hợp lệ.";
    } else {
      el.resultMessage.textContent = "Chưa có dữ liệu. Hãy bắt đầu một lần quét.";
    }

    if (document.activeElement !== el.maxItems) el.maxItems.value = String(target);
    el.maxItems.disabled = running;
    el.startButton.disabled = running || !isFacebookUrl(activeTab?.url || "");
    el.stopButton.disabled = !running;
    el.resultsButton.disabled = !canViewResults;
    el.resultsButton.textContent = count ? `Xem kết quả (${count})` : "Xem kết quả";
    renderBatch();
  }

  function renderSurface(tab) {
    const valid = isFacebookUrl(tab?.url || "");
    el.surfaceDot.className = `source-dot ${valid ? "ok" : "bad"}`;
    el.surfaceTitle.textContent = valid ? "Đã kết nối với Facebook" : "Chưa mở trang Facebook";
    el.surfaceUrl.textContent = tab?.url || "Hãy mở mục Reels của Page/Profile";
    el.surfaceUrl.title = tab?.url || "";
    el.startButton.disabled = !valid || sessionIsRunning(currentSession);
  }

  async function ensureContentScripts(tabId) {
    try {
      const ping = await tabMessage(tabId, { type: "FBRS_PING" });
      if (ping?.ok) return;
    } catch {
      // Trang có thể đã mở trước khi extension được cài.
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["facebook/page-bridge.js"],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["facebook/shared.js", "facebook/content.js"]
    });
    const ping = await tabMessage(tabId, { type: "FBRS_PING" });
    if (!ping?.ok) throw new Error("Không thể kết nối với Facebook. Hãy tải lại trang.");
  }

  function readSettingsFromForm() {
    return mergeSettings({
      maxItems: Number(el.maxItems.value || 500),
      autoOpenResults: true,
      restoreScroll: true
    });
  }

  function parsedBatchLinks() {
    return extractFacebookDownloadLinks(el.batchLinksInput.value, MAX_BATCH_LINKS + 1);
  }

  function renderBatch() {
    const links = parsedBatchLinks();
    const limitExceeded = links.length > MAX_BATCH_LINKS;
    const scanning = sessionIsRunning(currentSession);
    el.batchLinkCount.textContent = limitExceeded
      ? `Vượt giới hạn ${MAX_BATCH_LINKS} link`
      : `${links.length} link hợp lệ, đã loại trùng`;
    el.batchLinkCount.classList.toggle("error", limitExceeded);
    el.batchLinksInput.disabled = scanning || batchSubmitting;
    el.batchDownloadButton.disabled =
      batchSubmitting || scanning || limitExceeded || links.length === 0;
    el.batchDownloadButton.textContent = batchSubmitting
      ? "Đang đưa link vào hàng tải…"
      : links.length
        ? `Tải hàng loạt chất lượng cao (${Math.min(links.length, MAX_BATCH_LINKS)})`
        : "Tải hàng loạt chất lượng cao";
  }

  async function startBatchDownload() {
    const links = parsedBatchLinks();
    if (!links.length) {
      showToast("Hãy nhập ít nhất một link Facebook hợp lệ.", true);
      return;
    }
    if (links.length > MAX_BATCH_LINKS) {
      showToast(`Mỗi lượt chỉ được nhập tối đa ${MAX_BATCH_LINKS} link.`, true);
      return;
    }

    batchSubmitting = true;
    renderBatch();
    try {
      const response = await runtimeMessage({
        type: "FBRS_START_BATCH_DOWNLOADS",
        links: links.map((link) => link.url)
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Không thể tạo hàng tải Facebook.");
      }
      el.batchLinksInput.value = "";
      if (response.added > 0) {
        showToast(`Đã đưa ${response.added} Reel vào hàng tải nền 5 luồng.`);
      } else {
        showToast("Các link này đã có trong hàng tải đang chạy.");
      }
    } catch (error) {
      showToast(error?.message || String(error), true);
    } finally {
      batchSubmitting = false;
      renderBatch();
    }
  }

  async function initialize() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
    const stored = await storageGet([STORAGE_KEYS.SESSION, STORAGE_KEYS.SETTINGS]);
    const settings = mergeSettings({
      ...(stored[STORAGE_KEYS.SETTINGS] || stored[STORAGE_KEYS.SESSION]?.settings || {}),
      autoOpenResults: true,
      restoreScroll: true
    });
    await storageSet({ [STORAGE_KEYS.SETTINGS]: settings });
    el.maxItems.value = String(settings.maxItems);
    renderSurface(activeTab);
    renderSession(stored[STORAGE_KEYS.SESSION] || null);
  }

  async function startScan() {
    showToast();
    if (!activeTab?.id || !isFacebookUrl(activeTab.url || "")) {
      showToast("Hãy mở Facebook và vào đúng mục Reels trước.", true);
      return;
    }
    el.startButton.disabled = true;
    try {
      const settings = readSettingsFromForm();
      await storageSet({ [STORAGE_KEYS.SETTINGS]: settings });
      await ensureContentScripts(activeTab.id);
      const response = await tabMessage(activeTab.id, { type: "FBRS_START_SCAN", settings });
      if (!response?.ok) throw new Error(response?.error || "Không thể bắt đầu quét.");
      showToast("Đã bắt đầu quét. Giữ nguyên trang Facebook.");
    } catch (error) {
      showToast(error?.message || String(error), true);
      el.startButton.disabled = false;
    }
  }

  async function stopScan() {
    const sourceTabId = currentSession?.sourceTabId || activeTab?.id;
    if (!sourceTabId) {
      showToast("Không tìm thấy tab Facebook đang quét.", true);
      return;
    }
    el.stopButton.disabled = true;
    try {
      const response = await tabMessage(sourceTabId, { type: "FBRS_STOP_SCAN" });
      showToast(response?.ok ? "Đã gửi yêu cầu dừng quét." : "Tiến trình đã kết thúc.");
    } catch {
      showToast("Tab Facebook đang quét đã đóng.", true);
    }
  }

  async function openResults() {
    if (el.resultsButton.disabled && el.statusPill.disabled) return;
    el.resultsButton.disabled = true;
    el.statusPill.disabled = true;
    try {
      const response = await runtimeMessage({ type: "FBRS_OPEN_RESULTS" });
      if (!response?.ok) throw new Error(response?.error || "Không mở được dashboard.");
      if (!response.panelClosed) {
        try {
          if (typeof chrome.sidePanel?.close === "function") {
            await chrome.sidePanel.close(Number.isInteger(response.panelWindowId)
              ? { windowId: response.panelWindowId }
              : {});
          } else {
            window.close();
          }
        } catch (_) {
          try { window.close(); } catch (_) {}
        }
      }
    } catch (error) {
      showToast(error?.message || String(error), true);
      renderSession(currentSession);
    }
  }

  el.startButton.addEventListener("click", startScan);
  el.stopButton.addEventListener("click", stopScan);
  el.batchLinksInput.addEventListener("input", renderBatch);
  el.batchDownloadButton.addEventListener("click", startBatchDownload);
  el.resultsButton.addEventListener("click", openResults);
  el.statusPill.addEventListener("click", openResults);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEYS.SESSION]) return;
    renderSession(changes[STORAGE_KEYS.SESSION].newValue || null);
  });

  initialize().catch((error) => showToast(error?.message || String(error), true));
})();
