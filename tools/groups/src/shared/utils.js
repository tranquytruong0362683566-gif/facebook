export function createId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function cloneData(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function isPendingApprovalStory(storyCreate, url = "") {
  if (String(url).includes("/pending_posts/")) return true;
  const flags = [
    storyCreate?.is_pending,
    storyCreate?.is_pending_post,
    storyCreate?.pending_approval,
    storyCreate?.story?.is_pending,
    storyCreate?.story?.is_pending_post,
    storyCreate?.story?.pending_approval,
    storyCreate?.story?.is_awaiting_approval
  ];
  if (flags.some((value) => value === true)) return true;
  const statuses = [
    storyCreate?.status,
    storyCreate?.moderation_status,
    storyCreate?.publishing_status,
    storyCreate?.story?.status,
    storyCreate?.story?.moderation_status,
    storyCreate?.story?.publishing_status
  ];
  return statuses.some((value) => /^(?:PENDING|PENDING_APPROVAL|AWAITING_APPROVAL|IN_REVIEW)$/i.test(String(value || "")));
}
