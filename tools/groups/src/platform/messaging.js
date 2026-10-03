import { createId } from "../shared/utils.js";

const MESSAGE_TIMEOUT_MS = 30_000;
const VIDEO_TRANSFER_TIMEOUT_MS = 6 * 60_000;
const VIDEO_COMMIT_TIMEOUT_MS = 20 * 60_000;

export const MESSAGE = Object.freeze({
  REGISTER_DASHBOARD: "REGISTER_DASHBOARD",
  GET_RUNTIME_STATE: "GET_RUNTIME_STATE",
  SET_RUNTIME_STATE: "SET_RUNTIME_STATE",
  CLEAR_RUNTIME_STATE: "CLEAR_RUNTIME_STATE",
  VIDEO_POST_INIT: "VIDEO_POST_INIT",
  VIDEO_POST_CHUNK: "VIDEO_POST_CHUNK",
  VIDEO_POST_COMMIT: "VIDEO_POST_COMMIT",
  VIDEO_POST_STATUS: "VIDEO_POST_STATUS",
  VIDEO_POST_ABORT: "VIDEO_POST_ABORT",
  NATIVE_GROUP_POST_START: "NATIVE_GROUP_POST_START",
  NATIVE_GROUP_POST_STATUS: "NATIVE_GROUP_POST_STATUS",
  NATIVE_GROUP_POST_CANCEL: "NATIVE_GROUP_POST_CANCEL",
  NATIVE_GROUP_POST_CLEAR: "NATIVE_GROUP_POST_CLEAR",
  NATIVE_GROUP_POST_PROGRESS: "NATIVE_GROUP_POST_PROGRESS",
  PING: "PING"
});

function requestTimeout(type) {
  if ([MESSAGE.VIDEO_POST_INIT, MESSAGE.VIDEO_POST_CHUNK].includes(type)) {
    return VIDEO_TRANSFER_TIMEOUT_MS;
  }
  if (type === MESSAGE.VIDEO_POST_COMMIT) return VIDEO_COMMIT_TIMEOUT_MS;
  return MESSAGE_TIMEOUT_MS;
}

export function createRequest(type, payload = {}) {
  return {
    type,
    requestId: createId(),
    payload
  };
}

export function success(requestId, data = null, message = "Thành công") {
  return {
    success: true,
    code: "OK",
    message,
    data,
    requestId
  };
}

export function failure(requestId, code, message, data = null) {
  return {
    success: false,
    code,
    message,
    data,
    requestId
  };
}

export async function sendRequest(type, payload = {}) {
  const request = createRequest(type, payload);
  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error("Tiện ích không phản hồi đúng thời gian; hãy tải lại bảng điều khiển.");
      error.code = "EXTENSION_MESSAGE_TIMEOUT";
      reject(error);
    }, requestTimeout(type));

    try {
      chrome.runtime.sendMessage(request, (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        const message = chrome.runtime.lastError?.message;
        if (message) {
          const error = new Error(message);
          error.code = "EXTENSION_MESSAGE_DISCONNECTED";
          reject(error);
        } else {
          resolve(value);
        }
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(error);
    }
  });
  if (!response || response.requestId !== request.requestId) {
    throw new Error("Phản hồi từ tiện ích không hợp lệ.");
  }
  if (!response.success) {
    const error = new Error(response.message || "Yêu cầu thất bại.");
    error.code = response.code;
    error.data = response.data;
    throw error;
  }
  return response.data;
}
