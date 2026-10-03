(function initializeSidePanel() {
  "use strict";

  const { MESSAGE, createMessage, isRequest } = globalThis.TTProtocol;
  const { clampNumber, extractTikTokDownloadLinks, hasVideoCaption } =
    globalThis.TTUtils;
  const MAX_BATCH_LINKS = 1000;

  const elements = {
    scanStatusBadge: document.getElementById("scanStatusBadge"),
    targetInput: document.getElementById("targetInput"),
    scanBtn: document.getElementById("scanBtn"),
    stopBtn: document.getElementById("stopBtn"),
    scanMessage: document.getElementById("scanMessage"),
    scanCount: document.getElementById("scanCount"),
    scanProgressFill: document.getElementById("scanProgressFill"),
    sourceName: document.getElementById("sourceName"),
    scrollCount: document.getElementById("scrollCount"),
    resultCount: document.getElementById("resultCount"),
    resultMessage: document.getElementById("resultMessage"),
    viewResultsBtn: document.getElementById("viewResultsBtn"),
    downloadFolderInput: document.getElementById("downloadFolderInput"),
    saveDownloadFolderBtn: document.getElementById("saveDownloadFolderBtn"),
    batchLinksInput: document.getElementById("batchLinksInput"),
    batchLinkCount: document.getElementById("batchLinkCount"),
    batchDownloadBtn: document.getElementById("batchDownloadBtn"),
    toast: document.getElementById("toast"),
  };

  const appState = {
    scanState: {
      running: false,
      status: "idle",
      message: "Sẵn sàng quét TikTok",
      target: 50,
      count: 0,
      scrollCount: 0,
      sourceInfo: null,
    },
    results: [],
    settings: { target: 50, quality: "hd", downloadFolder: "TikTok Videos" },
    downloadState: {
      running: false,
      paused: false,
      queue: [],
    },
  };

  let toastTimerId = null;
  let applicationStarted = false;
  let folderSaveBusy = false;

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
    }, 3200);
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

  function parsedBatchLinks() {
    return extractTikTokDownloadLinks(
      elements.batchLinksInput.value,
      MAX_BATCH_LINKS + 1,
    );
  }

  function render() {
    const scan = appState.scanState || {};
    const results = validResults();
    const target = Math.max(1, Number(scan.target) || 50);
    const count = Math.max(Number(scan.count) || 0, results.length);
    const running = Boolean(scan.running);
    const stopping = scan.status === "stopping";
    const finished = !running && !stopping;
    const completed = scan.status === "completed";
    const canViewResults = finished && count > 0;
    const percent = completed
      ? 100
      : Math.min(100, Math.round((count / target) * 100));

    elements.scanStatusBadge.className = canViewResults
      ? "status-badge results-link"
      : `status-badge ${scan.status || "idle"}`;
    elements.scanStatusBadge.textContent = canViewResults
      ? "Xem kết quả"
      : completed
        ? "0 video"
        : statusLabel(scan.status);
    elements.scanStatusBadge.disabled = !canViewResults;
    elements.scanStatusBadge.title = canViewResults
      ? `Mở bảng điều khiển với ${count} video`
      : "Trạng thái quét";
    elements.scanMessage.textContent = completed
      ? `Đã quét được ${count} video`
      : scan.message || "Sẵn sàng quét TikTok";
    elements.scanCount.textContent = `${count} / ${target}`;
    elements.scanProgressFill.style.width = `${percent}%`;
    elements.scanProgressFill.parentElement.setAttribute(
      "aria-valuenow",
      String(percent),
    );
    elements.sourceName.textContent =
      scan.sourceInfo?.name || "Chưa chọn nguồn";
    elements.sourceName.title = scan.sourceInfo?.url || "";
    elements.scrollCount.textContent = `${Number(scan.scrollCount) || 0} lần cuộn`;

    elements.resultCount.textContent = String(count);
    if (running) {
      elements.resultMessage.textContent = `Đang quét, hiện đã lấy được ${count} video.`;
    } else if (count > 0) {
      elements.resultMessage.textContent = `Đã quét được ${count} video. Mở bảng kết quả để chọn và tải xuống.`;
    } else if (scan.status === "error") {
      elements.resultMessage.textContent =
        scan.message || "Lần quét vừa rồi gặp lỗi và chưa lấy được video.";
    } else {
      elements.resultMessage.textContent =
        "Chưa có dữ liệu. Hãy bắt đầu một lần quét.";
    }

    if (document.activeElement !== elements.targetInput) {
      elements.targetInput.value = String(target);
    }
    elements.targetInput.disabled = running || stopping;
    elements.scanBtn.disabled = running || stopping;
    elements.stopBtn.disabled = !running || stopping;
    elements.viewResultsBtn.disabled = !canViewResults;
    elements.viewResultsBtn.textContent = count
      ? `Xem kết quả (${count})`
      : "Xem kết quả";

    const savedFolder =
      String(appState.settings?.downloadFolder || "").trim() ||
      "TikTok Videos";
    if (
      document.activeElement !== elements.downloadFolderInput &&
      !folderSaveBusy
    ) {
      elements.downloadFolderInput.value = savedFolder;
    }
    elements.saveDownloadFolderBtn.disabled =
      folderSaveBusy || !elements.downloadFolderInput.value.trim();
    elements.saveDownloadFolderBtn.textContent = folderSaveBusy
      ? "Đang lưu..."
      : "Lưu";

    const batchLinks = parsedBatchLinks();
    const batchLimitExceeded = batchLinks.length > MAX_BATCH_LINKS;
    const downloadRunning = Boolean(appState.downloadState?.running);
    elements.batchLinksInput.disabled = downloadRunning;
    elements.batchLinkCount.textContent = batchLimitExceeded
      ? `Vượt giới hạn ${MAX_BATCH_LINKS} link`
      : `${batchLinks.length} link hợp lệ, đã loại trùng`;
    elements.batchLinkCount.classList.toggle("error", batchLimitExceeded);
    elements.batchDownloadBtn.disabled =
      batchLinks.length === 0 ||
      batchLimitExceeded ||
      downloadRunning ||
      running ||
      stopping;
    elements.batchDownloadBtn.textContent = downloadRunning
      ? "Đang tải hàng loạt..."
      : batchLinks.length
        ? `Tải hàng loạt HD (${batchLinks.length})`
        : "Tải hàng loạt HD";
  }

  function applyStatePayload(payload = {}) {
    if (["scan", "scan_progress"].includes(payload.scope)) {
      if (payload.scanState) appState.scanState = payload.scanState;
      if (Array.isArray(payload.results)) appState.results = payload.results;
    }
    if (payload.scope === "download" && payload.downloadState) {
      appState.downloadState = payload.downloadState;
    }
    if (payload.scope === "settings" && payload.settings) {
      appState.settings = payload.settings;
    }
    render();
  }

  async function loadInitialState() {
    try {
      const response = await sendRequest(MESSAGE.GET_APP_STATE, {});
      if (!response?.success) {
        throw new Error(response?.message || "Không thể lấy trạng thái quét");
      }
      Object.assign(appState, response.data || {});
      render();
    } catch (error) {
      showToast(error.message, true);
      render();
    }
  }

  elements.scanBtn.addEventListener("click", async () => {
    const target = Math.round(
      clampNumber(elements.targetInput.value, 1, 1000, 50),
    );
    elements.targetInput.value = String(target);
    elements.scanBtn.disabled = true;

    try {
      const response = await sendRequest(MESSAGE.START_SCAN, { target }, 20000);
      if (!response?.success) {
        throw new Error(response?.message || "Không thể bắt đầu quét");
      }
      showToast(response.message || "Đã bắt đầu quét TikTok");
    } catch (error) {
      showToast(error.message, true);
      elements.scanBtn.disabled = false;
    }
  });

  elements.stopBtn.addEventListener("click", async () => {
    elements.stopBtn.disabled = true;
    try {
      const response = await sendRequest(MESSAGE.STOP_SCAN, {});
      if (!response?.success) {
        throw new Error(response?.message || "Không thể dừng quét");
      }
      showToast(response.message || "Đang dừng quét");
    } catch (error) {
      showToast(error.message, true);
      elements.stopBtn.disabled = false;
    }
  });

  elements.batchLinksInput.addEventListener("input", render);

  async function saveDownloadFolder() {
    if (folderSaveBusy) return;
    const folder = elements.downloadFolderInput.value.trim();
    if (!folder) {
      showToast("Hãy nhập tên thư mục tải xuống", true);
      elements.downloadFolderInput.focus();
      return;
    }

    folderSaveBusy = true;
    render();
    try {
      const response = await sendRequest(
        MESSAGE.SAVE_DOWNLOAD_FOLDER,
        { folder },
        15000,
      );
      if (!response?.success) {
        throw new Error(response?.message || "Không thể lưu thư mục tải xuống");
      }
      if (response.data?.settings) {
        appState.settings = response.data.settings;
      }
      elements.downloadFolderInput.value =
        response.data?.downloadFolder || folder;
      showToast(response.message || "Đã lưu thư mục tải xuống");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      folderSaveBusy = false;
      render();
    }
  }

  elements.saveDownloadFolderBtn.addEventListener("click", saveDownloadFolder);
  elements.downloadFolderInput.addEventListener("input", render);
  elements.downloadFolderInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveDownloadFolder();
  });

  elements.batchDownloadBtn.addEventListener("click", async () => {
    const links = parsedBatchLinks();
    if (!links.length) {
      showToast("Hãy nhập ít nhất một link TikTok hợp lệ", true);
      return;
    }
    if (links.length > MAX_BATCH_LINKS) {
      showToast(`Mỗi lô được nhập tối đa ${MAX_BATCH_LINKS} link`, true);
      return;
    }

    elements.batchDownloadBtn.disabled = true;
    try {
      const response = await sendRequest(
        MESSAGE.START_BATCH_DOWNLOAD,
        { links: links.map((link) => link.url) },
        20000,
      );
      if (!response?.success) {
        throw new Error(response?.message || "Không thể bắt đầu tải hàng loạt");
      }
      if (response.data?.downloadState) {
        appState.downloadState = response.data.downloadState;
      }
      showToast(response.message || `Đã đưa ${links.length} link vào hàng đợi`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      render();
    }
  });

  async function openResultsPage(triggerElement) {
    if (triggerElement.disabled) return;
    elements.scanStatusBadge.disabled = true;
    elements.viewResultsBtn.disabled = true;
    try {
      const response = await sendRequest(MESSAGE.OPEN_RESULTS_PAGE, {});
      if (!response?.success) {
        throw new Error(response?.message || "Không thể mở bảng kết quả");
      }
      if (!response.data?.panelClosed) {
        try {
          if (typeof chrome.sidePanel?.close === "function") {
            await chrome.sidePanel.close(
              Number.isInteger(response.data?.panelWindowId)
                ? { windowId: response.data.panelWindowId }
                : {},
            );
          } else {
            window.close();
          }
        } catch (_) {
          try {
            window.close();
          } catch (_) {}
        }
      }
    } catch (error) {
      showToast(error.message, true);
    } finally {
      render();
    }
  }

  elements.scanStatusBadge.addEventListener("click", () =>
    openResultsPage(elements.scanStatusBadge),
  );
  elements.viewResultsBtn.addEventListener("click", () =>
    openResultsPage(elements.viewResultsBtn),
  );

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
    loadInitialState();
  }

  if (document.documentElement.dataset.tqtLicenseAuthorized === "true") {
    startApplication();
  } else {
    window.addEventListener("tqt:license-authorized", startApplication, {
      once: true,
    });
  }
})();
