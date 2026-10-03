(function initializeProtocol(globalScope) {
  "use strict";

  const MESSAGE = Object.freeze({
    GET_LICENSE_STATUS: "TT_GET_LICENSE_STATUS",
    OPEN_RESULTS_PAGE: "TT_OPEN_RESULTS_PAGE",
    GET_APP_STATE: "TT_GET_APP_STATE",
    START_SCAN: "TT_START_SCAN",
    STOP_SCAN: "TT_STOP_SCAN",
    CLEAR_RESULTS: "TT_CLEAR_RESULTS",
    SAVE_DOWNLOAD_FOLDER: "TT_SAVE_DOWNLOAD_FOLDER",
    START_DOWNLOAD: "TT_START_DOWNLOAD",
    START_BATCH_DOWNLOAD: "TT_START_BATCH_DOWNLOAD",
    PAUSE_DOWNLOAD: "TT_PAUSE_DOWNLOAD",
    RESUME_DOWNLOAD: "TT_RESUME_DOWNLOAD",
    CLEAR_DOWNLOAD_QUEUE: "TT_CLEAR_DOWNLOAD_QUEUE",

    CONTENT_PING: "TT_CONTENT_PING",
    CONTENT_START_SCAN: "TT_CONTENT_START_SCAN",
    CONTENT_STOP_SCAN: "TT_CONTENT_STOP_SCAN",
    CONTENT_GET_STATUS: "TT_CONTENT_GET_STATUS",

    SCAN_BATCH: "TT_SCAN_BATCH",
    SCAN_PROGRESS: "TT_SCAN_PROGRESS",
    SCAN_COMPLETE: "TT_SCAN_COMPLETE",
    SCAN_ERROR: "TT_SCAN_ERROR",

    APP_STATE_CHANGED: "TT_APP_STATE_CHANGED",
  });

  function createRequestId(prefix = "req") {
    if (globalScope.crypto?.randomUUID) {
      return `${prefix}-${globalScope.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function createMessage(type, payload = {}) {
    return {
      type,
      requestId: createRequestId("msg"),
      payload,
    };
  }

  function createResponse(success, code, message, data = null) {
    return { success, code, message, data };
  }

  function isRequest(message) {
    return Boolean(
      message &&
        typeof message.type === "string" &&
        typeof message.requestId === "string" &&
        message.payload &&
        typeof message.payload === "object",
    );
  }

  const protocol = Object.freeze({
    MESSAGE,
    createRequestId,
    createMessage,
    createResponse,
    isRequest,
  });

  globalScope.TTProtocol = protocol;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = protocol;
  }
})(globalThis);
