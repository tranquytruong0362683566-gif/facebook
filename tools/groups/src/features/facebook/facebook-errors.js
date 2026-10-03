const ACCOUNT_GUARD_PATTERN = /checkpoint|security check|verification|verify|xác minh|bảo mật|temporarily blocked|spam|bị chặn|suspicious activity/i;
const ACTOR_CHANGED_CODES = new Set(["FACEBOOK_ACTOR_CHANGED", "VIDEO_ACTOR_CHANGED"]);
const UNCERTAIN_DELIVERY_CODES = new Set([
  "FACEBOOK_REQUEST_TIMEOUT",
  "VIDEO_REQUEST_TIMEOUT",
  "VIDEO_PUBLISH_TIMEOUT",
  "NETWORK_ERROR"
]);

function errorDetails(raw, rawText = "") {
  const freshToken = raw?.dtsgToken
    || String(rawText || "").match(/"dtsgToken"\s*:\s*"([^"]+)"/)?.[1]
    || null;
  return { freshToken };
}

function result(type, logMessage, options = {}) {
  return {
    type,
    shouldSkip: false,
    shouldRetry: false,
    shouldWarn: false,
    shouldStop: false,
    freshToken: null,
    logMessage,
    ...options
  };
}

export function classifyFacebookError(raw, rawText = "") {
  const { freshToken } = errorDetails(raw, rawText);

  if (!raw) {
    return result("PARSE_ERROR", "Không đọc được phản hồi Facebook — sẽ thử lại.", {
      shouldRetry: true,
      freshToken
    });
  }

  if (raw.error) {
    const legacyCode = Number(raw.error);
    if (legacyCode === 1357004) {
      return result(
        "TOKEN_EXPIRED",
        freshToken
          ? "Mã phiên đã hết hạn — đã nhận mã mới và sẽ thử lại."
          : "Mã phiên đã hết hạn — cần tải lại tiện ích.",
        { shouldRetry: Boolean(freshToken), shouldWarn: !freshToken, freshToken }
      );
    }
    if (legacyCode === 1357001) {
      return result(
        "ACCOUNT_CHECKPOINT",
        "Facebook yêu cầu kiểm tra tài khoản — đã dừng chiến dịch để bảo vệ tài khoản.",
        { shouldWarn: true, shouldStop: true, freshToken }
      );
    }
    return result(
      "LEGACY_ERROR",
      `Lỗi Facebook ${raw.error}: ${raw.errorSummary || "không rõ"}`,
      { shouldRetry: true, freshToken }
    );
  }

  const errors = Array.isArray(raw.errors) ? raw.errors : [];
  const error = errors.find((item) => item?.severity === "CRITICAL") || errors[0];
  if (!error && raw.data?.story_create === null) {
    return result("SILENT_FAIL", "Facebook không tạo bài nhưng không báo lỗi — sẽ thử lại.", {
      shouldRetry: true,
      freshToken
    });
  }
  if (!error) {
    return result("UNKNOWN", "Cấu trúc phản hồi Facebook không như dự kiến.", {
      shouldRetry: true,
      freshToken
    });
  }

  const code = error.extensions?.code ?? error.code;
  const numericCode = Number(code);
  const transient = error.is_transient === true || error.extensions?.is_transient === true;
  const allowRetry = error.allow_user_retry === true || error.extensions?.allow_user_retry === true;
  const description = String(
    error.description
      || error.extensions?.error_user_msg
      || error.message
      || "không có chi tiết"
  );
  const normalized = description.toLowerCase();

  if (ACTOR_CHANGED_CODES.has(String(code)) || normalized.includes("tư cách facebook đã thay đổi")) {
    return result("FACEBOOK_ACTOR_CHANGED", description, {
      shouldWarn: true,
      shouldStop: true,
      freshToken
    });
  }
  if (numericCode === 1357001 || /checkpoint|security check|xác minh tài khoản/i.test(description)) {
    return result("ACCOUNT_CHECKPOINT", description, {
      shouldWarn: true,
      shouldStop: true,
      freshToken
    });
  }
  if (numericCode === 3809006) {
    return transient || allowRetry
      ? result("TRANSIENT_ERROR", "Lỗi nhóm tạm thời (3809006) — sẽ thử lại.", {
        shouldRetry: true,
        freshToken
      })
      : result("INVALID_GROUP", "Không thể truy cập nhóm (3809006) — bỏ qua trong phiên này.", {
        shouldSkip: true,
        freshToken
      });
  }
  if (numericCode === 200) {
    return result("PERMISSION_DENIED", "Không có quyền đăng vào nhóm này (mã 200).", {
      shouldSkip: true,
      freshToken
    });
  }
  if (numericCode === 368 || numericCode === 429) {
    return result("RATE_LIMITED", "Facebook đang giới hạn tần suất — nên tăng thời gian chờ.", {
      shouldWarn: true,
      freshToken
    });
  }
  if (normalized.includes("spam") || normalized.includes("block")) {
    return result("SPAM_BLOCKED", "Phát hiện tín hiệu spam/chặn — đã dừng chiến dịch.", {
      shouldWarn: true,
      shouldStop: true,
      freshToken
    });
  }

  return result("GRAPHQL_ERROR", `Lỗi GraphQL (${code || "không rõ"}): ${description}`, {
    shouldSkip: !transient && !allowRetry,
    shouldRetry: transient || allowRetry,
    freshToken
  });
}

