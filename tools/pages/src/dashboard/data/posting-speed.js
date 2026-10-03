export const POSTING_SPEED = Object.freeze({ NORMAL: "normal", FAST: "fast" });

export function normalizePostingSpeed(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  // The former single global upload slot becomes Đăng Thường.
  // Automatic and multi-slot settings become one concurrent lane per Page.
  return mode === POSTING_SPEED.NORMAL || mode === "1" ? POSTING_SPEED.NORMAL : POSTING_SPEED.FAST;
}

export function postingSpeedLabel(value) {
  return normalizePostingSpeed(value) === POSTING_SPEED.NORMAL ? "Đăng Thường" : "Đăng Nhanh";
}

export function postingSpeedHint(value) {
  return normalizePostingSpeed(value) === POSTING_SPEED.NORMAL
    ? "Đăng Thường: lần lượt từng Page, chờ lượt trước hoàn tất rồi mới đăng lượt tiếp theo."
    : "Đăng Nhanh: các Page chạy song song, mỗi Page chỉ có 1 lượt đang chạy.";
}
