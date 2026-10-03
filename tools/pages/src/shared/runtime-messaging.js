export function createRequest(type, payload = {}) {
  return {
    type,
    requestId: crypto.randomUUID(),
    payload
  };
}

export function success(requestId, data = null, message = "OK") {
  return {
    requestId,
    success: true,
    code: "OK",
    message,
    data
  };
}

export function failure(requestId, code, message, data = null) {
  return {
    requestId,
    success: false,
    code: code || "UNKNOWN_ERROR",
    message: message || "Đã xảy ra lỗi.",
    data
  };
}

export function sendRequest(type, payload = {}, timeoutMs = 15_000) {
  const request = createRequest(type, payload);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("Service worker không phản hồi đúng hạn."), {
        code: "RUNTIME_TIMEOUT"
      }));
    }, timeoutMs);

    chrome.runtime.sendMessage(request, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const runtimeMessage = chrome.runtime.lastError?.message;
      if (runtimeMessage) {
        reject(Object.assign(new Error(runtimeMessage), { code: "RUNTIME_ERROR" }));
        return;
      }
      if (!response || response.requestId !== request.requestId) {
        reject(Object.assign(new Error("Phản hồi service worker không hợp lệ."), {
          code: "INVALID_RUNTIME_RESPONSE"
        }));
        return;
      }
      if (!response.success) {
        reject(Object.assign(new Error(response.message || "Yêu cầu thất bại."), {
          code: response.code || "RUNTIME_REQUEST_FAILED",
          data: response.data ?? null
        }));
        return;
      }
      resolve(response.data);
    });
  });
}
