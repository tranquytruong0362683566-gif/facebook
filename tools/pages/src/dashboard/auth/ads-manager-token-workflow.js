import { LIMITS, MESSAGE } from "../../shared/constants.js";
import { sendRequest } from "../../shared/runtime-messaging.js";
import {
  AdsManagerTokenError,
  fetchUserTokenFromAdsManager
} from "./ads-manager-token-service.js";

function abortedError() {
  return new AdsManagerTokenError("TOKEN_FLOW_CANCELLED", "Đã hủy quy trình lấy token.");
}

export class AdsManagerTokenWorkflow {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.task = null;
    this.controller = null;
    this.verificationTabId = null;
    this.retryRequested = false;
    this.wakeRetry = null;
  }

  get running() {
    return Boolean(this.task);
  }

  emit(phase, message, detail = {}) {
    this.callbacks.onState?.({
      phase,
      message,
      tabId: this.verificationTabId,
      ...detail
    });
  }

  async openVerificationTab() {
    const tab = await sendRequest(MESSAGE.OPEN_ADS_MANAGER, {
      tabId: this.verificationTabId
    });
    this.verificationTabId = Number.isInteger(tab?.tabId) ? tab.tabId : null;
    return tab;
  }

  requestRetry() {
    this.retryRequested = true;
    this.wakeRetry?.();
  }

  cancel() {
    this.controller?.abort();
  }

  acquire() {
    if (this.task) return this.task;
    this.controller = new AbortController();
    this.task = this.run(this.controller.signal)
      .finally(() => {
        this.task = null;
        this.controller = null;
        this.retryRequested = false;
        this.wakeRetry = null;
      });
    return this.task;
  }

  async pause(ms, signal) {
    if (signal.aborted) throw abortedError();
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.wakeRetry = null;
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(abortedError());
      };
      const timer = setTimeout(finish, ms);
      this.wakeRetry = finish;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async run(signal) {
    this.emit("checking", "Đang kiểm tra phiên Facebook hiện tại…");
    try {
      const token = await fetchUserTokenFromAdsManager();
      this.emit("success", "Đã lấy User Token từ phiên Facebook.");
      return token;
    } catch (error) {
      if (signal.aborted) throw abortedError();
      this.emit(
        "opening",
        "Phiên chưa sẵn sàng. Đang mở Ads Manager để xác minh…",
        { errorCode: error?.code || "TOKEN_CHECK_FAILED" }
      );
    }

    const openedTab = await this.openVerificationTab();
    if (!openedTab?.open || !this.verificationTabId) {
      throw new AdsManagerTokenError(
        "ADS_MANAGER_TAB_FAILED",
        "Không mở được Ads Manager để xác minh."
      );
    }

    const deadline = Date.now() + LIMITS.TOKEN_VERIFICATION_TIMEOUT_MS;
    let lastAttemptAt = 0;
    let lastError = null;

    this.emit(
      "verifying",
      "Hãy hoàn tất xác minh trong tab Ads Manager vừa mở. Token sẽ được lấy tự động."
    );

    while (Date.now() < deadline) {
      if (signal.aborted) throw abortedError();
      let status;
      try {
        status = await sendRequest(MESSAGE.ADS_MANAGER_STATUS, {
          tabId: this.verificationTabId
        });
      } catch (error) {
        lastError = error;
        this.emit(
          "verifying",
          "Đang khôi phục kết nối với Ads Manager; hệ thống sẽ tiếp tục tự thử lại."
        );
        await this.pause(1_000, signal);
        continue;
      }
      if (!status?.open) {
        throw new AdsManagerTokenError(
          "ADS_MANAGER_TAB_CLOSED",
          "Tab Ads Manager đã bị đóng trước khi xác minh hoàn tất."
        );
      }

      const retryDue = status.loaded
        && Date.now() - lastAttemptAt >= LIMITS.TOKEN_RETRY_MS;
      if (this.retryRequested || retryDue) {
        this.retryRequested = false;
        lastAttemptAt = Date.now();
        this.emit("retrying", "Đang tự lấy lại token sau khi xác minh…", {
          verificationPage: Boolean(status.verificationPage)
        });
        try {
          const token = await fetchUserTokenFromAdsManager();
          this.emit("success", "Xác minh hoàn tất, đã lấy User Token thành công.");
          sendRequest(MESSAGE.OPEN_DASHBOARD).catch(() => {});
          return token;
        } catch (error) {
          lastError = error;
          this.emit(
            "verifying",
            status.verificationPage
              ? "Facebook vẫn đang chờ xác minh. Hoàn tất các bước trong tab vừa mở."
              : "Chưa đọc được token; hệ thống sẽ tiếp tục tự thử lại.",
            { errorCode: error?.code || "TOKEN_RETRY_FAILED" }
          );
        }
      }

      await this.pause(1_000, signal);
    }

    throw new AdsManagerTokenError(
      "TOKEN_VERIFICATION_TIMEOUT",
      "Quá thời gian chờ xác minh Ads Manager. Hãy bấm lấy token để thử lại.",
      { cause: lastError }
    );
  }
}
