// Official model catalog: https://developers.openai.com/api/docs/models
// Verified 2026-09-13. Keep API IDs separate from display names.
export const AI_MODELS = Object.freeze([
  Object.freeze({ id: "gpt-6-astra", label: "GPT-6 Astra" }),
  Object.freeze({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }),
  Object.freeze({ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" })
]);

export const DEFAULT_AI_MODEL = "gpt-5.6-terra";
export const DEFAULT_AI_PROMPT = `Viết một tiêu đề và nội dung đăng video Facebook bằng tiếng Việt dựa trên nội dung gốc.
Tiêu đề ngắn gọn, thu hút, tự nhiên; tối đa 100 ký tự.
Nội dung gồm 2–4 câu, có câu mở đầu hấp dẫn và lời mời tương tác phù hợp. Có thể thêm tối đa 3 hashtag liên quan.
Bám sát nội dung gốc, không bịa chi tiết, không giật tít sai sự thật. Không thêm lời giải thích ngoài kết quả.`;

export const DEFAULT_AI_COMMENT_PROMPT = `Viết lại bình luận bằng tiếng Việt tự nhiên, ngắn gọn và phù hợp để đăng dưới video Facebook.
Giữ nguyên ý nghĩa, tên riêng, đường dẫn, giá và thông tin quan trọng của bình luận gốc. Không tự thêm thông tin hoặc cam kết.
Chỉ trả về nội dung bình luận đã viết lại, không kèm giải thích.`;

const API_URL = "https://api.openai.com/v1/responses";
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const MAX_SOURCE_LENGTH = 20_000;
const MAX_PROMPT_LENGTH = 12_000;

function aiError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function abortedError() {
  return aiError("ABORTED", "Đã dừng viết nội dung AI.");
}

export function validateAiConfiguration({ apiKey, model, prompt, source }) {
  if (!String(apiKey || "").trim()) return "Nhập API key OpenAI trong mục Prompt AI.";
  if (!AI_MODELS.some((item) => item.id === model)) return "Chọn model hợp lệ trong mục Prompt AI.";
  if (!String(prompt || "").trim()) return "Nhập prompt trong mục Prompt AI.";
  if (String(prompt).length > MAX_PROMPT_LENGTH) return "Prompt AI chỉ được tối đa 12.000 ký tự.";
  if (source !== undefined) {
    if (!String(source || "").trim()) return "Nhập nội dung gốc hoặc bật Dùng tên video làm nội dung.";
    if (String(source).length > MAX_SOURCE_LENGTH) return "Nội dung gốc cho AI chỉ được tối đa 20.000 ký tự.";
  }
  return null;
}

export function generateVideoContent(...args){return window.TqtSuiteClient.api('pagesAi','generateVideoContent',args);}
export function rewriteCommentContent(...args){return window.TqtSuiteClient.api('pagesAi','rewriteCommentContent',args);}
