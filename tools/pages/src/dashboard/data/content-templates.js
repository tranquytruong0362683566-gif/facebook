import { AI_MODELS, DEFAULT_AI_MODEL, DEFAULT_AI_PROMPT, DEFAULT_AI_COMMENT_PROMPT } from "../ai/openai-content.js";
import { photoSettings } from "./posting-mode.js";
import { normalizePostingSpeed } from "./posting-speed.js";

const TEMPLATE_SETTING_KEYS = Object.freeze([
  "postContent",
  "useVideoTitleAsContent",
  "aiEnabled",
  "aiModel",
  "aiPrompt",
  "aiCommentPrompt",
  "commentAiEnabled",
  "videosPerPage",
  "randomizeVideos",
  "uploadConcurrency",
  "jobDelay",
  "commentEnabled",
  "commentText"
]);

export const CONTENT_TEMPLATE_LIMITS = Object.freeze({
  MAX_COUNT: 50,
  MAX_NAME_LENGTH: 80
});

function boundedNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeVideo(item) {
  if (!item || typeof item.id !== "string" || !item.id) return null;
  return {
    id: item.id,
    name: String(item.name || "video.mp4"),
    size: Math.max(0, Number(item.size) || 0),
    type: String(item.type || ""),
    lastModified: Number(item.lastModified) || 0,
    title: String(item.title || ""),
    caption: String(item.caption || ""),
    createdAt: String(item.createdAt || new Date().toISOString())
  };
}

function normalizeTemplateSettings(source = {}) {
  source = source && typeof source === "object" ? source : {};
  return {
    postContent: String(source.postContent || ""),
    useVideoTitleAsContent: Boolean(source.useVideoTitleAsContent),
    aiEnabled: Boolean(source.aiEnabled),
    aiModel: AI_MODELS.some((model) => model.id === source.aiModel) ? source.aiModel : DEFAULT_AI_MODEL,
    aiPrompt: typeof source.aiPrompt === "string" ? source.aiPrompt : DEFAULT_AI_PROMPT,
    aiCommentPrompt: typeof source.aiCommentPrompt === "string" ? source.aiCommentPrompt : DEFAULT_AI_COMMENT_PROMPT,
    commentAiEnabled: Boolean(source.commentAiEnabled),
    videosPerPage: Math.floor(boundedNumber(source.videosPerPage, 0, Number.MAX_SAFE_INTEGER)),
    randomizeVideos: Boolean(source.randomizeVideos),
    uploadConcurrency: normalizePostingSpeed(source.uploadConcurrency),
    jobDelay: boundedNumber(source.jobDelay, 0, 3_600),
    commentEnabled: Boolean(source.commentEnabled),
    commentText: String(source.commentText || "")
  };
}

export function normalizeTemplateName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONTENT_TEMPLATE_LIMITS.MAX_NAME_LENGTH);
}

export function snapshotContentSettings(settings) {
  const snapshot = {};
  for (const key of TEMPLATE_SETTING_KEYS) snapshot[key] = settings?.[key];
  return normalizeTemplateSettings(snapshot);
}

export function createContentTemplate({
  id = crypto.randomUUID(),
  name,
  mediaType = "video",
  videos,
  settings,
  createdAt = new Date().toISOString()
}) {
  const normalizedName = normalizeTemplateName(name);
  if (!normalizedName) throw new Error("Hãy nhập tên mẫu.");
  const normalizedVideos = Array.from(videos || [], normalizeVideo).filter(Boolean);
  return {
    id: String(id),
    name: normalizedName,
    mediaType: mediaType === "photo" ? "photo" : "video",
    videos: normalizedVideos,
    settings: snapshotContentSettings(mediaType === "photo" ? photoSettings(settings) : settings),
    createdAt: String(createdAt),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeContentTemplates(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate.id !== "string" || seen.has(candidate.id)) continue;
    const name = normalizeTemplateName(candidate.name);
    if (!name) continue;
    seen.add(candidate.id);
    normalized.push({
      id: candidate.id,
      name,
      mediaType: candidate.mediaType === "photo" ? "photo" : "video",
      videos: Array.from(
        Array.isArray(candidate.videos) ? candidate.videos : [],
        normalizeVideo
      ).filter(Boolean),
      settings: normalizeTemplateSettings(candidate.mediaType === "photo" ? photoSettings(candidate.settings) : candidate.settings),
      createdAt: String(candidate.createdAt || new Date().toISOString()),
      updatedAt: String(candidate.updatedAt || candidate.createdAt || new Date().toISOString())
    });
    if (normalized.length >= CONTENT_TEMPLATE_LIMITS.MAX_COUNT) break;
  }
  return normalized;
}

export function applyContentTemplateSettings(currentSettings, template) {
  if (template?.mediaType === "photo") {
    const source = normalizeTemplateSettings(template.settings);
    return photoSettings({
      ...currentSettings,
      postContent: source.postContent,
      commentEnabled: source.commentEnabled,
      commentText: source.commentText,
      jobDelay: source.jobDelay
    });
  }
  return {
    ...currentSettings,
    ...normalizeTemplateSettings(template?.settings)
  };
}

export function collectContentTemplateVideoIds(templates) {
  const ids = new Set();
  for (const template of templates || []) {
    for (const video of template.videos || []) {
      if (typeof video?.id === "string" && video.id) ids.add(video.id);
    }
  }
  return ids;
}