export function planCrosspostRetry(response) {
  if (!response || response.success || response.storyId || response.postId) return null;
  if (response.raw?.data?.story_create) return null;

  const classification = classifyFacebookError(response.raw, response.rawText);
  if (classification.type === "TOKEN_EXPIRED" && classification.freshToken) {
    return { classification, freshToken: classification.freshToken };
  }

  const explicitErrors = Array.isArray(response.raw?.errors) ? response.raw.errors : [];
  const explicitlyTransient = explicitErrors.some((item) => (
    item?.is_transient === true
    || item?.allow_user_retry === true
    || item?.extensions?.is_transient === true
    || item?.extensions?.allow_user_retry === true
  ));

  if (!explicitlyTransient || !classification.shouldRetry || classification.shouldStop) return null;
  return { classification, freshToken: null };
}

export function classifyCrosspostFailure(error) {
  const raw = error?.data?.raw || error?.raw || null;
  const rawText = error?.data?.rawText || error?.rawText || "";
  const classification = raw ? classifyFacebookError(raw, rawText) : null;
  const code = String(error?.code || classification?.type || "CROSSPOST_PUBLISH_FAILED").toUpperCase();
  const message = String(error?.message || classification?.logMessage || "Facebook không xác nhận đăng chéo.");
  const deliveryUncertain = UNCERTAIN_DELIVERY_CODES.has(code)
    || (error instanceof TypeError && /fetch|network|mạng/i.test(message));
  const accountProtected = classification?.shouldStop === true
    || ACTOR_CHANGED_CODES.has(code)
    || ["ACCOUNT_CHECKPOINT", "FACEBOOK_AUTH_REQUIRED"].includes(code)
    || ACCOUNT_GUARD_PATTERN.test(message);
  const rateLimited = classification?.type === "RATE_LIMITED"
    || ["FACEBOOK_RATE_LIMITED", "RATE_LIMITED", "368", "429"].includes(code);

  return {
    ...(classification || result(code, message)),
    type: classification?.type || code,
    shouldRetry: false,
    shouldWarn: Boolean(classification?.shouldWarn || accountProtected || rateLimited || deliveryUncertain),
    shouldStop: Boolean(accountProtected || rateLimited || deliveryUncertain),
    deliveryUncertain,
    logMessage: deliveryUncertain
      ? `${message} Trạng thái bài đăng chưa xác định; không tự gửi lại để tránh đăng trùng.`
      : message
  };
}
