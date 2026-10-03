(function initializeLicenseAccess() {
  "use strict";

  const { MESSAGE, createMessage } = globalThis.TTProtocol;
  const gate = document.getElementById("licenseGate");
  const app = document.getElementById("tiktokApp");
  const keyInput = document.getElementById("tqtMachineKeyInput");
  const status = document.getElementById("tqtLicenseStatus");
  const copyButton = document.getElementById("copyTqtMachineKeyBtn");
  const retryButton = document.getElementById("retryTqtLicenseBtn");
  const MACHINE_KEY_PATTERN = /^TQT-[A-F0-9]{27}$/;

  function sendRequest(type, payload = {}) {
    const message = createMessage(type, payload);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(response || null);
      });
    });
  }

  function setStatus(message, state) {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state || "";
  }

  function unlockApplication() {
    document.documentElement.classList.remove("license-pending");
    document.documentElement.classList.add("license-authorized");
    document.documentElement.dataset.tqtLicenseAuthorized = "true";
    gate?.setAttribute("aria-hidden", "true");
    app?.removeAttribute("inert");
    app?.setAttribute("aria-hidden", "false");
    window.dispatchEvent(new CustomEvent("tqt:license-authorized"));
  }

  async function checkLicense(forceRefresh = false) {
    if (retryButton) retryButton.disabled = true;
    setStatus("Đang kiểm tra KEY bản quyền của thiết bị...", "checking");

    try {
      const response = await sendRequest(MESSAGE.GET_LICENSE_STATUS, {
        forceRefresh,
      });
      const data =
        response?.data && typeof response.data === "object"
          ? response.data
          : {};

      if (keyInput && data.machineKey) keyInput.value = data.machineKey;

      if (data.authorized) {
        setStatus("KEY thiết bị đã được ADMIN cấp quyền. Đang mở...", "ok");
        window.setTimeout(unlockApplication, 300);
        return;
      }

      const sourceUnavailable = data.status === "unavailable" || data.code === "TQT_LICENSE_UNAVAILABLE";
      setStatus(
        sourceUnavailable
          ? data.message || "Không kết nối được máy chủ kiểm tra KEY."
          : data.message || "KEY thiết bị chưa được ADMIN cấp quyền. Sau khi được duyệt, hãy bấm Kiểm tra lại.",
        sourceUnavailable ? "error" : "waiting",
      );
    } catch (error) {
      setStatus(`Không kiểm tra được KEY: ${error?.message || error}`, "error");
    } finally {
      if (retryButton) retryButton.disabled = false;
    }
  }

  async function copyMachineKey() {
    const value = String(keyInput?.value || "").trim().toUpperCase();
    if (!MACHINE_KEY_PATTERN.test(value)) return;

    try {
      await navigator.clipboard.writeText(value);
    } catch (_) {
      keyInput.focus();
      keyInput.select();
      document.execCommand("copy");
    }

    if (!copyButton) return;
    const originalText = copyButton.textContent;
    copyButton.textContent = "Đã Copy!";
    window.setTimeout(() => {
      copyButton.textContent = originalText;
    }, 1400);
  }

  copyButton?.addEventListener("click", copyMachineKey);
  retryButton?.addEventListener("click", () => checkLicense(true));
  checkLicense();
})();
